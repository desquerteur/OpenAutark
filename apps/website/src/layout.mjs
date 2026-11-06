// Owns: the fixed frame every page shares (<head>, header, mobile menu, footer) and small shared blocks.
// Never: page content; pages only hand in their body. Internal links use BASE, taken from SITE_URL.
import { site, release, maker, pages, platforms, platformKinds } from './config.mjs';
import { icon, mark, MARK_PATH, MARK_DOT } from './icons.mjs';
import { featureById } from './data/features.mjs';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Every internal link starts from the site's own path ("/autark/" under Meta Jarvis,
// "/" on its own domain), so links work with or without a trailing slash.
export const BASE = new URL(`${site.url}/`).pathname;
export const rootOf = () => BASE;
export const abs = (slug = '') => `${site.url}/${slug ? `${slug}/` : ''}`;

// The giant word: A's are drawn as the mark (Λ + dot).
export function kword(cls = '') {
  const letters = site.name.toUpperCase().split('');
  let i = 0;
  const parts = letters.map((ch) => {
    const n = i++;
    if (ch === 'A') {
      const dotColor = n === 0 ? 'var(--signal)' : 'currentColor';
      return `<span class="kword__l kword__a" style="--i:${n}"><svg viewBox="12 12 40 38" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><path d="${MARK_PATH}" fill="currentColor"/><circle class="mark__dot" cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${dotColor}"/></svg></span>`;
    }
    return `<span class="kword__l" style="--i:${n}">${ch}</span>`;
  });
  return `<div class="kword ${cls}" aria-hidden="true">${parts.join('')}</div>`;
}

function header(slug, root) {
  const nav = pages.filter((p) => p.nav).map((p) => `<a class="nav__link" href="${root}${p.slug}/"${p.slug === slug ? ' aria-current="page"' : ''}>${p.title}</a>`).join('');
  return `
<a class="skip" href="#main">Skip to content</a>
<header class="hdr" id="hdr">
  <div class="wrap hdr__bar">
    <a class="brand" href="${root}" aria-label="${site.name} home">${mark()}<span class="brand__word">${site.name}</span><span class="brand__by">by ${maker.company}</span></a>
    <nav class="nav" aria-label="Main">${nav}</nav>
    <a class="btn btn--ink btn--sm hdr__cta" href="${root}download/" data-dl-cta>${icon('arrowDown')}<span>Download</span></a>
    <button class="menu-btn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="mnav"><span></span><span></span></button>
  </div>
</header>
<nav class="mnav" id="mnav" aria-label="Mobile">
  ${pages.filter((p) => p.slug).map((p) => `<a class="mnav__link" href="${root}${p.slug}/">${p.title}</a>`).join('')}
  <a class="btn btn--ink" href="${root}download/">${icon('arrowDown')}<span>Download</span></a>
  <p class="mnav__meta tiny muted">${maker.company}, ${maker.location}</p>
</nav>`;
}

function footer(root) {
  const col = (title, links) => `<div><h2>${title}</h2><ul>${links.map(([t, h, ext]) => `<li><a href="${h}"${ext ? ' rel="noopener"' : ''}>${t}</a></li>`).join('')}</ul></div>`;
  return `
<footer class="ftr">
  <div class="wrap">
    <div class="ftr__top">
      <div class="ftr__intro">
        <a class="brand" href="${root}">${mark('', { ink: 'var(--moon)' })}<span class="brand__word">${site.name}</span></a>
        <p>${site.descriptor}. A company of AI agents that works on its own, on the AI plans you already pay for.</p>
      </div>
      ${col('Product', [['Overview', root], ['All capabilities', `${root}product/`], ['How it works', `${root}how-it-works/`], ['Access and data', `${root}access/`], ['Compare', `${root}compare/`], ['Download', `${root}download/`], ['Changelog', `${root}changelog/`]])}
      ${col('Resources', [['FAQ', `${root}faq/`], ['Brand and press kit', `${root}brand/`], ['Releases on GitHub', release.releasesUrl, 1], ['Report a problem', maker.feedbackUrl, 1], ['llms.txt', `${root}llms.txt`], ['Facts (JSON)', `${root}facts.json`]])}
      ${col('Download', platforms.map((p) => [p.os, `${root}download/${p.id}/`]).concat([['All releases', release.releasesUrl, 1]]))}
      ${col(maker.company, [['About', `${root}about/`], [maker.company, maker.companyUrl, 1], [maker.founder, maker.founderUrl, 1], [`Book: ${maker.bookTitle}`, maker.bookUrl, 1], ...maker.social.map((s) => [s.name, s.url, 1]), ['Contact', maker.contactUrl, 1]])}
    </div>
    <div class="ftr__giant">${kword().replace('class="kword ', 'class="kword ftr__kword ')}</div>
    <div class="ftr__base">
      <span>© ${new Date().getFullYear()} ${maker.company} · ${maker.location}</span>
      <nav aria-label="Legal"><a href="${maker.imprintUrl}" rel="noopener">Imprint</a><a href="${maker.privacyUrl}" rel="noopener">Privacy</a></nav>
    </div>
  </div>
</footer>`;
}

