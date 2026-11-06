import { site, maker, release } from '../config.mjs';
import { page, pageHero, downloadButton, stOf } from '../layout.mjs';
import { icon } from '../icons.mjs';

// Categories, not single products. Facts about other products only in
// general, widely known terms (see BRIEF.md, "Competitors"). Be fair: where a
// category is ahead, say so.
const cats = [
  { id: 'chat-apps', name: 'Chat apps', ex: 'ChatGPT, Claude desktop' },
  { id: 'coding-agents', name: 'Coding agents', ex: 'Codex, Claude Code alone' },
  { id: 'assistants', name: 'Personal assistants', ex: 'Hermes Agent, OpenClaw, Letta' },
  { id: 'team-workspaces', name: 'AI team workspaces', ex: 'Genspark GenTeam' },
  { id: 'automation', name: 'Automation tools', ex: 'Zapier, n8n, Dify' },
  { id: 'frameworks', name: 'Agent frameworks', ex: 'CrewAI, LangGraph, AutoGen, OpenAI Agents SDK' },
];

// A cell is 'yes' | 'part' | 'no', or [kind, label, note].
// Order of `v`: same as `cats`.
const rows = [
  { k: 'Starts work without a prompt', us: ['yes', '', 'while your PC is on'], v: ['part', 'part', 'yes', 'part', 'yes', 'part'] },
  { k: 'A team with roles and delegation', us: 'yes', v: ['no', 'part', 'part', 'yes', 'part', 'part'] },
  { k: 'Humans and agents in the same chats and tasks', us: ['yes', '', 'early'], v: ['part', 'no', 'part', 'yes', 'part', 'part'] },
  { k: 'Runs on your existing ChatGPT or Claude plan', us: 'yes', v: ['yes', 'yes', 'part', 'yes', 'no', 'no'] },
  { k: 'Your data lives on your own PC', us: 'yes', v: ['no', 'yes', 'part', 'part', 'part', 'part'] },
  { k: 'No extra account with the tool maker', us: 'yes', v: ['yes', 'yes', 'yes', 'no', 'part', 'yes'] },
  { k: 'Acts in your apps, browser and files', us: ['yes', '', 'with full access to your PC'], v: ['part', 'yes', 'yes', 'yes', 'yes', 'part'] },
  { k: 'Built-in permission modes and limits', us: ['no', '', 'by design: text steers, nothing locks'], v: ['part', 'yes', 'part', 'part', 'part', 'part'] },
  { k: 'Settings, skills and memory as open files the AI can change', us: 'yes', v: ['no', 'part', 'part', 'no', 'part', 'part'] },
  { k: 'A finished app, no code', us: 'yes', v: ['yes', 'part', 'part', 'yes', 'part', 'no'] },
  { k: 'Maturity and track record', us: ['no', 'Young', 'agent releases since October 2026'], v: [['yes', 'Established'], ['yes', 'Established'], ['part', 'Newer'], ['part', 'Ahead of us'], ['yes', 'Established'], ['yes', 'Established']] },
];

const st = stOf('compare');
const LABEL = { yes: 'Yes', part: 'Partly', no: 'No' };
const cell = (x) => {
  const [kind, label, note] = Array.isArray(x) ? x : [x];
  return `<span class="${kind}">${label || LABEL[kind]}</span>${note ? `<span class="small muted" style="display:block;margin-top:4px">${note}</span>` : ''}`;
};

