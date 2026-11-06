// Owns: the start page: hero, downloads (PC then phone), the story sections, FAQ and maker.
// Never: facts of its own; features, FAQ, platforms and release facts come from data/ and config.mjs.
import { site, release, maker } from '../config.mjs';
import { page, kword, esc, downloadButton, stOf, platformRows } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { featureById, allFeatures } from '../data/features.mjs';
import { faq } from '../data/faq.mjs';

const st = stOf('home');

const nodes = [
  { id: 'you', name: 'You', role: 'Owner', human: true, x: 50, y: 11, mx: 50, my: 6 },
  { id: 'theo', name: 'Theo', role: 'Secretary', x: 17, y: 38, mx: 18, my: 29 },
  { id: 'mara', name: 'Mara', role: 'Manager', x: 50, y: 38, mx: 50, my: 29 },
  { id: 'ana', name: 'Ana', role: 'Colleague', human: true, x: 83, y: 38, mx: 82, my: 29 },
  { id: 'ivo', name: 'Ivo', role: 'Research', x: 14, y: 70, mx: 27, my: 56 },
  { id: 'lena', name: 'Lena', role: 'Marketing', x: 38, y: 70, mx: 73, my: 56 },
  { id: 'noa', name: 'Noa', role: 'Finance', x: 62, y: 70, mx: 27, my: 81 },
  { id: 'kai', name: 'Kai', role: 'Web', x: 86, y: 70, mx: 73, my: 81 },
];

const node = (n) => `<div class="node${n.human ? ' node--human' : ''}" data-node="${n.id}" style="--x:${n.x}%;--y:${n.y}%;--mx:${n.mx}%;--my:${n.my}%">
  <div class="node__av">${n.name.slice(0, n.human ? 3 : 1)}<span class="node__chip" data-chip></span></div>
  <div class="node__name">${n.name}<span class="node__role">${n.role}</span></div>
</div>`;

const tiles = ['work-inbox', 'wake', 'my-day', 'chats', 'apps', 'email', 'computer', 'vault', 'phone', 'remote', 'vectors', 'voice'];

// The open system: why this app, beyond the company idea.
const openTiles = ['short-start', 'browser-spaces', 'providers-file', 'skills-files', 'memory-files', 'own-connections'];

const nightTasks = [
  ['22:40', 'Theo sorted 31 new emails and drafted 4 replies', 'done'],
  ['23:15', 'Ivo finished the research report on six competitors', 'done'],
  ['00:30', 'Kai fixed two broken links on your website', 'done'],
  ['01:10', 'Lena wrote three post drafts for this week', 'done'],
  ['02:05', 'The heavy work ran on the plan that resets tomorrow', 'done'],
  ['03:20', 'Noa has a question about a €640 invoice', 'ask'],
  ['06:45', 'Theo planned your day around three meetings', 'done'],
];

const statement = ['You', 'write', 'it', 'in.', '|It', 'gets', 'done.', '|It', 'gets', '*ticked*', '*off.*', '|It', 'gets', 'documented.'];

const compareRows = [
  ['Starts work without a prompt', 'yes', 'part', 'yes', 'part'],
  ['A team with roles and delegation', 'yes', 'no', 'part', 'part'],
  ['Runs on your existing ChatGPT or Claude plan', 'yes', 'yes', 'no', 'no'],
  ['Your data lives on your computer', 'yes', 'no', 'part', 'part'],
  ['Acts in your apps, browser and files', 'yes', 'part', 'yes', 'part'],
  ['Settings, skills and memory as open files the AI can change', 'yes', 'no', 'part', 'part'],
  ['A finished app, no code', 'yes', 'yes', 'part', 'no'],
];
const mark3 = { yes: '<span class="yes">Yes</span>', no: '<span class="no">No</span>', part: '<span class="part">Partly</span>' };