const orgLd = {
  '@type': 'Organization', '@id': 'https://teydralab.com/#organization', name: maker.company, url: maker.companyUrl,
  logo: 'https://teydralab.com/TeydraCircleIcon.png',
  founder: { '@id': 'https://stanislaushees.com/#person' },
  sameAs: maker.social.map((s) => s.url),
};
const personLd = {
  '@type': 'Person', '@id': 'https://stanislaushees.com/#person', name: maker.founder, url: maker.founderUrl,
  jobTitle: 'Founder & Software Engineer', worksFor: { '@id': 'https://teydralab.com/#organization' },
  homeLocation: { '@type': 'Place', name: 'Salzburg, Österreich' },
  sameAs: ['https://at.linkedin.com/in/stanislaus-hees-364966432', 'https://teydralab.com/stanislaus-hees'],
};

export function softwareLd(rel) {
  const w = rel.windows;
  return {
    '@type': 'SoftwareApplication',
    '@id': `${site.url}/#software`,
    name: site.name,
    alternateName: ['Autark AI', 'Proactive Agent Workforce', 'Workforce'],
    description: `${site.name} is a free desktop app that gives one person their own AI company: a manager, specialist agents and a private secretary that work proactively on the user's own computer, through the ChatGPT and Claude plans the user already has (via OpenAI Codex and Claude Code). Agents have full access to the PC; text steers them, and settings, skills and memory are open files.`,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'AI agents',
    operatingSystem: 'Windows 10, Windows 11, macOS, Linux, Android',
    softwareVersion: w.version,
    datePublished: w.date,
    fileSize: `${w.sizeMb} MB`,
    downloadUrl: `${site.url}/download/windows/`,
    installUrl: `${site.url}/download/`,
    releaseNotes: `${site.url}/changelog/`,
    url: `${site.url}/`,
    image: `${site.url}/img/og.png`,
    screenshot: `${site.url}/img/og.png`,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
    publisher: { '@id': 'https://teydralab.com/#organization' },
    creator: { '@id': 'https://stanislaushees.com/#person' },
    featureList: [
      'AI company per person: manager, specialist agents, private secretary',
      'Proactive agents that wake on schedules, messages, tasks and events',
      'Runs on existing ChatGPT plans (OpenAI Codex) and paid Claude plans (Claude Code)',
      'Chats, group chats, one task inbox (Work), My day, Team',
      'Full access to the PC: no sandbox and no approval prompts; the first question is how far the AI may go',
      'Open files: settings, skills and memory are plain files the person and the AI can change',
      'Connected apps via MCP, any REST API, email over IMAP/SMTP; the AI can build its own connections',
      'Secrets catalog: agents use IDs, values stay out of prompts',
      'Local-first: all data on the user\'s own PC, no vendor account',
      'An Android app and an iPhone web app that join the whole company, not one PC; several PCs as one',
      'Browser per chat and per agent (next release), computer use on Windows and Linux',
    ],
  };
}

