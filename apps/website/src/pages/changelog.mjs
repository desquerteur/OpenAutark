import { site, release } from '../config.mjs';
import { page, pageHero, esc } from '../layout.mjs';
import { icon } from '../icons.mjs';

// Release notes come from GitHub at build time. Only the summary is shown;
// the verification details stay on GitHub.
function summary(body) {
  const blocks = body.replace(/\r/g, '').replace(/\*\*/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const keep = [];
  for (const b of blocks) {
    if (/^(#+\s*)?(Verification|Completed release verification|Local Windows packaging|Known|Limitations|Checks)/i.test(b)) break;
    keep.push(b);
    if (keep.length >= 3) break;
  }
  return keep.map((b) => {
    const lines = b.split('\n');
    const items = lines.filter((l) => /^\s*[-*]\s+/.test(l));
    const text = lines.filter((l) => !/^\s*[-*]\s+/.test(l)).join(' ');
    return `${text ? `<p>${esc(text)}</p>` : ''}${items.length ? `<ul>${items.slice(0, 8).map((l) => `<li>${esc(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>` : ''}`;
  }).join('');
}

const titleOf = (r) => (r.name || r.tag).replace(/^(Workforce|Autark)\s*[\d.]+\s*([-–—]\s*)?/, '') || `Version ${r.version}`;
const mb = (n) => `${Math.round(n / 1e6)} MB`;

export default function changelog(rel) {
  const list = rel.history || [];
  return page({
    slug: 'changelog',
    rel,
    title: 'Changelog',
    description: `Every public release of ${site.name} (formerly Proactive Agent Workforce): versions, dates, what changed and the download files. Current version ${rel.windows.version}.`,
    body: (root) => `
${pageHero({ root, crumb: 'Changelog', title: 'Every release, <em>in the open.</em>', lead: `${site.name} ships often. Each release lists what changed and how it was checked; the full verification notes live on GitHub. Older notes describe those versions: some of what they name, such as the guardian and the permission modes, has been removed since. Earlier releases carry the working name Workforce.`, actions: `<a class="btn btn--ghost btn--lg" href="${release.releasesUrl}" rel="noopener">${icon('github')}All releases on GitHub</a><a class="btn btn--ghost btn--lg" href="${root}changelog/feed.xml">RSS feed</a>` })}
<section class="section section--tight">
  <div class="wrap">
    ${list.length ? list.map((r, i) => `
    <article class="release" id="${esc(r.tag)}">
      <div class="release__v">${esc(r.version)}${i === 0 ? ' <span class="pill pill--available" style="vertical-align:middle">Latest</span>' : ''}<small>${esc(r.date)}</small></div>
      <div class="release__body">
        <h2 class="h4">${esc(titleOf(r))}</h2>
        <div class="prose" style="font-size:15.5px">${summary(r.notes || '')}</div>
        <div class="release__files">${r.assets.filter((a) => !/blockmap/.test(a.name)).map((a) => `<a href="${esc(a.url)}" rel="nofollow">${esc(a.name)}${/\.txt$/.test(a.name) ? '' : ` · ${mb(a.size)}`}</a>`).join('')}<a href="${esc(r.url)}" rel="noopener">Full notes →</a></div>
      </div>
    </article>`).join('') : `<p class="lead">The release list could not be loaded while this page was built. <a href="${release.releasesUrl}" rel="noopener">See every release on GitHub</a>.</p>`}
  </div>
</section>`,
  });
}

export function extra(rel) {
  const list = (rel.history || []).slice(0, 20);
  const x = (s) => esc(s);
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${x(site.name)} releases</title>
<link>${site.url}/changelog/</link>
<atom:link href="${site.url}/changelog/feed.xml" rel="self" type="application/rss+xml"/>
<description>New versions of ${x(site.name)}, your own AI company on your own computer.</description>
<language>en</language>
${list.map((r) => `<item><title>${x(`${site.name} ${r.version}: ${titleOf(r)}`)}</title><link>${x(r.url)}</link><guid isPermaLink="false">${x(r.tag)}</guid><pubDate>${new Date(`${r.date}T12:00:00Z`).toUTCString()}</pubDate><description>${x((r.notes || '').split(/\n\s*\n/)[0] || '')}</description></item>`).join('\n')}
</channel>
</rss>
`;
  return { 'changelog/feed.xml': feed };
}
