// Owns: /product/, every capability grouped by area. A capability carries a label only while it is
// not in the current release (no label = in the release).
// Never: feature facts of its own (data/features.mjs).
import { site } from '../config.mjs';
import { page, pageHero, statusPill, esc, downloadButton } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { groups, allFeatures, STATUS } from '../data/features.mjs';

export default function product(rel) {
  const count = (s) => allFeatures.filter((f) => f.status === s).length;
  const label = (f) => (f.status === 'available' ? '' : statusPill(f.status));
  const unreleased = ['next', 'planned'].filter((s) => count(s));
  return page({
    slug: 'product',
    rel,
    title: 'All capabilities',
    description: `Every capability of ${site.name}, the desktop app that runs your own AI company: agents, chats, tasks, wake-ups, engines, open files, apps, email, browser, memory, voice, phone, access. Each with its honest status.`,
    ld: [{
      '@type': 'ItemList', name: `${site.name} capabilities`, numberOfItems: allFeatures.length,
      itemListElement: allFeatures.map((f, i) => ({ '@type': 'ListItem', position: i + 1, name: f.title, description: `${f.text} Status: ${STATUS[f.status].long}.`, url: `${site.url}/product/#${f.id}` })),
    }],
    body: (root) => `
${pageHero({
  root, crumb: 'Product',
  title: `Everything your <em>AI company</em> can do.`,
  lead: `${allFeatures.length} capabilities in ${groups.length} areas. ${count('available')} are in today’s public release${count('next') ? `, ${count('next')} are built and ship with the next release` : ''}${count('planned') ? `, ${count('planned')} are planned` : ''}. Nothing here is a mock-up.`,
  actions: `${downloadButton(root)}<a class="btn btn--ghost btn--lg" href="${root}how-it-works/">How it works${icon('arrow', 'ic--move')}</a>`,
})}
<section class="section">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="Areas">
      <b>Areas</b>
      ${groups.map((g) => `<a href="#${g.id}">${esc(g.title)}</a>`).join('')}
    </nav>
    <div>
      <div class="callout" style="margin-bottom:48px">${icon('spark')}<div>${unreleased.length ? `<strong>How to read the labels.</strong> No label: in the current public release (${rel.windows.version}).${unreleased.map((s) => ` ${statusPill(s)} ${STATUS[s].long.toLowerCase()}.`).join('')}` : `<strong>Everything here is in the current public release (${rel.windows.version}).</strong>`} Where a system differs, the text says so. What is not proven yet is on the <a href="${root}access/#limits">access page</a>.</div></div>
      ${groups.map((g, gi) => `
      <section class="fgroup" id="${g.id}" aria-labelledby="${g.id}-h">
        <div class="fgroup__head">
          <span class="eyebrow"><span class="eyebrow__n">${String(gi + 1).padStart(2, '0')}</span> ${g.items.length} capabilities</span>
          <h2 class="h3" id="${g.id}-h" style="font-size:clamp(30px,3vw,44px)">${esc(g.title)}</h2>
          <p class="body">${esc(g.lead)}</p>
        </div>
        <div class="flist">
          ${g.items.map((f) => `<article class="fitem" id="${f.id}"><div class="fitem__top">${icon(f.icon)}${label(f)}</div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></article>`).join('')}
        </div>
      </section>`).join('')}
    </div>
  </div>
</section>
<section class="section section--paper2">
  <div class="wrap grid" style="row-gap:32px;align-items:end">
    <div class="col-7"><h2 class="h2">Ready when <em>you are.</em></h2><p class="lead" style="margin-top:20px">Free download for Windows, macOS and Linux, with an Android app and an iPhone web app. No account. Bring a ChatGPT plan, a paid Claude plan, an API key or a local model.</p></div>
    <div class="col-5"><div class="btns">${downloadButton(root)}<a class="btn btn--ghost btn--lg" href="${root}faq/">Questions</a></div></div>
  </div>
</section>`,
  });
}