export default function compare(rel) {
  return page({
    slug: 'compare',
    rel,
    title: `${site.name} vs. ChatGPT, Codex, GenTeam, n8n and CrewAI`,
    description: `How ${site.name} compares to ChatGPT, Claude, Codex, Claude Code, OpenClaw, Genspark GenTeam, n8n, Zapier and CrewAI: what each does best and when to pick which.`,
    body: (root) => `
${pageHero({
  root,
  crumb: 'Compare',
  title: `Where ${site.name} fits. <em>And where it doesn’t.</em>`,
  lead: `Chat apps, coding agents, personal assistants, AI team workspaces, automation tools and agent frameworks all overlap with ${site.name} somewhere. This page shows where, what each of them does better, and when you should pick them instead.`,
  actions: `${downloadButton(root)}<a class="btn btn--ghost btn--lg" href="#table">See the table${icon('arrowDown', 'ic--move')}</a>`,
})}

<section class="section" id="table">
  <div class="wrap">
    <div class="head head--split">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">01</span> At a glance</span>
      <h2 class="h2" data-reveal style="margin-top:22px">Six kinds of tools. <em>Eleven questions.</em></h2></div>
      <p class="lead" data-reveal style="--d:1">Categories, not single products: individual tools differ, and all of them change quickly. Where another category does better, we say so.</p>
    </div>
    <div class="table-wrap" data-reveal>
      <table class="table" style="min-width:1120px">
        <caption class="sr">${site.name} compared with six categories of AI tools</caption>
        <thead><tr><th scope="col">What you get</th><th scope="col" class="us">${site.name}</th>${cats.map((c) => `<th scope="col"><a href="#${c.id}">${c.name}</a><br><span style="text-transform:none;letter-spacing:0">${c.ex}</span></th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr><th scope="row">${r.k}</th><td class="us">${cell(r.us)}</td>${r.v.map((x) => `<td>${cell(x)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="small muted" data-reveal style="margin-top:16px"><span class="yes">Yes</span> built in · <span class="part">Partly</span> with extra setup, in some products of the category, or only in part · <span class="no">No</span> not built in. Based on public product descriptions, November 2026.</p>
  </div>
</section>

<section class="section section--line">
  <div class="wrap">
    <div class="layout-doc">
      <nav class="toc" aria-label="On this page">
        <b>On this page</b>
        ${cats.map((c) => `<a href="#${c.id}">${c.name}</a>`).join('')}
        <a href="#behind">Where we are behind</a>
        <a href="#choose">How to choose</a>
      </nav>
      <div class="prose">
        <h2 id="chat-apps">${site.name} vs. chat apps</h2>
        <p>ChatGPT and the Claude desktop app are the best place to think out loud. You ask, they answer: writing, research, explaining, brainstorming. They are polished, mature, available on every device, and they get better every few months.</p>
        <h3>Where ${site.name} is different</h3>
        <p>A chat app waits for your next message. ${site.name} uses the same subscriptions, through OpenAI Codex for ChatGPT plans and Claude Code for a paid Claude plan, and turns them into agents that do not wait. A schedule, a timer, a new task, a message or an event wakes them up. They keep goals and open tasks between conversations, hand work to each other, and work in your browser and files on your own PC. Chats, tasks and memory live on your disk.</p>
        <h3>When to pick a chat app instead</h3>
        <p>When you want to talk something through, get a quick answer or write together, a chat app is simpler. It also works from anywhere, while ${site.name} agents only work while your computer is on. You can keep both: the chat app for conversations, ${site.name} for work that should get done while you do something else.</p>

        <h2 id="coding-agents">${site.name} vs. coding agents</h2>
        <p>OpenAI Codex and Claude Code are excellent at one focused job: reading a code base, changing it, running commands and checking the result. They come from the model providers themselves and improve quickly.</p>
        <h3>Where ${site.name} is different</h3>
        <p>${site.name} does not compete with them. It uses them as engines. Every agent’s work runs through the official Codex or Claude Code tool, signed in with your own account, each account in its own folder. The app does not read or copy those tokens. Around them it adds what a single coding session lacks:</p>
        <ul>
          <li>a persistent team with names, roles and delegation, and not only for code: research, marketing, finance and a private secretary;</li>
          <li>one inbox for tasks, My day for your own to-dos and calendar, and wake-ups on schedules and events;</li>
          <li>routing per task (engine, account, model and effort) across as many accounts as you like, with live quota bars;</li>
          <li>settings, skills and memory as open files, and a browser for each chat and each agent${st('browser-spaces')}.</li>
        </ul>
        <p>An agent can also move between Codex and Claude Code without losing context. One thing they have that ${site.name} does not: their own approval modes. ${site.name} runs them with approvals off.</p>
        <p>Some setups, such as OpenAI Symphony, feed a ticket queue to coding agents. ${site.name} needs no ticket system: you write or dictate into one inbox, and the work finds its owner.</p>
        <h3>When to pick a coding agent alone</h3>
        <p>If you are a developer with one clear coding job, use Codex or Claude Code directly. You get the most direct control in your terminal or editor, and nothing sits between you and the tool.</p>

        <h2 id="assistants">${site.name} vs. personal AI assistants</h2>
        <p>Hermes Agent, OpenClaw and Letta give you one persistent assistant that remembers you over time and can be shaped and extended by people who like to tinker. They have active communities and a head start on us.</p>
        <h3>Where ${site.name} is different</h3>
        <p>${site.name} is not one assistant but a whole organisation: a manager that builds the team, specialist agents, a private secretary, and you. Work has owners and lands in one task inbox. Your own to-dos and calendar sit in My day, and colleagues can join the same chats and tasks. It is a finished desktop app with a tray icon, and it keeps its own settings, skills and memory as files an agent can change.</p>
        <h3>When to pick a personal assistant instead</h3>
        <p>If one assistant is all you need, or you want a large community to tinker with, they are the better fit. ${site.name}’s source is public too, but its community is just starting.</p>

        <h2 id="team-workspaces">${site.name} vs. AI team workspaces</h2>
        <p>Genspark GenTeam puts people and AI agents into shared channels and coordinates the work through Genspark’s cloud, with credit tiers. It is the closest idea to ${site.name} on this page, and it is ahead of us on two things: collaboration between many people, and maturity.</p>
        <h3>Where ${site.name} is different</h3>
        <p>${site.name} keeps the coordination on your own PC. Chats, tasks and secrets sit on your disk. There is no account with us and no credits to buy from us: the app is a free download, and the AI work runs on your own plans, keys or local models. Colleagues you invite connect to your PC, and the data stays there. ${site.name} is also built for one person first, covering work, personal brand and private life, with a private secretary and My day next to the work.</p>
        <p>One thing is not a difference: running work through local tools on the plan you already pay for. GenTeam does that too.</p>
        <h3>When to pick GenTeam instead</h3>
        <p>If many people work with agents every day, from different places, and you want a service that does not depend on your own computer being on, GenTeam is the more mature choice today.</p>

        <h2 id="automation">${site.name} vs. automation tools</h2>
        <p>Zapier, n8n, Dify and similar tools run workflows: when this happens, do that. They are predictable, easy to test, and cheaper wherever no language model is needed. Their visual editors and libraries of integrations are hard to beat.</p>
        <h3>Where ${site.name} is different</h3>
        <p>You describe an outcome, not the steps. Agents decide how to get there, handle the case nobody drew a box for, and plan their own follow-ups. There is no flow to build or maintain. The price of that freedom: nothing guarantees the same path twice, and no step is locked.</p>
        <p>The two are not either-or. Zapier has an MCP server, and an agent can connect it${st('apps')}, so both can work side by side.</p>
        <h3>When to pick an automation tool instead</h3>
        <p>If the steps are known and must run exactly the same way every time, use an automation tool. The same goes for high-volume jobs that need no language model, such as syncing records between two systems, and for flows that have to run around the clock on a server.</p>

        <h2 id="frameworks">${site.name} vs. agent frameworks</h2>
        <p>CrewAI, LangGraph, AutoGen and the OpenAI Agents SDK, like Microsoft Agent Framework, Google ADK, Pydantic AI and smolagents, are building blocks for developers. They give full control over how agents reason, which tools they use and where they run.</p>
        <h3>Where ${site.name} is different</h3>
        <p>${site.name} is the finished product, not the parts. You download it, sign in and have a team, with chats, tasks and memory already built. No code. It runs on the ChatGPT and Claude plans you already pay for, where frameworks usually call model APIs billed per use. Agents you already defined as Claude Code subagents, in a Codex AGENTS.md or in a CrewAI YAML file can be brought in.</p>
        <h3>When to pick a framework instead</h3>
        <p>If you are building agents into your own product or service, need a custom architecture, or have to deploy on servers, use a framework. ${site.name} is for working with a team of agents, not for building one into software.</p>

        <h2 id="behind">Where ${site.name} is behind</h2>
        <p>${site.name} is young. You should know what that means before you install it.</p>
        <ul>
          <li><strong>Young.</strong> The releases with the full agent company date from October 2026. Most features are proven by automated tests; testing on real devices, with real accounts and over whole nights is still under way.</li>
          <li><strong>Not signed.</strong> Version <span data-rel="windows-v">${rel.windows.version}</span> is not code-signed, so Windows and macOS warn you and you confirm by hand. On macOS agents cannot control the computer${release.renamed ? ', and the Mac update that replaces itself has not run on a real Mac yet' : ', and updates are a manual download for now'}.</li>
          <li><strong>No guard rails in the app.</strong> Agents have full access to your PC, and only text steers them. If you want permission modes and spending limits enforced by the tool, this is the wrong tool.</li>
          <li><strong>A vague request is still a gamble.</strong> How much an agent does on its own varies by model and by run. Sometimes it asks where it could have found out.</li>
          <li><strong>Your PC has to be on.</strong> Agents keep working from the tray with the window closed, but only while your computer is on.</li>
          <li><strong>Built for one person first.</strong> You can invite colleagues, but this is early; products built for teams are further along.</li>
          <li><strong>Young open-source project.</strong> The source code is public under Apache-2.0 on <a href="${release.repoUrl}" rel="noopener">GitHub</a>, but it has no outside audit and few contributors yet.</li>
        </ul>
        <p>The full, labelled list is on the <a href="${root}product/">product page</a>. What agents can reach and what is not proven is on the <a href="${root}access/">access page</a>.</p>

        <h2 id="choose">How to choose</h2>
        <ul>
          <li><strong>Talk, write or think something through:</strong> a chat app.</li>
          <li><strong>One coding job in one repository:</strong> Codex or Claude Code on its own.</li>
          <li><strong>One assistant you want to shape yourself:</strong> a personal assistant such as Hermes Agent, OpenClaw or Letta.</li>
          <li><strong>Many people and agents in shared channels, in the cloud:</strong> Genspark GenTeam.</li>
          <li><strong>Fixed steps that must run the same way every time:</strong> an automation tool.</li>
          <li><strong>Agents inside your own product:</strong> a framework.</li>
          <li><strong>A team of agents that takes work off your plate on its own, on your own PC and your own plans, with full access and open files:</strong> ${site.name}.</li>
        </ul>
        <div class="callout">${icon('refresh')}<div><strong>Based on public product descriptions, November 2026.</strong> Products change quickly; <a href="${maker.feedbackUrl}" rel="noopener">tell us if something here is out of date</a>. Product names belong to their owners; naming them implies no endorsement.</div></div>
      </div>
    </div>
  </div>
</section>

<section class="section section--paper2">
  <div class="wrap">
    <div class="head head--split" style="margin-bottom:0">
      <div><span class="eyebrow" data-reveal><span class="eyebrow__n">02</span> Try it</span>
      <h2 class="h2" data-reveal style="margin-top:22px">See for yourself, <em>on your own plans.</em></h2></div>
      <div data-reveal style="--d:1">
        <p class="lead">A free download with no account and no subscription from us. You need a ChatGPT plan, a paid Claude plan, an API key or a local model.</p>
        <div class="btns" style="margin-top:28px">${downloadButton(root)}<a class="btn btn--ghost btn--lg" href="${root}how-it-works/">How it works${icon('arrow', 'ic--move')}</a></div>
      </div>
    </div>
  </div>
</section>`,
  });
}
