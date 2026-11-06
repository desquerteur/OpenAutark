// Owns: /brand/, the name, marks, colours and type for press and partners.
// Never: drawing the marks (brand.mjs).
import { site, maker } from '../config.mjs';
import { page, pageHero } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { wordmarkSvg, markSvg, appIconSvg, COLORS } from '../brand.mjs';

const strip = (svg) => svg.replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" /, '<svg ').replace(/<title>[^<]*<\/title>/, '');

export default function brand(rel) {
  const swatch = (name, hex, use, dark) => `<div class="swatch"><i style="background:${hex}${dark ? '' : ';border-bottom:1px solid var(--line)'}"></i><div><b style="font-weight:500">${name}</b><code>${hex}</code><span class="small muted">${use}</span></div></div>`;
  const tile = (art, label, files, cls = '') => `<figure class="logo-tile" style="margin:0"><div class="logo-tile__art ${cls}">${art}</div><figcaption class="logo-tile__meta"><span>${label}</span><nav>${files.map(([t, h]) => `<a href="${h}" download>${t}</a>`).join('')}</nav></figcaption></figure>`;
  return page({
    slug: 'brand',
    rel,
    title: 'Brand and press kit',
    description: `${site.name} logo, mark, app icon, colors, type and ready-to-use descriptions for press and partners. Free to use when writing about ${site.name}.`,
    body: (root) => `
${pageHero({ root, crumb: 'Brand', title: 'The mark that <em>starts on its own.</em>', lead: `Logo files, colors, type and the words to describe ${site.name}. Use them freely when you write about us; please don’t change the mark or use it for something else.` })}
<section class="section section--tight">
  <div class="wrap">
    <div class="grid" style="row-gap:40px;align-items:center">
      <div class="col-5">
        <span class="eyebrow">The idea</span>
        <h2 class="h3" style="margin-top:18px;font-size:clamp(28px,3vw,42px)">An A without its bar. <em>A dot where the bar would be.</em></h2>
      </div>
      <div class="col-7 prose" style="max-width:none">
        <p><strong>${site.name}</strong> (German and English: self-sufficient, independent) describes what the app is: a company that runs on your own computer, on your own AI plans, and gets work done on its own.</p>
        <p>The mark is the letter A drawn as a Λ. Its crossbar is replaced by a single dot: the agent that moves before anyone asks. In the wordmark the first dot is signal orange; the second stays quiet. One starts, the rest follows.</p>
      </div>
    </div>
    <div class="logo-tiles" style="margin-top:56px">
      ${tile(`<div style="width:min(100%,360px)">${strip(wordmarkSvg())}</div>`, 'Wordmark', [['SVG', `${root}img/brand/autark-wordmark.svg`]])}
      ${tile(`<div style="width:min(100%,360px)">${strip(wordmarkSvg({ ink: COLORS.paper }))}</div>`, 'Wordmark, light', [['SVG', `${root}img/brand/autark-wordmark-light.svg`]], 'is-dark')}
      ${tile(`<div style="width:132px">${strip(appIconSvg())}</div>`, 'App icon', [['SVG', `${root}img/brand/autark-app-icon.svg`], ['PNG', `${root}img/brand/autark-app-icon-1024.png`]])}
      ${tile(`<div style="width:120px">${strip(markSvg())}</div>`, 'Mark', [['SVG', `${root}img/brand/autark-mark.svg`]])}
      ${tile(`<div style="width:120px">${strip(markSvg({ ink: COLORS.paper }))}</div>`, 'Mark, light', [['SVG', `${root}img/brand/autark-mark-light.svg`]], 'is-dark')}
      ${tile(`<div style="width:120px">${strip(markSvg({ ink: COLORS.ink, dot: COLORS.paper }))}</div>`, 'Mark on signal', [['SVG', `${root}img/brand/autark-mark.svg`]], 'is-signal')}
    </div>
  </div>
</section>
<section class="section section--line">
  <div class="wrap">
    <div class="head head--split"><div><span class="eyebrow">Color</span><h2 class="h2" style="margin-top:18px">Ink, paper <em>and one signal.</em></h2></div><p class="lead">Almost everything is black and warm white. Signal orange appears in small doses, for the one thing that moves on its own.</p></div>
    <div class="swatches">
      ${swatch('Ink', COLORS.ink, 'Text, marks, buttons', true)}
      ${swatch('Paper', COLORS.paper, 'Backgrounds', false)}
      ${swatch('Signal', COLORS.signal, 'The dot, focus, live state', true)}
      ${swatch('Night', COLORS.night, 'Dark sections, the night shift', true)}
    </div>
  </div>
</section>
<section class="section section--line">
  <div class="wrap">
    <div class="head head--split"><div><span class="eyebrow">Type</span><h2 class="h2" style="margin-top:18px">A grotesk <em>and an italic.</em></h2></div><p class="lead">Geist for everything that informs, Instrument Serif italic for the one phrase that should be felt, Geist Mono for labels and data. All three are open-source fonts (SIL Open Font License), served from our own domain.</p></div>
    <div class="cards">
      <div class="pcard"><span class="tiny muted">Geist · 300–700</span><p style="font-size:44px;line-height:1;letter-spacing:-.045em;color:var(--ink)">Your own AI company.</p></div>
      <div class="pcard"><span class="tiny muted">Instrument Serif · italic</span><p class="serif" style="font-size:48px;line-height:1;color:var(--ink)">It doesn’t wait.</p></div>
      <div class="pcard"><span class="tiny muted">Geist Mono · 400–500</span><p class="mono" style="font-size:20px;line-height:1.5;color:var(--ink)">09:03 mara agents.delegate → ivo ✓</p></div>
    </div>
  </div>
</section>
<section class="section section--paper2" id="press">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="Press"><b>Press</b><a href="#short">Short description</a><a href="#long">Long description</a><a href="#facts">Facts</a><a href="#rules">Using the logo</a><a href="#contact">Contact</a></nav>
    <div class="prose">
      <h2 id="short">Short description</h2>
      <blockquote style="font-family:var(--sans);font-style:normal;font-size:1.1em">${site.name} is a free desktop app that turns the ChatGPT and Claude plans you already pay for into your own AI company: a manager, specialist agents and a secretary that work on their own, on your own computer.</blockquote>
      <h2 id="long">Long description</h2>
      <p>${site.name} gives one person the strength of a whole team. A manager agent receives your work and hands it to specialists for research, marketing, finance or the web, while a private secretary looks after your day. Agents talk to you in chats, take tasks from one inbox, delegate among themselves, and wake up on their own on schedules, messages and events, so work continues even when you are not watching.</p>
      <p>Instead of selling another AI subscription, ${site.name} runs on the plans people already have, through the official tools of each provider (OpenAI Codex for ChatGPT plans, Claude Code for paid Claude plans), and optionally on API keys or local models. Everything lives on the user’s own computer. Agents have full access to it: there is no permission gate or money limit, the first thing the AI asks is how far it may go, and text steers it. Settings, skills and memory are open files, so the AI can set up and extend the app by itself.</p>
      <p>${site.name} is made by ${maker.company} in ${maker.location}, founded by ${maker.founder}. It grew up in ${maker.umbrella}, the Teydra Lab family of tools that let people stay above their agents, and was developed under the working name Proactive Agent Workforce.</p>
      <h2 id="facts">Facts</h2>
      <table><tbody>
        <tr><th>Product</th><td>${site.name} (working name: Proactive Agent Workforce)</td></tr>
        <tr><th>Category</th><td>Desktop app · AI agents · productivity</td></tr>
        <tr><th>Platforms</th><td>Windows, macOS and Linux, version ${rel.windows.version}</td></tr>
        <tr><th>Price</th><td>Free download; AI usage billed by the user’s own providers</td></tr>
        <tr><th>Maker</th><td><a href="${maker.companyUrl}" rel="noopener">${maker.company}</a>, ${maker.location}</td></tr>
        <tr><th>Founder</th><td><a href="${maker.founderUrl}" rel="noopener">${maker.founder}</a></td></tr>
        <tr><th>Website</th><td><a href="${site.url}/">${site.url.replace(/^https:\/\//, '')}</a></td></tr>
        <tr><th>Machine-readable</th><td><a href="${root}facts.json">facts.json</a> · <a href="${root}llms.txt">llms.txt</a></td></tr>
      </tbody></table>
      <h2 id="rules">Using the logo</h2>
      <ul>
        <li>Use the files above as they are. Don’t redraw, stretch, outline or recolor the mark beyond the versions shown.</li>
        <li>Keep clear space around the mark of at least the width of the dot, times four.</li>
        <li>The dot is signal orange on ink and paper, and paper on signal. Never more than one orange dot per logo.</li>
        <li>Write the name as “${site.name}”: one word, capital A, never all caps in running text.</li>
      </ul>
      <h2 id="contact">Contact</h2>
      <p>Press and partnerships: <a href="${maker.contactUrl}" rel="noopener">${maker.company} contact</a>. Background on the founder and earlier coverage: <a href="${maker.pressUrl}" rel="noopener">press page</a>.</p>
    </div>
  </div>
</section>`,
  });
}
