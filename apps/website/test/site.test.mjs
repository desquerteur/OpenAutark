// Owns: fast checks of the site's sources: base path from SITE_URL, platform order, file links on OpenAutark, the
// per-platform pages, a home page without status chips or umbrella links, the iPhone web app (/app/) – and one offline
// build (OFFLINE=1 into dist/) for the app's files and its hosting headers.
// Never: network or a browser (scripts/qa.mjs does the browser pass). Run: node --test apps/website/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { site, release, platforms, platformKinds, downloads, legacyFileLinks, maker, appUrl, appOriginProblem } = await import('../src/config.mjs');
const { BASE } = await import('../src/layout.mjs');
const APP_BASE = new URL(`${appUrl}/`).pathname;
const { platformPages } = await import('../src/platform.mjs');
const home = (await import('../src/pages/home.mjs')).default;
const download = (await import('../src/pages/download.mjs')).default;

const rel = { ...structuredClone(release.fallback), history: [] };
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('base path follows SITE_URL: /autark/ by default, / for an own domain', () => {
  if (!process.env.SITE_URL) assert.equal(BASE, '/autark/');
  const probe = `import('${pathToFileURL(join(root, 'src/layout.mjs')).href}').then((m) => process.stdout.write(m.BASE + ' ' + m.abs('download')))`;
  const run = (url) => execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, SITE_URL: url } }).toString();
  assert.equal(run('https://autark.example.com/'), '/ https://autark.example.com/download/');
  assert.equal(run('https://host.example/sub/autark'), '/sub/autark/ https://host.example/sub/autark/download/');
});

test('platforms: PC first (Windows, macOS, Linux), then phone (Android, iPhone)', () => {
  assert.deepEqual(platforms.map((p) => p.id), ['windows', 'mac', 'linux', 'android', 'iphone']);
  assert.deepEqual(platformKinds.map((k) => k.id), ['pc', 'phone']);
  assert.equal(platforms.find((p) => p.id === 'iphone').file, null);
});

test('file links live on OpenAutark under /get/, the old checksums link keeps answering', () => {
  assert.equal(release.repo, 'teydra/OpenAutark');
  const byId = Object.fromEntries(downloads.map((d) => [d.id, d]));
  for (const id of ['windows', 'mac', 'mac-zip', 'linux', 'android', 'checksums']) assert.equal(byId[id].path, `get/${id}`);
  assert.equal(release.asset(byId.android.file), 'https://github.com/teydra/OpenAutark/releases/latest/download/autark-android.apk');
  assert.deepEqual(legacyFileLinks, [{ path: 'download/checksums', id: 'checksums' }]);
  assert.ok(release.historyApis.some((u) => u.includes('proactive-agent-workforce-releases')), 'old releases stay in the changelog');
});

test('one page per platform with a canonical address, one h1, a big button and valid structured data', () => {
  const pages = platformPages(rel);
  assert.equal(pages.length, 5);
  for (const { slug, html } of pages) {
    const p = platforms.find((x) => `download/${x.id}` === slug);
    assert.ok(html.includes(`<link rel="canonical" href="${site.url}/${slug}/">`), slug);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, slug);
    if (p.file) assert.ok(html.includes(`href="${release.asset(p.file)}"`), `${slug} button`);
    else assert.ok(!html.includes('.apk"') && html.includes('href="#steps"'), 'iPhone has no file, only the way to set it up');
    const graph = ldOf(html).flatMap((g) => g['@graph']);
    assert.ok(graph.some((n) => n['@type'] === 'HowTo' && n.step.length >= 2), `${slug} HowTo`);
    assert.ok(graph.some((n) => n['@type'] === 'WebPage' && n.breadcrumb.itemListElement.length === 3), `${slug} breadcrumb`);
  }
});

test('home: downloads right after the hero, no status chips or board, no umbrella links', () => {
  const html = home(rel);
  const hero = html.indexOf('id="top"'); const get = html.indexOf('id="get"'); const org = html.indexOf('aria-label="Your company at work"');
  assert.ok(hero < get && get < org, 'downloads block sits between hero and the first story section');
  for (const p of platforms) assert.ok(html.includes(`download/${p.id}/`), p.id);
  assert.ok(!html.includes('pill--available') && !html.includes('id="status"') && !html.includes('· working'));
  assert.ok(!html.includes(`href="${maker.umbrellaUrl}"`) && !html.includes(`href="${maker.telecodingUrl}"`) && !html.includes(maker.umbrella));
});

test('/pair/ stays out of search, keeps the typed ID and offers the Android app with the Android page as fallback', async () => {
  const html = (await import('../src/pages/pair.mjs')).default(rel);
  assert.ok(html.includes('noindex') && html.includes('data-pair-id') && html.includes('data-pair-copy'));
  assert.ok(html.includes('data-package="com.teydralab.autark.android"') && html.includes(`data-fallback="${site.url}/download/android/"`));
});

test('iPhone page: the web app at /app/, Add to Home Screen, Remote ID and code, iOS 17, and the honest phone-use note', () => {
  const html = platformPages(rel).find((p) => p.slug === 'download/iphone').html;
  assert.ok(html.includes(`href="${appUrl}/"`) && html.includes('Add to Home Screen') && html.includes('Remote ID') && html.includes('iOS 17'));
  assert.ok(!html.includes(`href="${site.url}/app/"`), 'never the site\'s own origin');
  assert.ok(html.includes('cannot use other iPhone apps'));
  assert.ok(!html.includes('sets the web app up') && !html.includes('Tailscale'), 'no PC-served web app any more');
});

