// Owns: one page per platform at /download/<id>/ (Windows, macOS, Linux, Android, iPhone): a big button,
// the facts of the file, the install steps and the way back to the other platforms.
// Never: install wording (data/install.mjs) or file names and versions (config.mjs, release facts).
import { site, release, platforms, appUrl } from './config.mjs';
import { page, pageHero, esc, platformRows } from './layout.mjs';
import { icon } from './icons.mjs';
import { installSteps } from './data/install.mjs';

const { files } = release;
// The plain text of each <li> of an install step list, for the HowTo structured data.
const stepTexts = (html) => [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim());

// What differs per platform. `needs` is one sentence each; `check` is the hash command for the downloaded file.
const facts = {
  windows: {
    title: `Download ${site.name} for Windows`,
    h1: `${site.name} for <em>Windows.</em>`,
    lead: 'The installer for Windows 10 and 11, 64-bit. Free, no account, no admin rights.',
    needs: ['Windows 10 or 11, 64-bit (x64). Developed and tested most on Windows 11.', 'At least one AI: a ChatGPT plan, a paid Claude plan, an API key or a local model.'],
    check: `Get-FileHash .\\${files.windows} -Algorithm SHA256`,
    update: 'One click on the small update icon installs the new version; the app closes and opens again by itself.',
  },
  mac: {
    title: `Download ${site.name} for macOS`,
    h1: `${site.name} for <em>macOS.</em>`,
    lead: 'One universal app for Apple silicon and Intel. Free, no account. macOS wants a few extra clicks the first time, because the app has no Apple Developer ID yet.',
    needs: ['macOS on Apple silicon or Intel.', 'At least one AI: a ChatGPT plan, a paid Claude plan, an API key or a local model.', 'Agents see your screen through screenshots; controlling mouse and keyboard is not available on macOS.'],
    check: `shasum -a 256 ${files.macDmg}`,
    update: 'The app is built to replace itself at an update where macOS allows it; that path has not run on a real Mac yet, and otherwise the update icon leads to the download.',
  },
  linux: {
    title: `Download ${site.name} for Linux`,
    h1: `${site.name} for <em>Linux.</em>`,
    lead: 'One AppImage for x64. Free, no account, nothing to install system-wide.',
    needs: ['Linux x64 with FUSE 2, a working Chromium sandbox and a running system keyring.', 'At least one AI: a ChatGPT plan, a paid Claude plan, an API key or a local model.', 'Computer control runs over AT-SPI; mouse and keyboard input work on X11 only.'],
    check: `sha256sum ${files.linux}`,
    update: 'One click on the small update icon replaces the AppImage and starts it again.',
  },
  android: {
    title: `${site.name} for Android`,
    h1: `${site.name} on <em>Android.</em>`,
    lead: `Your company in your pocket. The app joins your whole company, not one PC: the same chats, tasks and notifications as every PC you linked. Agents and data stay on your PCs.`,
    needs: ['Android 8 or newer.', `${site.name} running on at least one of your PCs. The phone finds it by its Remote ID, in any network.`],
    check: `sha256sum ${files.android}`,
    update: 'When a new version exists, the app shows Update and opens the new APK; Android installs it over the old one. Most changes need no new APK at all, because the interface comes from your PC.',
    note: 'This is a preview, signed with our own key and installed from outside the Play Store. Tell us what breaks on your phone.',
  },
  iphone: {
    title: `${site.name} on iPhone`,
    h1: `${site.name} on <em>iPhone.</em>`,
    lead: `No App Store, no Apple account: ${site.name} for iPhone is a web app you add to the Home Screen. It connects to your PC by its Remote ID, in any network, end to end encrypted, and shows your PC's own screens, with notifications and the microphone.`,
    needs: ['An iPhone or iPad with iOS 17 or newer, and Safari.', `${site.name} running on at least one of your PCs. The phone finds it by its Remote ID through the meeting server, in any network.`],
    update: 'Nothing to update on the iPhone: the screens come from your PC, so the app always shows the version your PC runs.',
    note: `Agents cannot use other iPhone apps for you: iOS offers no way for any third-party app to do that. Chats, tasks, notifications and the microphone work. The app is new: tell us what breaks on your iPhone.`,
  },
};

function bigButton(p, rel) {
  if (!p.file) return `<a class="btn btn--ink btn--lg" href="${appUrl}/" data-app-link>${icon('phone')}<span>Open the iPhone app</span></a><a class="btn btn--ghost btn--lg" href="#steps">${icon('arrowDown')}<span>How to add it</span></a>`;
  const v = rel[p.id];
  const meta = v ? `<span class="btn__meta"${p.id === 'windows' ? ' data-rel="windows-meta"' : ''}>v${esc(v.version)} · ${v.sizeMb} MB</span>` : '';
  return `<a class="btn btn--ink btn--lg plat-hero__btn" href="${release.asset(p.file)}" data-dl="${p.id}" rel="nofollow">${icon(p.icon)}<span>Download for ${p.short || p.os}</span>${meta}</a>${p.alt ? `<a class="btn btn--ghost btn--lg" href="${release.asset(p.alt.file)}" rel="nofollow">${p.alt.label}</a>` : ''}`;
}