// `trail`: the pages between home and this one, as [name, slug] (e.g. [['Download', 'download']]).
// `noindex`: built for people who follow a link (a QR code, an old address), not for search results.
export function page({ slug = '', title, description, body, ld = [], heroDark = false, ogImage = 'img/og.png', rel, trail = [], noindex = false }) {
  const root = rootOf(slug);
  const url = abs(slug);
  const fullTitle = slug ? `${title} · ${site.name}` : title;
  const chain = [[site.name, ''], ...trail, [pages.find((p) => p.slug === slug)?.title || title, slug]];
  const crumbs = slug ? chain.map(([name, s], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(s) })) : null;
  const graph = [
    { '@type': 'WebSite', '@id': `${site.url}/#website`, name: site.name, url: `${site.url}/`, inLanguage: site.lang, publisher: { '@id': 'https://teydralab.com/#organization' } },
    { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: fullTitle, description, inLanguage: site.lang, isPartOf: { '@id': `${site.url}/#website` }, about: { '@id': `${site.url}/#software` }, ...(crumbs ? { breadcrumb: { '@type': 'BreadcrumbList', itemListElement: crumbs } } : {}) },
    softwareLd(rel), orgLd, personLd, ...ld,
  ];
  return `<!doctype html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large,max-snippet:-1'}">
<meta name="author" content="${maker.company}">
<meta name="theme-color" content="${site.themeColor}">
<meta name="color-scheme" content="light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${site.name}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${site.url}/${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${site.name}: ${esc(site.descriptor)}">
<meta property="og:locale" content="${site.locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@teydralab">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${site.url}/${ogImage}">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${root}favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${root}apple-touch-icon.png">
<link rel="manifest" href="${root}site.webmanifest">
<link rel="alternate" type="text/markdown" title="${site.name} for AI readers" href="${root}llms.txt">
<link rel="alternate" type="application/rss+xml" title="${site.name} releases" href="${root}changelog/feed.xml">
<link rel="preload" href="${root}fonts/geist-normal-300_700-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${root}fonts/instrument-serif-italic-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}assets/site.css">
<script>document.documentElement.classList.add('js')</script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>
</head>
<body data-page="${slug || 'home'}"${heroDark ? ' data-hero="dark"' : ''}>
${header(slug, root)}
<main id="main">
${body(root)}
</main>
${footer(root)}
<script>window.__REL=${JSON.stringify({ api: release.api, fallback: release.fallback, windowsFile: release.files.windows, base: root, platforms: platforms.map(({ id, os }) => ({ id, os })) })}</script>
<script src="${root}assets/site.js" defer></script>
</body>
</html>`;
}

// Shared building blocks for pages.
export const pill = (status, text) => `<span class="pill pill--${status}">${text}</span>`;
export const statusPill = (status) => pill(status, { available: 'Available', next: 'Next release', planned: 'Planned' }[status]);

// A pill after a feature's name in running text: only what is not in the current release gets one (see legend).
// An unknown id fails the build instead of printing a wrong label.
export const stOf = (where) => (id) => {
  const f = featureById[id];
  if (!f) throw new Error(`${where}: unknown feature "${id}"`);
  return f.status === 'available' ? '' : ` ${statusPill(f.status)}`;
};

// The line above a text page that says how to read those pills.
export const legend = (rel) => `<p class="small muted" style="margin-bottom:40px;max-width:44em">No label: in the current public release (${rel.windows.version}).${release.renamed ? '' : ` ${statusPill('next')} built in development, ships with the next release.`} ${statusPill('planned')} not built yet.</p>`;

export function pageHero({ root, crumb, trail = [], title, lead, actions = '', dark = false }) {
  const between = trail.map(([name, s]) => `<a href="${root}${s}/">${name}</a><span>/</span>`).join('');
  return `<section class="phero${dark ? ' dark' : ''}"><div class="wrap">
  <nav class="phero__crumbs" aria-label="Breadcrumb"><a href="${root}">${site.name}</a><span>/</span>${between}<span>${crumb}</span></nav>
  <h1 data-reveal>${title}</h1>
  ${lead ? `<p class="lead" data-reveal style="--d:1">${lead}</p>` : ''}
  ${actions ? `<div class="btns phero__actions" data-reveal style="--d:2">${actions}</div>` : ''}
</div></section>`;
}

// The main button. `auto`: site.js points it at the visitor's own platform page (Mac, Linux, Android, iPhone);
// without JS, and on Windows, it stays the Windows installer.
export function downloadButton(root, { size = 'lg', cls = 'btn--ink', label = 'Download for Windows', auto = false } = {}) {
  return `<a class="btn ${cls} btn--${size}" href="${release.asset(release.files.windows)}" data-dl="windows"${auto ? ' data-dl-auto' : ''} rel="nofollow">${icon('windows')}<span data-dl-label>${label}</span><span class="btn__meta" data-rel="windows-meta">v${release.fallback.windows.version} · ${release.fallback.windows.sizeMb} MB</span></a>`;
}

// PC first, then phone: one row per kind, one tile per platform, each opening its own page.
export function platformRows(root, current = '') {
  return `<div class="plats">${platformKinds.map((k, r) => `
    <div class="plats__row" data-reveal style="--d:${r}">
      <span class="plats__kind">${k.label}</span>
      <div class="plats__list">${platforms.filter((p) => p.kind === k.id).map((p) => `<a class="plat" href="${root}download/${p.id}/" data-plat="${p.id}"${p.id === current ? ' aria-current="page"' : ''}>${icon(p.icon, 'plat__ic')}<span class="plat__os">${p.os}</span><span class="plat__meta">${esc(p.detail)}</span>${icon('arrow', 'plat__go')}</a>`).join('')}</div>
    </div>`).join('')}
  </div>`;
}