test('the iPhone app: its own noindex document for the Home Screen, the manifest scoped to it, #app and the shell with SRI', async () => {
  const mod = await import('../src/pages/app.mjs');
  const html = mod.default(rel);
  assert.ok(html.includes('noindex') && html.includes('apple-mobile-web-app-capable') && html.includes('<div id="app"></div>'));
  assert.ok(html.includes(`<link rel="manifest" href="${APP_BASE}app.webmanifest">`));
  assert.match(html, new RegExp(`<script type="module" src="${APP_BASE}shell\\.js"( integrity="sha384-[A-Za-z0-9+/=]+")?></script>`));
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline script (the CSP allows none)');
  const manifest = JSON.parse(mod.extra()['app.webmanifest']);
  assert.equal(manifest.scope, APP_BASE);
  assert.equal(manifest.start_url, APP_BASE);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, manifest.background_color, 'one colour for the splash and the bar');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(!/(^|\})\s*(html|body|:root)[^{]*\{[^}]*(background|color:|font)/.test(style), 'the shell colours only .hs: the PC UI\'s theme owns the page');
  assert.ok(/\.hs\{[^}]*overflow-y:auto/.test(style) && /\.hs-card\{[^}]*margin:auto/.test(style), 'a short screen scrolls the card instead of clipping it');
});

test('the iPhone app has an origin of its own: never the site\'s host or Meta Jarvis, outside the base path', () => {
  assert.equal(appOriginProblem(appUrl), undefined);
  assert.notEqual(new URL(appUrl).host, new URL(site.url).host);
  assert.match(appOriginProblem('https://metajarvis.teydralab.com/app', 'https://autark.example.com'), /cannot share/);
  assert.match(appOriginProblem(`${new URL(site.url).origin}/app`), /cannot share/);
  assert.match(appOriginProblem('https://app.example.com'), /folder of its own/);
  assert.match(appOriginProblem('https://other.example/autark/app', 'https://other2.example/autark'), /outside the site's base path/);
  assert.match(appOriginProblem('http://app.example.com/app'), /https/);
  const failed = (() => { try { execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, env: { ...process.env, OFFLINE: '1', APP_URL: 'https://metajarvis.teydralab.com/autark/app' }, stdio: 'pipe' }); return ''; } catch (error) { return String(error.stderr); } })();
  assert.match(failed, /cannot share/, 'the build refuses the shared origin');
});

test('/pair/ on an iPhone points to the Home Screen app (Safari keeps separate storage)', async () => {
  const html = (await import('../src/pages/pair.mjs')).default(rel);
  assert.ok(html.includes('data-pair-ios') && html.includes('open Autark from your Home Screen'.replace('Autark', site.name)) && html.includes(`href="${appUrl}/"`));
});

test('the build ships the app with its shell, worker and icons; the app path allows camera and microphone, the rest of the site does not', () => {
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, env: { ...process.env, OFFLINE: '1' }, stdio: 'pipe' });
  const dir = join(root, 'dist', ...APP_BASE.split('/').filter(Boolean));
  for (const file of ['index.html', 'shell.js', 'sw.js', 'app.webmanifest', 'app-icon.png', 'app-icon-512.png']) assert.ok(existsSync(join(dir, file)), file);
  assert.match(readFileSync(join(dir, 'shell.js'), 'utf8'), /^\/\/ autark-hosted-src: [0-9a-f]{32}/, 'the generated shell from apps/desktop');
  const old = join(root, 'dist', ...BASE.split('/').filter(Boolean), 'app');
  assert.ok(!existsSync(join(old, 'shell.js')) && readFileSync(join(old, 'index.html'), 'utf8').includes(`url=${appUrl}/`), 'the site\'s old /app/ only forwards');
  const vercel = JSON.parse(readFileSync(join(root, 'dist', 'vercel.json'), 'utf8'));
  const app = vercel.headers.find((h) => h.source === `${APP_BASE}(.*)`);
  const policy = (h) => h.headers.find((x) => x.key === 'Permissions-Policy')?.value;
  assert.equal(policy(app), 'camera=(self), microphone=(self), geolocation=()');
  const csp = app.headers.find((x) => x.key === 'Content-Security-Policy').value;
  assert.ok(csp.includes("script-src 'self'") && csp.includes("connect-src 'self' wss:") && csp.includes("base-uri 'none'"));
  const rest = vercel.headers.find((h) => policy(h) === 'camera=(), microphone=(), geolocation=()');
  assert.ok(rest && new RegExp(`^${rest.source}$`).test(`${BASE}download/`) && !new RegExp(`^${rest.source}$`).test(`${APP_BASE}shell.js`));
  assert.ok(vercel.headers.some((h) => h.source.startsWith(`${APP_BASE}(`) && h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-cache')));
  assert.ok(!readFileSync(join(root, 'dist', ...BASE.split('/').filter(Boolean), 'sitemap.xml'), 'utf8').includes('/app/'));
});

test('download overview lists every platform page', () => {
  const html = download(rel);
  for (const p of platforms) assert.ok(html.includes(`download/${p.id}/`), p.id);
  assert.ok(!html.includes('pill--available'));
});