// A tile only says something about its status when the feature is not in the current release.
const tile = (id, i) => {
  const f = featureById[id];
  if (!f) throw new Error(`home: unknown feature "${id}"`);
  return `<article class="tile" data-reveal style="--d:${i % 4}"><div class="tile__top">${icon(f.icon)}${st(id)}</div><h3 class="tile__h">${esc(f.title)}</h3><p class="tile__p">${esc(f.text)}</p></article>`;
};

export default function home(rel) {
  const homeFaq = faq.filter((f) => f.home);

  return page({
    slug: '',
    rel,
    title: `${site.name} — your own AI company that works on its own`,
    description: `${site.name} is a free app for Windows, macOS and Linux, with an Android app and an iPhone web app, that turns the ChatGPT and Claude plans you already pay for into your own AI company: a manager, specialist agents and a secretary that work proactively on your own computer.`,
    ld: [{ '@type': 'FAQPage', '@id': `${site.url}/#faq`, mainEntity: homeFaq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }],
    body: (root) => `
<section class="hero" id="top">
  <div class="wrap" style="display:flex;flex-direction:column;flex:1">
    <div class="hero__top" data-reveal>
      <span class="eyebrow">By ${maker.company} · ${maker.location}</span>
      <span class="eyebrow eyebrow--plain"><span class="eyebrow__n" data-rel="windows-version">Version ${rel.windows.version}</span> · Free download</span>
    </div>
    <div class="hero__word">${kword('hero__kword')}</div>
    <div class="hero__body">
      <div>
        <h1 class="hero__title" data-reveal><span class="sr">${site.name}: </span>Your own AI company. <em>It doesn’t wait</em> for a prompt.</h1>
        <p class="lead hero__lead" data-reveal style="--d:1">A manager, specialist agents and a secretary that pick up work, split it up, finish it and report back — on your own computer, with the ChatGPT and Claude plans you already pay for.</p>
      </div>
      <div class="hero__side" data-reveal style="--d:2">
        <div class="btns">
          ${downloadButton(root, { auto: true })}
          <a class="btn btn--ghost btn--lg" href="#get">Every device${icon('arrowDown', 'ic--move')}</a>
        </div>
        <div class="hero__note"><span>${icon('check')}No account</span><span>${icon('check')}No subscription from us</span><span>${icon('check')}Your data lives on your PC</span></div>
      </div>
    </div>
  </div>
</section>

<section class="get" id="get" aria-labelledby="get-h">
  <div class="wrap">
    <div class="get__head">
      <h2 class="h3" id="get-h" data-reveal>On your PC. <em>And in your pocket.</em></h2>
      <p class="small muted" data-reveal style="--d:1">Free · no account · the phone joins your whole company, not one PC</p>
    </div>
    ${platformRows(root)}
  </div>
</section>

<section class="section--tight" aria-label="Your company at work">
  <div class="wrap">
    <div class="org" data-org>
      <div class="org__stage" data-org-stage>
        <svg class="org__lines" data-org-lines aria-hidden="true"></svg>
        ${nodes.map(node).join('')}
        <div class="org__legend"><span><i class="r"></i>Human</span><span><i></i>AI agent</span></div>
        <div class="org__clock" data-org-clock>Tue 09:00</div>
      </div>
    </div>
    <p class="sr">Illustration: you hand one task to your manager agent Mara. She splits it into four tasks for research, marketing, finance and web agents. The finance agent asks your colleague Ana a question in the chat and you read along. Your secretary moves a call on its own. At the end Mara sends you a briefing.</p>
  </div>
</section>

<div class="marquee" aria-hidden="true"><div class="marquee__row">${Array(2).fill(['Delegates', 'Remembers', 'Wakes up on its own', 'Connects your apps', 'Builds its own connections', 'Works overnight', 'Reports back', 'Keeps secrets by ID', 'Runs on your PC']).flat().map((t) => `<span>${t}</span>`).join('')}</div></div>

<section class="section" id="problem">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">01</span> The problem</span>
      <h2 class="h2" data-reveal style="margin-top:22px">AI got brilliant. <em>It still waits.</em></h2></div>
      <p class="lead" data-reveal style="--d:1">The most capable models ever built sit behind an empty text box. They answer when asked, forget when you close the chat, and leave the real work, the routing, the follow-ups, the copy and paste, to you.</p>
    </div>
    <div class="story" data-story>
      <div class="story__steps">
        <article class="story__step" data-step="0"><span class="story__k">A / Reactive</span><h3 class="h2">It waits for you.</h3><p class="body">Nothing happens until you type. A chat assistant does not notice the email that needs an answer, the deadline tomorrow or the task that stalled at 3 pm.</p></article>
        <article class="story__step" data-step="1"><span class="story__k">B / Forgetful</span><h3 class="h2">It forgets.</h3><p class="body">Every new chat starts from zero. Goals, promises and half-finished work live in your head, not in the system that is supposed to help you.</p></article>
        <article class="story__step" data-step="2"><span class="story__k">C / You are the glue</span><h3 class="h2">You do the routing.</h3><p class="body">You copy from the mail into the chat, from the chat into the doc, from one assistant to the next. The AI does the parts. You are still the operating system.</p></article>
        <article class="story__step" data-step="3"><span class="story__k">D / Unused</span><h3 class="h2">Your plan expires unused.</h3><p class="body">You pay for ChatGPT or Claude every month. Weekly limits reset whether you used them or not, and most of what you paid for was never asked to do anything.</p></article>
      </div>
      <div class="story__stage" aria-hidden="true">
        <div class="screen">
          <div class="screen__bar"><i></i><i></i><i></i><b data-screen-title>chat — new conversation</b></div>
          <div class="scene is-on" data-scene="0"><div class="wait"><div class="wait__clock"><div class="wait__time" data-wait-time>09:00</div><div class="wait__sub" data-wait-sub>0 tasks started</div></div><div class="prompt">Ask anything<span class="prompt__caret"></span><span class="prompt__send"></span></div></div></div>
          <div class="scene" data-scene="1"><div class="forget" data-forget>
            <div class="bubble bubble--me">Remember: the offer for Anna goes out Friday.</div>
            <div class="bubble">Got it. I’ll keep that in mind.</div>
            <div class="bubble bubble--me">And we agreed on 12 % discount.</div>
            <div class="bubble">Noted — 12 % for Anna, sent by Friday.</div>
          </div><div class="forget__new">+ New chat · memory empty</div></div>
          <div class="scene" data-scene="2"><div class="glue" data-glue>
            <div class="win"><b>Mail</b><i></i><i></i><i></i></div>
            <div class="win"><b>Assistant 1</b><i></i><i></i><i></i></div>
            <div class="win"><b>Docs</b><i></i><i></i><i></i></div>
            <div class="win"><b>Assistant 2</b><i></i><i></i><i></i></div>
            <div class="glue__count"><b data-glue-n>0</b>copy &amp; paste today</div>
            <div class="glue__cursor" data-glue-cursor><svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8-6 1.5L10 19z" fill="#0B0B0C" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="glue__clip">copied</span></div>
          </div></div>
          <div class="scene" data-scene="3"><div class="quota" data-quota>
            <div class="quota__row"><div class="quota__top"><span>Your AI plan · this week</span><span>resets Monday</span></div><div class="quota__bar"><span class="quota__used" style="--w:23%"></span><span class="quota__lost" style="--w:77%"></span></div></div>
            <div class="quota__row"><div class="quota__top"><span>Second plan · this week</span><span>resets Thursday</span></div><div class="quota__bar"><span class="quota__used" style="--w:9%"></span><span class="quota__lost" style="--w:91%"></span></div></div>
            <p class="quota__note">Example week: <b>77 % and 91 % expired</b> without a single task.</p>
          </div></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section section--line statement" aria-labelledby="st">
  <div class="wrap">
    <span class="eyebrow" data-reveal><span class="eyebrow__n">02</span> The idea</span>
    <h2 class="sr" id="st">The idea behind ${site.name}</h2>
    <p class="statement__line" data-statement style="margin-top:28px">${statement.map((w) => {
      const br = w.startsWith('|'); const it = w.includes('*'); const t = w.replace('|', '').replace(/\*/g, '');
      return `${br ? '<br>' : ''}<span class="w${it ? ' w--em' : ''}">${t}</span> `;
    }).join('')}</p>
    <div class="statement__src" data-reveal><span class="serif" style="font-size:20px">„ich schreibe Sachen rein, es wird erledigt, es wird abgehakt, es wird dokumentiert.“</span><span class="tiny muted">${maker.founder}, the original brief</span></div>
  </div>
</section>

<section class="section section--paper2" id="how">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">03</span> How it works</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Say it once. <em>Your company</em> takes it from there.</h2></div>
      <p class="lead" data-reveal style="--d:1">${site.name} is not another chatbot. It is an organisation: a manager who routes the work, specialists who do it, and you, who are asked only about what really needs you.</p>
    </div>
    <div class="steps">
      <article class="step" data-reveal>
        <div class="step__demo" aria-hidden="true"><div class="split" data-split>
          <div class="split__say">${icon('mic')}<span data-split-text></span></div>
          <div class="split__task"><span class="av">I</span>Research the three closest competitors<em>Ivo</em></div>
          <div class="split__task"><span class="av">L</span>Draft the newsletter for Friday<em>Lena</em></div>
          <div class="split__task"><span class="av av--me">Y</span>Call the printer about the flyers<em>My day</em></div>
        </div></div>
        <div class="step__txt"><span class="step__n">01 — Work</span><h3 class="h3">Say it once.</h3><p class="body">Type or dictate into one inbox. Your manager can split a long sentence into separate tasks, each with the right owner: an agent, or your own My day.</p></div>
      </article>
      <article class="step" data-reveal style="--d:1">
        <div class="step__demo" aria-hidden="true"><div class="log" data-log></div></div>
        <div class="step__txt"><span class="step__n">02 — Agents</span><h3 class="h3">Your team does it.</h3><p class="body">Agents delegate among themselves, open your apps, browse, read files and write things down. The steps land in a run journal you can read.</p></div>
      </article>
      <article class="step" data-reveal style="--d:2">
        <div class="step__demo" aria-hidden="true"><div class="askdemo"><div class="card" data-ask>
          <div class="card__top"><span class="tiny muted">Question · Mara</span></div>
          <div class="card__title">How far may I go on this PC?</div>
          <div class="card__meta">I technically can already. Your answer tells me what you want.</div>
          <div class="card__btns"><span>Full access</span><span>Just this once</span><span>Less</span></div>
          <div class="card__note">${icon('chat')}A question, not a lock</div>
        </div></div></div>
        <div class="step__txt"><span class="step__n">03 — You</span><h3 class="h3">You say how far it goes.${st('first-question')}</h3><p class="body">The first thing your manager asks is how far it may go. That is a question, not a barrier: agents have full access from the start. Your answer steers them, and so does every message after it.</p></div>
      </article>
    </div>
  </div>
</section>

<section class="night dark" data-night aria-labelledby="night-h">
  <div class="night__pin">
    <div class="night__sky" aria-hidden="true"><div class="night__stars" data-stars></div></div>
    <div class="wrap night__head">
      <div><span class="eyebrow"><span class="eyebrow__n">04</span> Proactive</span>
      <h2 class="h2" id="night-h" style="margin-top:20px;max-width:9.5em">Close the window. <em>The company keeps working.</em></h2></div>
      <div class="night__time" data-night-time aria-hidden="true">22:00</div>
    </div>
    <div class="wrap night__mid">
      <div class="night__list" data-night-list>
        ${nightTasks.map(([t, txt, s]) => `<div class="ntask" data-at="${t}" data-end="${s}"><span class="ntask__t">${t}</span><span class="ntask__s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span><span>${txt}</span></div>`).join('')}
      </div>
      <div class="brief" data-brief>
        <div class="brief__top"><span>Morning briefing</span><span data-brief-t>07:30</span></div>
        <div class="brief__h" data-brief-h>Good morning. Here is what happened while you slept.</div>
        <div class="brief__stats"><div><b data-brief-done>6</b><span>Tasks done</span></div><div><b data-brief-ask>1</b><span>Needs you</span></div><div><b>0</b><span>Problems</span></div></div>
        <p data-brief-p>Noa has a question about the €640 invoice. Everything else is in My day.</p>
      </div>
    </div>
    <div class="wrap night__foot">
      <span class="tiny" style="color:var(--moon-3)">22:00</span><div class="night__track" data-night-track><i></i></div><span class="tiny" style="color:var(--moon-3)">07:30</span>
    </div>
  </div>
  <div class="wrap"><p class="tiny" style="color:var(--moon-3);margin-top:12px">An illustration of how a night can look, not a measured run.</p></div>
  <div class="wrap sr"><p>While your computer is on, agents wake up on schedules, timers, messages, tasks and events, even with the window closed. They can plan their own follow-ups, and in the morning you get a briefing of what was done and what needs you.</p></div>
</section>

<section class="section" id="engines">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">05</span> Engines</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Runs on the AI <em>you already pay for.</em></h2></div>
      <p class="lead" data-reveal style="--d:1">${site.name} is not another AI subscription. Your agents work through the official tools of each provider, with your own accounts. Add as many accounts as you like; ${site.name} picks the engine, the model and the effort for each turn.</p>
    </div>
    <div class="engines" data-engines>
      <div class="lane" data-reveal><div class="lane__name">ChatGPT plan<small>via OpenAI Codex</small></div><div class="lane__track" style="--q:38%"><span class="lane__fill"></span><span class="lane__agent" data-ride><i>L</i>Lena</span><span class="lane__label">62 % left · resets in 2 d</span></div></div>
      <div class="lane" data-reveal style="--d:1"><div class="lane__name">Paid Claude plan<small>via Claude Code</small></div><div class="lane__track" style="--q:65%"><span class="lane__fill"></span><span class="lane__agent" data-ride style="animation-delay:-2.8s"><i>I</i>Ivo</span><span class="lane__label">35 % left · resets in 5 d</span></div></div>
      <div class="lane" data-reveal style="--d:2"><div class="lane__name">API keys<small>a dozen known · any server by address</small></div><div class="lane__track" style="--q:0%"><span class="lane__fill"></span><span class="lane__label">pay per use · optional</span></div></div>
      <div class="lane" data-reveal style="--d:3"><div class="lane__name">Local models<small>Ollama · LM Studio · llama.cpp · vLLM</small></div><div class="lane__track" style="--q:0%"><span class="lane__fill"></span><span class="lane__label">runs on your hardware · optional</span></div></div>
      <div class="lane" data-reveal style="--d:4"><div class="lane__name">Gemini CLI · Copilot CLI · Kimi Code<small>over the Agent Client Protocol</small></div><div class="lane__track" style="--q:0%"><span class="lane__fill"></span><span class="lane__label">built · never seen in a live run</span></div></div>
    </div>
    <div class="ledger" data-reveal><span>${icon('switch')}</span><span><b>Switch engines mid-task.</b> The agent’s session is rebuilt from a shared context ledger, so nothing has to be explained twice.</span><span></span><span><b>Use it before you lose it.</b> The plan that resets soonest goes first.</span><span></span></div>
    <p class="small muted" data-reveal style="margin-top:16px">Quota numbers above are example values. API keys and local models have no recorded live run yet.</p>
  </div>
</section>

<section class="section section--line" id="capabilities">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">06</span> Capabilities</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Everything a company needs. <em>Nothing you have to wire.</em></h2></div>
      <div data-reveal style="--d:1"><p class="lead">Chats, tasks, a calendar, your apps, your inbox, a browser, a secrets catalog, your phone. ${tiles.every((id) => featureById[id]?.status === 'available') ? 'All of it is in today’s release.' : 'What is not in today’s release yet carries a label.'}</p><p style="margin-top:22px"><a class="link" href="${root}product/">All ${allFeatures.length} capabilities${icon('arrow')}</a></p></div>
    </div>
    <div class="bento">
      ${tiles.map(tile).join('')}
    </div>
  </div>
</section>

<section class="section section--paper2" id="open">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">07</span> Open</span>
      <h2 class="h2" data-reveal style="margin-top:22px">No connectors to wait for. <em>Files your AI can change.</em></h2></div>
      <p class="lead" data-reveal style="--d:1">Settings, providers, skills and memory are plain files on your disk. So the AI can add a provider it has never seen, write a skill or connect another app by itself, and you can read every bit of it.</p>
    </div>
    <div class="bento">
      ${openTiles.map(tile).join('')}
    </div>
    <p data-reveal style="margin-top:28px"><a class="link" href="${root}how-it-works/#open">How the open system works${icon('arrow')}</a></p>
  </div>
</section>

<section class="section dark" id="access">
  <span id="safety"></span>
  <div class="wrap">
    <div class="grid" style="align-items:center;row-gap:56px">
      <div class="col-5">
        <span class="eyebrow" data-reveal><span class="eyebrow__n">08</span> Access</span>
        <h2 class="h2" data-reveal style="margin-top:22px">It can do everything. <em>You say how far it goes.</em></h2>
        <p class="lead" data-reveal style="--d:1;margin-top:22px">Agents run with your rights, without a sandbox or approval prompts. There is no guardian and no money limit in the app. Text steers them.</p>
        <div class="rules" data-reveal style="--d:2;margin-top:36px">
          <div class="rule">${icon('chat')}<div><h3>The first question</h3><p>The first thing the AI asks is how far it may go: full access for good, this one search just this once, or less. It is a question, not a technical barrier.${st('first-question')}</p></div></div>
          <div class="rule">${icon('key')}<div><h3>Secrets by ID</h3><p>Agents use <code>secret://…</code> references. Values stay out of prompts, and known values are masked in output.</p></div></div>
          <div class="rule">${icon('archive')}<div><h3>Backups on your disk</h3><p>A copy of the data folder when you ask for it, and a copy of the database before each update. They do not undo what an agent did elsewhere.</p></div></div>
          <div class="rule">${icon('stop')}<div><h3>A brake</h3><p>“Stop all agent work” or <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>X</kbd> halts every agent on this PC and stays stopped after a restart.</p></div></div>
        </div>
        <p data-reveal style="margin-top:28px"><a class="link" href="${root}access/">What that means, plainly${icon('arrow')}</a></p>
      </div>
      <div class="col-7" data-reveal style="--d:1">
        <div class="reach" data-reach aria-hidden="true">
          <div class="reach__label">${icon('bolt')}Agent · full access</div>
          <div class="reach__lanes"><div class="reach__lane reach__lane--pc"><b>Your PC</b><span>files · commands</span></div><div class="reach__lane reach__lane--web"><b>The world</b><span>web · accounts · money</span></div><div class="reach__lane reach__lane--word"><b>Your words</b><span>chat · skills · memory</span></div></div>
        </div>
        <p class="sr">Illustration: an agent’s actions go directly to your PC, to the web and your accounts, and to what steers it: your words, skills and memory. Nothing stands in between.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="local">
  <div class="wrap">
    <div class="grid" style="align-items:center;row-gap:48px">
      <div class="col-7" data-reveal>
        <div class="local" aria-hidden="true">
          <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet" data-local>
            <path class="ln" d="M400 210 V110"/><path class="pulse" d="M400 210 V110"/>
            <path class="ln" d="M300 270 H150"/><path class="pulse" d="M300 270 H150" style="animation-delay:-.5s"/>
            <path class="ln" d="M500 270 H650"/><path class="pulse" d="M500 270 H650" style="animation-delay:-.9s"/>
            <path class="ln" d="M400 330 V405" stroke-dasharray="4 6"/>
            <rect class="box" x="250" y="40" width="300" height="70" rx="14"/><text x="400" y="70" text-anchor="middle">AI providers you choose</text><text x="400" y="92" text-anchor="middle" class="t-strong">OpenAI · Anthropic · local</text>
            <rect class="core" x="300" y="210" width="200" height="120" rx="18"/><text x="400" y="252" text-anchor="middle" style="fill:#A9ACB6">Your PC</text><text x="400" y="280" text-anchor="middle" class="t-strong" style="fill:#ECEAE4">Your company</text><text x="400" y="304" text-anchor="middle" style="fill:#6E7280;font-size:10px">database · secrets · files</text>
            <rect class="box" x="40" y="225" width="110" height="90" rx="14"/><text x="95" y="262" text-anchor="middle">Phone</text><text x="95" y="285" text-anchor="middle" class="t-strong">App</text>
            <rect class="box" x="650" y="225" width="110" height="90" rx="14"/><text x="705" y="262" text-anchor="middle">Another</text><text x="705" y="285" text-anchor="middle" class="t-strong">PC</text>
            <rect class="box" x="290" y="405" width="220" height="60" rx="14" style="fill:none;stroke-dasharray:4 6"/><text x="400" y="433" text-anchor="middle">Our servers</text><text x="400" y="452" text-anchor="middle" style="fill:#C43D00">hold none of it</text>
          </svg>
        </div>
      </div>
      <div class="col-5">
        <span class="eyebrow" data-reveal><span class="eyebrow__n">09</span> Local-first</span>
        <h2 class="h2" data-reveal style="margin-top:22px">Your company lives <em>on your computer.</em></h2>
        <p class="lead" data-reveal style="--d:1;margin-top:22px">No account with us. No cloud of ours. Chats, tasks, memory, agents and the secrets catalog sit in a folder on your own disk. Prompts go to the providers you connect; our meeting server only helps your devices find each other, end-to-end encrypted.</p>
        <ul class="hero__note" data-reveal style="--d:2;margin-top:24px;display:grid;gap:10px;padding:0;list-style:none">
          <li><span>${icon('check')}An Android app and an iPhone web app that reach your whole company</span></li>
          <li><span>${icon('check')}Several PCs, over your network or Tailscale</span></li>
          <li><span>${icon('check')}Backup, restore and your chats as files</span></li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="section section--line" id="compare">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">10</span> Where it fits</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Not a chat. Not a workflow. <em>A company.</em></h2></div>
      <p class="lead" data-reveal style="--d:1">Chat apps answer. Automation tools follow fixed rules. Agent frameworks are parts for developers. ${site.name} is the finished organisation in between.</p>
    </div>
    <div class="table-wrap" data-reveal>
      <table class="table">
        <thead><tr><th scope="col">What you get</th><th scope="col" class="us">${site.name}</th><th scope="col">Chat apps<br><span style="text-transform:none;letter-spacing:0">ChatGPT, Claude</span></th><th scope="col">Automation tools<br><span style="text-transform:none;letter-spacing:0">Zapier, n8n</span></th><th scope="col">Agent frameworks<br><span style="text-transform:none;letter-spacing:0">CrewAI, LangGraph</span></th></tr></thead>
        <tbody>${compareRows.map(([k, ...v]) => `<tr><th scope="row">${k}</th>${v.map((x, i) => `<td${i === 0 ? ' class="us"' : ''}>${mark3[x]}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="small muted" data-reveal style="margin-top:16px">Categories, not single products; individual tools differ. Based on public product descriptions, November 2026. <a href="${root}compare/">Detailed comparison</a></p>
  </div>
</section>

<section class="section" id="download" style="background:var(--signal);color:var(--ink);--line:rgba(11,11,12,.16);--line-2:rgba(11,11,12,.3)">
  <div class="wrap dl">
    <div class="dl__big">
      <h2 class="dl__title" data-reveal>Start your <em>company.</em></h2>
      <div class="dl__main" data-reveal style="--d:1">
        ${downloadButton(root, { cls: 'btn--ink', auto: true })}
        <div class="dl__facts" style="color:rgba(11,11,12,.7)"><span data-rel="windows-date">Released ${rel.windows.date}</span><span>Free · no account</span></div>
        <div class="dl__other">
          <a href="${root}download/windows/">${icon('windows')}Windows</a>
          <a href="${root}download/mac/">${icon('apple')}macOS</a>
          <a href="${root}download/linux/">${icon('linux')}Linux</a>
          <a href="${root}download/android/">${icon('android')}Android</a>
          <a href="${root}download/iphone/">${icon('phone')}iPhone</a>
        </div>
        <p class="small" style="color:rgba(11,11,12,.72);max-width:34em">You need at least one AI: a ChatGPT plan, a paid Claude plan, an API key or a local model. The builds are not signed: Windows SmartScreen asks you to confirm (“More info” → “Run anyway”), and macOS needs a few extra steps. Each platform page shows what you will see.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="faq">
  <div class="wrap">
    <div class="grid" style="row-gap:40px">
      <div class="col-4"><span class="eyebrow" data-reveal><span class="eyebrow__n">11</span> Questions</span><h2 class="h2" data-reveal style="margin-top:22px">Asked <em>often.</em></h2><p data-reveal style="margin-top:24px"><a class="link" href="${root}faq/">All questions${icon('arrow')}</a></p></div>
      <div class="col-8 faq" data-reveal>${homeFaq.map((f, i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(f.q)}</summary><div><p>${esc(f.a)}</p></div></details>`).join('')}</div>
    </div>
  </div>
</section>

<section class="section section--line" id="maker">
  <div class="wrap maker">
    <div>
      <span class="eyebrow" data-reveal><span class="eyebrow__n">12</span> Who builds it</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Made in Salzburg <em>by ${maker.company}.</em></h2>
      <p class="lead" data-reveal style="--d:1;margin-top:24px">${site.name} is built by ${maker.company}, the company of founder and software engineer <a href="${maker.founderUrl}" rel="noopener">${maker.founder}</a>. <a href="${root}about/">Why it exists</a>.</p>
      <p class="small muted" data-reveal style="--d:2;margin-top:20px"><a href="${maker.awardUrl}" rel="noopener">${maker.company}: ${maker.award}</a></p>
    </div>
    <nav class="links" aria-label="Links" data-reveal style="--d:1">
      <a href="${maker.companyUrl}" rel="noopener"><b>${maker.company}</b><span>AI chatbots for websites, with your own knowledge and design</span>${icon('external')}</a>
      <a href="${maker.founderUrl}" rel="noopener"><b>${maker.founder}</b><span>The founder: projects, notes and press</span>${icon('external')}</a>
      <a href="${release.repoUrl}" rel="noopener"><b>${release.repo.split('/')[1]}</b><span>Releases, downloads and issues on GitHub</span>${icon('external')}</a>
      <a href="${maker.bookUrl}" rel="noopener"><b>${maker.bookTitle}</b><span>A free book on AI inside your own software (German)</span>${icon('external')}</a>
    </nav>
  </div>
</section>`,
  });
}