function fileFacts(p, rel) {
  if (!p.file) return '';
  const v = rel[p.id] || {};
  return `<dl class="plat-facts" data-reveal style="--d:3">
    <div><dt>Version</dt><dd>${esc(v.version || 'latest')}</dd></div>
    <div><dt>Released</dt><dd>${esc(v.date || '–')}</dd></div>
    <div><dt>Size</dt><dd>${v.sizeMb ? `about ${v.sizeMb} MB` : '–'}</dd></div>
    <div><dt>File</dt><dd><code>${esc(p.file)}</code></dd></div>
  </dl>`;
}

function platformPage(p, rel) {
  const f = facts[p.id];
  const steps = installSteps[p.id]();
  const slug = `download/${p.id}`;
  const v = rel[p.id];
  const description = p.file
    ? `${f.title}${v ? ` ${v.version}` : ''}: ${p.detail}${v?.sizeMb ? `, about ${v.sizeMb} MB` : ''}. Free, no account. The install steps you will see, what you need, and how to check the file.`
    : `${site.name} on iPhone without the App Store: a web app on the Home Screen that connects to your PC by its Remote ID and shows your PC's own screens. What works, how to add it, and what iOS does not allow.`;
  const ld = [{
    '@type': 'HowTo', name: p.file ? `How to install ${site.name} on ${p.os}` : `How to use ${site.name} on an iPhone`, totalTime: 'PT5M',
    step: stepTexts(steps).map((text, i) => ({ '@type': 'HowToStep', position: i + 1, text })),
  }];
  if (p.file) ld.push({ '@type': 'SoftwareApplication', '@id': `${site.url}/${slug}/#app`, name: `${site.name} for ${p.os}`, operatingSystem: p.os, applicationCategory: 'BusinessApplication', downloadUrl: release.asset(p.file), ...(v ? { softwareVersion: v.version, fileSize: `${v.sizeMb} MB` } : {}), isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }, isPartOf: { '@id': `${site.url}/#software` } });

  return page({
    slug, rel, title: f.title, description, ld, trail: [['Download', 'download']],
    body: (root) => `
${pageHero({ root, crumb: p.os, trail: [['Download', 'download']], title: f.h1, lead: f.lead, actions: bigButton(p, rel) })}
<section class="section section--tight">
  <div class="wrap">
    ${fileFacts(p, rel)}
    <div class="layout-doc" style="margin-top:clamp(40px,6vw,72px)">
      <nav class="toc" aria-label="On this page"><b>On this page</b><a href="#needs">What you need</a><a href="#steps">${p.file ? 'Install' : 'Set it up'}</a>${f.check ? '<a href="#verify">Check the file</a>' : ''}<a href="#updates">Updates</a><a href="#other">Other devices</a></nav>
      <div class="prose">
        <h2 id="needs">What you need</h2>
        <ul>${f.needs.map((n) => `<li>${n}</li>`).join('')}</ul>
        <h2 id="steps">${p.file ? `Install on ${p.os}` : 'Set it up'}</h2>
        ${steps}
        ${f.note ? `<div class="callout">${icon('spark')}<div>${f.note}</div></div>` : ''}
        ${f.check ? `<h2 id="verify">Check the file</h2>
        <p>Every release publishes <a href="${release.asset('SHA256SUMS.txt')}" rel="nofollow">SHA256SUMS.txt</a>. The hash of your download must match the line for <code>${esc(p.file)}</code>:</p>
        <p><code>${esc(f.check)}</code> <button class="btn btn--sm btn--ghost" type="button" data-copy="${esc(f.check)}" style="margin-left:8px;vertical-align:middle">Copy</button></p>` : ''}
        <h2 id="updates">Updates</h2>
        <p>${f.update}</p>
        <p class="small muted">This link always serves the newest public release. <a href="${release.releasesUrl}" rel="noopener">All releases on GitHub</a> · <a href="${root}changelog/">Changelog</a> · <a href="${root}download/">All downloads</a></p>
      </div>
    </div>
  </div>
</section>
<section class="section section--paper2 section--tight" id="other" aria-labelledby="other-h">
  <div class="wrap">
    <h2 class="h3" id="other-h" style="margin-bottom:28px">Your other <em>devices.</em></h2>
    ${platformRows(root, p.id)}
  </div>
</section>`,
  });
}

// One page per platform; build.mjs writes them and lists them in the sitemap.
export const platformPages = (rel) => platforms.map((p) => ({ slug: `download/${p.id}`, html: platformPage(p, rel) }));
