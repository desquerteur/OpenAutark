import { site, maker, release } from '../config.mjs';
import { page, pageHero } from '../layout.mjs';
import { icon, mark } from '../icons.mjs';

const host = (url) => new URL(url).host.replace(/^www\./, '');
const ext = (url, text) => `<a href="${url}" rel="noopener">${text}</a>`;

export default function about(rel) {
  return page({
    slug: 'about',
    rel,
    title: `Who builds ${site.name}: ${maker.company} and ${maker.founder}`,
    description: `${site.name} is built by ${maker.company} in Salzburg, Austria, founded by software engineer ${maker.founder}. Why it exists, what the name means, and ${maker.umbrella}.`,
    ld: [{
      '@type': 'AboutPage',
      '@id': `${site.url}/about/#aboutpage`,
      url: `${site.url}/about/`,
      name: `About ${site.name}`,
      inLanguage: site.lang,
      isPartOf: { '@id': `${site.url}/#website` },
      about: { '@id': 'https://teydralab.com/#organization' },
      mentions: [{ '@id': 'https://stanislaushees.com/#person' }, { '@id': `${site.url}/#software` }],
    }],
    body: (root) => `
${pageHero({
  root,
  crumb: 'About',
  title: `Who builds ${site.name}, <em>and why.</em>`,
  lead: `${site.name} is made by ${maker.company} in ${maker.location}, the company of founder and software engineer ${maker.founder}. It is part of ${maker.umbrella}: projects for people who want to stay above their agents.`,
  actions: `<a class="btn btn--ink btn--lg" href="${maker.contactUrl}" rel="noopener">Get in touch${icon('arrow', 'ic--move')}</a><a class="btn btn--ghost btn--lg" href="#why">Why it exists${icon('arrowDown', 'ic--move')}</a>`,
})}

<section class="section">
  <div class="wrap">
    <div class="layout-doc">
      <nav class="toc" aria-label="On this page">
        <b>On this page</b>
        <a href="#why">Why it exists</a>
        <a href="#name">The name</a>
        <a href="#teydra-lab">${maker.company}</a>
        <a href="#founder">The founder</a>
        <a href="#meta-jarvis">${maker.umbrella}</a>
        <a href="#book">The book</a>
        <a href="#recognition">Recognition</a>
        <a href="#principles">Principles</a>
        <a href="#contact">Contact</a>
      </nav>
      <div class="prose">
        <dl class="kv">
          <dt>Made by</dt><dd>${ext(maker.companyUrl, maker.company)}, ${maker.location}</dd>
          <dt>Founder</dt><dd>${ext(maker.founderUrl, maker.founder)}, founder and software engineer</dd>
          <dt>Part of</dt><dd>${ext(maker.umbrellaUrl, maker.umbrella)} · “Stay above the agents”</dd>
          <dt>Formerly</dt><dd>Proactive Agent Workforce</dd>
        </dl>

        <h2 id="why">Why ${site.name} exists</h2>
        <p>AI models became remarkably capable, and most of them still sit behind an empty text box. They answer when asked, then wait for the next message. ${maker.founder} wanted something else: digital employees that are proactive. They pursue useful tasks on their own, act reliably, and work together with people and with other agents, instead of behaving like a reactive chatbot.</p>
        <p>The original brief fits in one line:</p>
        <blockquote lang="de">„ich schreibe Sachen rein, es wird erledigt, es wird abgehakt, es wird dokumentiert.“</blockquote>
        <p>In English: “I write things in, it gets done, it gets ticked off, it gets documented.” ${site.name} is built around that sentence. You drop work into one inbox, a manager hands it to the right agent, the agent finishes it and writes down what it did, and you are asked only about what really needs you.</p>
        <p>And it should run on what people already have: their own computer and the ChatGPT or Claude plan they pay for every month. In ${maker.founder}’s words, the goal is <span lang="de">„die Kraft einer Firma mit 30 Mitarbeitern, nur die aus KI sind“</span>: the power of a company with 30 employees, except that the employees are AI.</p>

        <h2 id="name">The name</h2>
        ${mark().replace('<svg ', '<svg style="width:72px;height:72px" ')}
        <p>Autark is German for self-sufficient, independent. English has the same word as “autarkic”. It describes the app in three ways: it runs on your own computer, on your own AI plans, and it gets work done on its own.</p>
        <p>The mark is an A without its crossbar, Λ, with a dot where the bar would be. The dot is the agent that starts on its own.</p>
        <p>${site.name} was first called Proactive Agent Workforce, its working name.${release.renamed ? '' : ` The installed app and its files, such as the Windows installer <code>${release.files.windows}</code>, still carry that name until the rename release.`}</p>

        <h2 id="teydra-lab">${maker.company}</h2>
        <p>${site.name} is made by ${ext(maker.companyUrl, maker.company)} in ${maker.location}. ${maker.company} builds configurable AI chatbots for websites that answer with a company’s own knowledge and in its own design. ${site.name} is a different kind of product from the same lab: not an assistant on a website, but a team of agents on your own computer.</p>

        <h2 id="founder">The founder</h2>
        <p>${maker.company} was founded by ${ext(maker.founderUrl, maker.founder)}, founder and software engineer in Salzburg. On his website he keeps a ${ext(maker.founderProject, `project page about ${site.name}`)}, next to his other projects, notes and press.</p>

        <h2 id="meta-jarvis">${maker.umbrella}</h2>
        <p>${site.name} is part of ${ext(maker.umbrellaUrl, maker.umbrella)}, the ${maker.company} umbrella for projects around AI agents and the person who stays in charge of them. Its line is “Stay above the agents”: let agents do more of the work, and keep the human above them, not buried under them.</p>
        <p>The first ${maker.umbrella} project is ${ext(maker.telecodingUrl, 'TeleCoding')}: programming by phone call. ${site.name} belongs to the same family.</p>

        <h2 id="book">The book</h2>
        <p>${maker.founder} also offers a free book in German: ${ext(maker.bookUrl, `<span lang="de">„${maker.bookTitle}“</span>`)} (“AI into your own product”). On 253 pages it explains how to bring AI into your own software.</p>

        <h2 id="recognition">Recognition</h2>
        <p>${maker.company}: ${ext(maker.awardUrl, maker.award)}.</p>
        <p>For press, see the ${ext(maker.pressUrl, 'press page')}.</p>

        <h2 id="principles">Principles</h2>
        <p>${maker.umbrella} has three principles. ${site.name} is built on them.</p>
        <h3>Start with real life.</h3>
        <p>${site.name} begins with an actual day: the inbox, the calendar, the to-dos, the invoice that needs an OK. It covers work, personal brand and private life, and it is built and tested against an ordinary 8 GB RAM laptop.</p>
        <h3>Coordinate, don’t obscure.</h3>
        <p>Agents work in the open. Every task has an owner, tool calls land in a run journal, and Team shows who is working on what. Their instructions, skills and memory are files you can read. You see how a result came about, not only the result.</p>
        <h3>Keep the stop button.</h3>
        <p>“Stop all agent work”, in the tray, behind the chat header’s live line or with <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>X</kbd>, halts every agent on this PC and stays in force after a restart. It is a brake, not a wall: agents otherwise have full access to your PC, and how far they go is something you tell them. More on the <a href="${root}access/">access page</a>.</p>

        <h2 id="contact">Contact</h2>
        <p>Questions, ideas or press requests: ${ext(maker.contactUrl, `contact ${maker.company}`)}. Found a bug or something out of date? ${ext(maker.feedbackUrl, 'Report it on GitHub')}.</p>
        <p>Follow ${maker.company} on ${maker.social.map((s) => ext(s.url, s.name)).join(', ').replace(/, ([^,]*)$/, ' and $1')}.</p>
        <p class="small">${ext(maker.imprintUrl, 'Imprint')} · ${ext(maker.privacyUrl, 'Privacy policy')}</p>
      </div>
    </div>
  </div>
</section>

<section class="section section--line section--paper2" aria-labelledby="elsewhere">
  <div class="wrap maker">
    <div>
      <span class="eyebrow" data-reveal>Elsewhere</span>
      <h2 class="h2" id="elsewhere" data-reveal style="margin-top:22px">More from <em>${maker.company}.</em></h2>
      <p class="lead" data-reveal style="--d:1;margin-top:24px">The company, the founder, the umbrella and its first project, the book and the press page.</p>
    </div>
    <nav class="links" aria-label="${maker.company} and ${maker.founder}" data-reveal style="--d:1">
      <a href="${maker.companyUrl}" rel="noopener"><b>${maker.company}</b><span>AI chatbots for websites, with your own knowledge and design</span>${icon('external')}</a>
      <a href="${maker.founderUrl}" rel="noopener"><b>${maker.founder}</b><span>The founder: projects, notes and press</span>${icon('external')}</a>
      <a href="${maker.founderProject}" rel="noopener"><b>${site.name} on ${host(maker.founderUrl)}</b><span>The founder’s project page about this app</span>${icon('external')}</a>
      <a href="${maker.umbrellaUrl}" rel="noopener"><b>${maker.umbrella}</b><span>The umbrella: stay above the agents</span>${icon('external')}</a>
      <a href="${maker.telecodingUrl}" rel="noopener"><b>TeleCoding</b><span>The first ${maker.umbrella} project: programming by phone call</span>${icon('external')}</a>
      <a href="${maker.bookUrl}" rel="noopener"><b>${maker.bookTitle}</b><span>A free book on AI in your own software (German, 253 pages)</span>${icon('external')}</a>
      <a href="${maker.awardUrl}" rel="noopener"><b>Austrian Innovation Forum 2026</b><span>Startup category winner, Beyond Optimization Crowd in Motion Challenge</span>${icon('external')}</a>
      <a href="${maker.pressUrl}" rel="noopener"><b>Press</b><span>The press page on ${host(maker.pressUrl)}</span>${icon('external')}</a>
    </nav>
  </div>
</section>`,
  });
}
