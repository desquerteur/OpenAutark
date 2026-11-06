// Owns: building the static site into dist/ (pages, platform pages, file redirects, crawler files, hosting config).
// Never: page copy (src/pages, src/data) or names and links (src/config.mjs). No dependencies: `node build.mjs`.
// Set SITE_URL to build for another address (base '/autark/' or '/'), APP_URL for the iPhone app's own origin (it refuses
// the site's or Meta Jarvis's host), OFFLINE=1 to skip the release check.
import { mkdir, rm, writeFile, readFile, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { site, release, downloads, legacyFileLinks, movedPages, unlisted, platforms, maker, appUrl, appOriginProblem } from './src/config.mjs';
import { groups, allFeatures, STATUS } from './src/data/features.mjs';
import { faq } from './src/data/faq.mjs';
import { MARK_PATH, MARK_DOT } from './src/icons.mjs';
import { brandFiles } from './src/brand.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const write = async (p, data) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); };
// The site sits in dist/<base path>/ (e.g. dist/autark/), so it has the same
// paths on its own Vercel address as behind the Meta Jarvis rewrite.
const BASE = new URL(`${site.url}/`).pathname; // '/autark/' or '/'
const sub = BASE.split('/').filter(Boolean).join('/');
const siteDir = join(dist, sub);
const out = (rel, data) => write(join(siteDir, rel), data);
const outRoot = (rel, data) => write(join(dist, rel), data);
// The iPhone web app sits in dist/<its folder>/ (e.g. dist/app/), outside the base path, on its own origin (config.mjs).
const appProblem = appOriginProblem(appUrl);
if (appProblem) { console.error(`APP_URL ${appUrl}: ${appProblem}`); process.exit(1); }
const APP_BASE = new URL(`${appUrl}/`).pathname; // '/app/'
const appDir = join(dist, ...APP_BASE.split('/').filter(Boolean));
const outApp = (rel, data) => write(join(appDir, rel), data);

// ── 1. current release facts ──
async function fetchText(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'autark-site-build' } }); return r.ok ? await r.text() : null; } catch { return null; } finally { clearTimeout(t); }
}
async function releaseFacts() {
  const rel = structuredClone(release.fallback);
  rel.history = [];
  if (process.env.OFFLINE) return rel;
  // The changelog spans every channel (OpenAutark and the old repo); a tag published to both appears once.
  const seen = new Set();
  for (const [i, api] of release.historyApis.entries()) {
    const list = await fetchText(`${api}?per_page=30`);
    if (!list) continue;
    try {
      const j = JSON.parse(list).filter((r) => !r.draft && !r.prerelease);
      for (const r of j) {
        if (seen.has(r.tag_name)) continue;
        seen.add(r.tag_name);
        rel.history.push({
          tag: r.tag_name, name: r.name, version: r.tag_name.replace(/^v/, ''), date: vienna(r.published_at), url: r.html_url,
          notes: (r.body || '').trim(),
          assets: r.assets.filter((a) => /\.(exe|dmg|zip|AppImage|apk|txt)$/.test(a.name)).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
        });
      }
      const latest = i === 0 ? j[0] : null; // the current channel alone decides what "latest" is
      if (latest) {
        const size = (name) => latest.assets.find((a) => a.name === name)?.size;
        const exe = size(release.files.windows); const apk = size(release.files.android);
        rel.windows = { version: latest.tag_name.replace(/^v/, ''), date: vienna(latest.published_at), sizeMb: exe ? Math.round(exe / 1e6) : rel.windows.sizeMb };
        if (apk) rel.android = { ...rel.android, date: vienna(latest.published_at), sizeMb: Math.max(1, Math.round(apk / 1e6)) };
      }
    } catch { /* keep fallback */ }
  }
  rel.history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  // The phone app's own version (apps/android) sits in latest-android.json next to the APK.
  try {
    const a = JSON.parse((await fetchText(release.asset('latest-android.json'))) || 'null');
    const v = a && (a.versionName || a.version);
    if (v) rel.android = { ...rel.android, version: String(v).replace(/-preview$/, ' preview') };
  } catch { /* keep fallback */ }
  for (const [os, file, asset] of [['mac', 'latest-mac.yml', release.files.macDmg], ['linux', 'latest-linux.yml', release.files.linux]]) {
    const y = await fetchText(release.asset(file));
    const v = y?.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    const d = y?.match(/^releaseDate:\s*'?([\d-]{10})/m)?.[1];
    const size = y?.match(new RegExp(`url:\\s*${asset.replace(/\./g, '\\.')}[\\s\\S]*?size:\\s*(\\d+)`))?.[1];
    if (v) rel[os] = { version: v, date: d || rel[os].date, sizeMb: size ? Math.round(Number(size) / 1e6) : rel[os].sizeMb };
  }
  return rel;
}

// ── 2. build ──
const vienna = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Vienna' });
const rel = await releaseFacts();
console.log('release', rel.windows, rel.mac, rel.linux, `${rel.history.length} releases`);
// Empty dist/ but keep .vercel (the link to the Vercel project).
await mkdir(dist, { recursive: true });
for (const e of await readdir(dist)) if (e !== '.vercel') await rm(join(dist, e), { recursive: true, force: true });
if (existsSync(join(root, 'public'))) await cp(join(root, 'public'), siteDir, { recursive: true });

const fontsCss = (await readFile(join(root, 'src/assets/fonts.css'), 'utf8')).replaceAll('url(./fonts/', 'url(../fonts/');
// The stylesheet is split by area; joined in this order (the cascade) it is still one request.
const cssParts = await Promise.all(['styles', 'home', 'downloads', 'pages'].map((n) => readFile(join(root, `src/assets/${n}.css`), 'utf8')));
await out('assets/site.css', fontsCss + cssParts.join('\n'));
await out('assets/site.js', await readFile(join(root, 'src/assets/site.js'), 'utf8'));

const pageFiles = (await readdir(join(root, 'src/pages'))).filter((f) => f.endsWith('.mjs'));
const built = []; // every page written, in sitemap order (unlisted ones are left out of the sitemap)
for (const f of pageFiles) {
  if (f === 'app.mjs') continue; // the iPhone web app goes to its own folder below
  const mod = await import(pathToFileURL(join(root, 'src/pages', f)).href);
  const slug = f === 'home.mjs' ? '' : f.replace(/\.mjs$/, '');
  const html = await mod.default(rel);
  if (slug === '404') await outRoot('404.html', html);
  else { await out(slug ? `${slug}/index.html` : 'index.html', html); built.push(slug); }
  // A page module can bring pages below it, such as download.mjs with /download/<platform>/.
  if (mod.subpages) for (const p of await mod.subpages(rel)) { await out(`${p.slug}/index.html`, p.html); built.push(p.slug); }
  if (mod.extra) for (const [path, data] of Object.entries(await mod.extra(rel))) await out(path, data);
}
const listed = built.filter((s) => !unlisted.includes(s));
console.log('pages', built.map((s) => `/${s}`).join(' '));

// The iPhone web app (pages/app.mjs) at appUrl: its page, manifest, icons, and the shell and service worker generated
// from apps/desktop/src/ui/hosted into src/app/ (`node scripts/build.mjs --only hosted` there; here only copied).
// The site's old /app/ address only forwards there: nothing of the app runs on the site's origin.
const appPage = await import(pathToFileURL(join(root, 'src/pages/app.mjs')).href);
await outApp('index.html', appPage.default(rel));
for (const [path, data] of Object.entries(appPage.extra(rel))) await outApp(path, data);
for (const file of ['shell.js', 'sw.js']) {
  const from = join(root, 'src/app', file);
  if (existsSync(from)) await outApp(file, await readFile(from));
  else console.warn(`app ${file} missing: build it in apps/desktop with node scripts/build.mjs --only hosted`);
}
await outApp('app-icon.png', await readFile(join(root, 'public/apple-touch-icon.png')));
await outApp('app-icon-512.png', await readFile(join(root, 'public/icon-512.png')));
if (join(siteDir, 'app') === appDir) console.warn(`the site's base path is /: ${APP_BASE} also answers on the site's host. Give the app another folder in APP_URL.`);
else await out('app/index.html', `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${site.name} on iPhone</title><meta http-equiv="refresh" content="0;url=${appUrl}/"><p>${site.name} on iPhone lives at <a href="${appUrl}/">${appUrl}/</a>.</p>`);
console.log('app', `${appUrl}/`, '→', appDir);

// ── 3. stable file links ──
// /get/<id> (and the old /download/checksums) answer with the newest file: vercel.json redirects them
// on Vercel; these small pages do the same on any other host.
const fileRedirect = (d) => {
  const target = release.asset(d.file);
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Downloading ${site.name} · ${d.os}</title><meta http-equiv="refresh" content="0;url=${target}"><link rel="canonical" href="${site.url}/download/"><p>Your download starts. If not, <a href="${target}">click here</a>.</p><script>location.replace(${JSON.stringify(target)})</script>`;
};
const byId = Object.fromEntries(downloads.map((d) => [d.id, d]));
const fileLinks = [...downloads.map((d) => ({ path: d.path, d })), ...legacyFileLinks.map((l) => ({ path: l.path, d: byId[l.id] }))];
for (const { path, d } of fileLinks) await out(`${path}/index.html`, fileRedirect(d));

// Pages that moved: a small page for any host (vercel.json redirects them too). It keeps the #section.
for (const { from, to } of movedPages) {
  const target = `${site.url}/${to}/`;
  await out(`${from}/index.html`, `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Moved · ${site.name}</title><link rel="canonical" href="${target}"><meta http-equiv="refresh" content="0;url=${target}"><p>This page moved to <a href="${target}">${target}</a>.</p><script>location.replace(${JSON.stringify(target)} + location.hash)</script>`);
}

// ── 4. icons + manifest ──
const markSvg = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg ? `<rect width="64" height="64" rx="14" fill="${bg}"/>` : ''}<path d="${MARK_PATH}" fill="${bg ? '#F2F0EB' : '#0B0B0C'}"/><circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="#FF4F00"/></svg>`;
await out('favicon.svg', markSvg('#0B0B0C'));
for (const [path, svg] of Object.entries(brandFiles())) await out(path, svg);
await out('site.webmanifest', JSON.stringify({
  name: site.name, short_name: site.name, description: site.descriptor, start_url: './', scope: './', display: 'browser',
  background_color: '#F2F0EB', theme_color: site.themeColor,
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
}, null, 2));

// ── 5. crawlers: robots, sitemap, llms.txt, llms-full.txt, facts.json ──
const today = new Date().toISOString().slice(0, 10);
const aiBots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'MistralAI-User'];
await out('robots.txt', `# ${site.name} — every page is public and may be read, indexed and quoted,\n# by search engines and by AI assistants alike. Facts for AI readers: /llms.txt\n\nUser-agent: *\nAllow: /\n\n${aiBots.map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}\n\nSitemap: ${site.url}/sitemap.xml\n`);
const prio = { '': '1.0', download: '0.9', product: '0.9', 'how-it-works': '0.8', access: '0.8', faq: '0.8', compare: '0.7', changelog: '0.6', about: '0.6', brand: '0.4' };
for (const p of platforms) prio[`download/${p.id}`] = '0.8';
await out('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map((s) => `  <url><loc>${site.url}/${s ? `${s}/` : ''}</loc><lastmod>${today}</lastmod><priority>${prio[s] || '0.5'}</priority></url>`).join('\n')}\n</urlset>\n`);

const W = rel.windows;
const statusLine = (f) => `- **${f.title}** (${STATUS[f.status].label}): ${f.text}`;
const llms = `# ${site.name}

> ${site.name} is a free desktop app that gives one person their own AI company: a manager, specialist agents and a private secretary that work proactively — they wake up on schedules, messages, tasks and events instead of waiting for a prompt. It runs on the user's own computer and uses the AI plans the user already pays for (ChatGPT plans through OpenAI Codex, paid Claude plans through Claude Code). Agents have full access to the PC: there is no permission gate, guardian model or money limit, and text steers them. Settings, skills and memory are open files the AI can change itself. An Android app and an iPhone web app join the same company. Made by ${maker.company} (${maker.location}). Formerly called "Proactive Agent Workforce".

Key facts:
- Current version: ${W.version} for Windows, macOS and Linux (released ${W.date}). Windows x64 installer, about ${W.sizeMb} MB, not code-signed. macOS universal DMG or ZIP, about ${rel.mac.sizeMb} MB, signed ad hoc and not notarized, so it needs manual steps to open. Linux x64 AppImage, about ${rel.linux.sizeMb} MB.
- Phone: Android app ${rel.android.version} (APK, about ${rel.android.sizeMb} MB, Android 8+, installed from outside the Play Store); it connects to the user's company by the PC's Remote ID in any network. iPhone: no App Store app; the web app at ${appUrl}/ (Safari, Add to Home Screen, iOS 17+) pairs by the PC's Remote ID the same way, reaches the user's PC through the meeting server end-to-end encrypted, and shows the PC's own interface. Agents cannot use other iPhone apps: iOS allows that to no app.
- Price: free download, no account, no subscription from ${maker.company}. AI usage is billed by the user's own AI providers.
- Data: local-first. Chats, tasks, memory, agents and the secrets catalog live on the user's PC. No ${site.name} server holds user data; one meeting server run by ${maker.company} helps the user's devices find each other and passes only end-to-end encrypted traffic. Prompts go to the AI providers the user connects.
- Access: agents run with the user's rights, without a sandbox and without approval prompts. The first thing the AI asks is how far it may go; that is a question, not a technical barrier. Details: ${site.url}/access/
- Secrets are used by ID (secret://...); values stay out of prompts and known values are masked in output.
- Provider sign-in only through the official CLIs; the ${site.name} app does not read, copy or forward provider tokens. An agent with full access could still open those folders.
- Status labels on this site: "Available" = in the current public release; "Next release" = built in development, not released yet; "Planned" = not built.
- Source code: public under Apache-2.0 at ${release.repoUrl}. ${site.name} is open source.

## Pages

- [Overview](${site.url}/): what ${site.name} is, downloads for every device, the problem, how it works, the open system, access.
- [All capabilities](${site.url}/product/): every feature with its honest status.
- [How it works](${site.url}/how-it-works/): the short start, the organisation, wake-ups, engines, open files, browser, memory, data.
- [Access and data](${site.url}/access/): full access to the PC, the first question, secrets by ID, data and backups, unsigned builds with the Windows and Mac steps, what is not proven yet.
- [Compare](${site.url}/compare/): ${site.name} vs. chat apps, automation tools, agent frameworks and similar agent products.
- [FAQ](${site.url}/faq/): ${faq.length} answered questions.
- [Download](${site.url}/download/): every platform, PC first, then phone; requirements, checksums, permanent links.
${platforms.map((p) => `- [${site.name} for ${p.os}](${site.url}/download/${p.id}/): ${p.detail}; ${p.file ? 'the download and the install steps' : 'how to set it up from the PC'}.`).join('\n')}
- [Changelog](${site.url}/changelog/): every public release.
- [About](${site.url}/about/): ${maker.company}, ${maker.founder}, why it exists.
- [Full facts for AI readers](${site.url}/llms-full.txt) · [Machine-readable facts](${site.url}/facts.json)

## Downloads (always the newest file)

${downloads.map((d) => `- ${d.os}: ${site.url}/${d.path} → ${release.asset(d.file)}`).join('\n')}
- All releases: ${release.releasesUrl}

## Maker

- ${maker.company}: ${maker.companyUrl}
- ${maker.founder} (founder): ${maker.founderUrl}
- Imprint: ${maker.imprintUrl} · Privacy: ${maker.privacyUrl}
`;
await out('llms.txt', llms);

const llmsFull = `${llms}
## All capabilities

${groups.map((g) => `### ${g.title}\n\n${g.lead}\n\n${g.items.map(statusLine).join('\n')}`).join('\n\n')}

## Frequently asked questions

${faq.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n')}

## Releases

${rel.history.slice(0, 12).map((r) => `- ${r.tag} (${r.date}): ${r.url}`).join('\n') || `- See ${release.releasesUrl}`}
`;
await out('llms-full.txt', llmsFull);

await out('facts.json', JSON.stringify({
  name: site.name, formerNames: ['Proactive Agent Workforce', 'Workforce'], url: `${site.url}/`, descriptor: site.descriptor,
  summary: llms.split('\n')[2].replace(/^> /, ''),
  maker: { company: maker.company, url: maker.companyUrl, founder: maker.founder, founderUrl: maker.founderUrl, location: maker.location },
  price: { app: 'free', account: 'none', aiUsage: 'billed by your own AI providers' },
  platforms: {
    windows: { ...rel.windows, page: `${site.url}/download/windows/`, status: 'current', signed: false, arch: 'x64' },
    macos: { ...rel.mac, page: `${site.url}/download/mac/`, status: 'current', signed: 'ad hoc, not notarized', arch: 'universal', computerControl: false, selfUpdate: 'built, never run on a real Mac' },
    linux: { ...rel.linux, page: `${site.url}/download/linux/`, status: 'current', arch: 'x64' },
    android: { ...rel.android, page: `${site.url}/download/android/`, status: 'preview', minAndroid: 8, store: false, connects: 'by the PC Remote ID through the meeting server, end-to-end encrypted' },
    iphone: { page: `${site.url}/download/iphone/`, app: `${appUrl}/`, status: 'web app on the Home Screen, shows the user\'s PC interface', minIos: 17, appStore: false, phoneControl: false, connects: 'by the PC Remote ID through the meeting server, end-to-end encrypted' },
  },
  repository: release.repoUrl,
  downloads: Object.fromEntries(downloads.map((d) => [d.id, { stable: `${site.url}/${d.path}`, direct: release.asset(d.file) }])),
  engines: { available: ['OpenAI Codex (ChatGPT plan)', 'Claude Code (paid Claude plan)'], early: ['API keys: OpenAI, Anthropic, Google, OpenRouter, DeepInfra, Groq, Mistral, xAI, DeepSeek, Kimi, Qwen, any server speaking a supported protocol', 'Local servers: Ollama, LM Studio, llama.cpp, vLLM', 'Plan CLIs over ACP: Gemini CLI, GitHub Copilot CLI, Kimi Code (never seen in a live run)'] },
  access: { sandbox: false, approvalPrompts: false, permissionGate: false, guardianModel: false, moneyLimit: false, firstQuestion: 'a question in the chat, not a technical barrier', stopAllAgentWork: 'this PC only, holds across a restart' },
  privacy: { dataLocation: 'user\'s own computer', vendorServersHoldData: false, meetingServer: 'run by Teydra Lab, connects devices, end-to-end encrypted, replaceable', analytics: false, appReadsProviderTokens: false },
  openSource: false,
  statusLabels: STATUS,
  capabilities: allFeatures.map(({ id, title, status, text, groupTitle }) => ({ id, group: groupTitle, title, status, text })),
  faq,
  updated: today,
}, null, 2));

// ── 6. hosting ──
// The iPhone web app's CSP (in the spirit of the desktop's APP_CSP): only this origin's scripts, the PC's UI relayed by
// the app's service worker, blob: media and frames for files and mini-apps, wss: for the meeting server.
const APP_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self' data:",
  "connect-src 'self' wss:", "frame-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
// Nothing here names another site: the file links go to the release channel, and with a sub path
// ('/autark/') the bare root of this same host leads to it. Any host that maps the base path works.
await outRoot('vercel.json', JSON.stringify({
  $schema: 'https://openapi.vercel.sh/vercel.json',
  cleanUrls: false,
  trailingSlash: true,
  redirects: fileLinks.flatMap(({ path, d }) => [
    { source: `${BASE}${path}`, destination: release.asset(d.file), permanent: false },
    { source: `${BASE}${path}/`, destination: release.asset(d.file), permanent: false },
  ]).concat(movedPages.flatMap(({ from, to }) => [
    { source: `${BASE}${from}`, destination: `${BASE}${to}/`, permanent: true },
    { source: `${BASE}${from}/`, destination: `${BASE}${to}/`, permanent: true },
  ])).concat(sub ? [{ source: '/', destination: BASE, permanent: false }] : []),
  headers: [
    { source: `${BASE}fonts/(.*)`, headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }, { key: 'Access-Control-Allow-Origin', value: '*' }] },
    { source: `${BASE}assets/(.*)`, headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' }] },
    { source: `${BASE}(llms.txt|llms-full.txt)`, headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }] },
    { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] },
    // Everywhere but the iPhone web app: no camera, microphone or location.
    { source: `/((?!${APP_BASE.slice(1)}).*)`, headers: [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }] },
    // The iPhone web app (its own folder, outside the base path): dictation and calls need the microphone and camera; a
    // strict CSP of its own (connect-src wss: for the meeting server); the shell, its worker and the page are always revalidated.
    { source: `${APP_BASE}(.*)`, headers: [
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
      { key: 'Content-Security-Policy', value: APP_CSP },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] },
    { source: `${APP_BASE}(|index.html|shell.js|sw.js|app.webmanifest)`, headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
}, null, 2));

console.log('done →', dist);
