// Owns: /how-it-works/: the short start, the manager and its agents on the PC, plans and open files (HowTo).
// Never: capability facts (data/features.mjs) or release facts (config.mjs).
import { site, release } from '../config.mjs';
import { page, pageHero, esc, downloadButton, abs, legend, stOf } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { featureById } from '../data/features.mjs';

// Status labels come from data/features.mjs, so a status changes in one place.
const st = stOf('how-it-works');

// [id, label in the table of contents, heading in the text]
const sections = [
  ['start', 'The short start', 'The short start'],
  ['org', 'The organisation', 'The organisation'],
  ['work', 'How work comes in', 'How work comes in'],
  ['wake', 'Waking up on their own', 'Agents wake up on their own'],
  ['engines', 'Engines', 'Engines: the AI you already pay for'],
  ['open', 'The open system', 'The open system: files instead of connectors'],
  ['browser', 'The browser', 'A browser in three places'],
  ['tools', 'Reaching your tools', 'Reaching your tools'],
  ['memory', 'Skills and memory', 'Skills and memory'],
  ['steering', 'What steers agents', 'What steers agents'],
  ['where', 'Where everything lives', 'Where everything lives'],
  ['day', 'A day in practice', 'A day in practice'],
  ['setup', 'Getting started', 'Getting started'],
];
const h2 = (id) => `<h2 id="${id}">${sections.find((s) => s[0] === id)[2]}</h2>`;

const roles = [
  { icon: 'team', h: 'The manager', p: 'Takes your goals, turns them into tasks and hands each one to the right colleague. It also builds the team you need.' },
  { icon: 'layers', h: 'Specialists', p: 'Research, marketing, finance, your website. Each one does its part, asks colleagues for help and reports back when the work is done.' },
  { icon: 'sun', h: 'Your secretary', p: 'A private secretary for your side of things: your day, your calendar and the personal tasks that otherwise slip.' },
];

// The setup steps. Rendered on the page and as HowTo data, so both always match.
function setupSteps(rel) {
  const short = featureById['short-start'].status === 'available';
  return [
    { name: 'Download the installer', text: `Get the free download from the download page: Windows (about ${rel.windows.sizeMb} MB), macOS or Linux. No account needed.` },
    { name: 'Install it', text: 'It is not signed, so your system warns you. On Windows choose More info, then Run anyway. On macOS follow the Open Anyway steps on the download page.' },
    { name: 'Connect one AI', text: 'Sign in through the provider’s official tool: Codex for a ChatGPT plan, Claude Code for a paid Claude plan. The app can install either for you and tests it with a real answer. An API key or a local model works too.' },
    { name: 'Type your name and company', text: short ? 'Press Start. The manager gets to know you and your work and first asks how far it may go.' : 'From the next release that is all: press Start, and the manager gets to know you and first asks how far it may go. In the current release you also write a first request here.' },
    { name: 'Answer, then hand over work', text: 'Answer the question, tell the AI what you want off your plate, and type or dictate tasks into Work or simply into the chat.' },
  ];
}

export default function (rel) {
  const url = abs('how-it-works');
  const steps = setupSteps(rel);
  const { app } = release;

  return page({
    slug: 'how-it-works',
    rel,
    title: 'How it works',
    description: `How ${site.name} works: a short start, an AI manager, specialist agents and a secretary on your own PC that wake up on their own, run on your ChatGPT or Claude plan, and keep settings, skills and memory as open files.`,
    ld: [{
      '@type': 'HowTo',
      '@id': `${url}#howto`,
      name: `How to set up your AI company with ${site.name}`,
      description: `Install ${site.name}, connect the ChatGPT or Claude plan you already have, type your name and company, and answer your manager’s first question.`,
      inLanguage: site.lang,
      isPartOf: { '@id': `${url}#webpage` },
      tool: [
        { '@type': 'HowToTool', name: 'A PC with Windows, macOS or Linux' },
        { '@type': 'HowToTool', name: 'A ChatGPT plan, a paid Claude plan, an API key or a local model server' },
      ],
      step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text, url: `${url}#setup-${i + 1}` })),
    }],
    body: (root) => `
${pageHero({
  root,
  crumb: 'How it works',
  title: `How ${site.name} <em>works.</em>`,
  lead: `Not a chatbot with extra buttons, but a small organisation on your own PC: a manager, specialists and a secretary who take work in, wake up on their own, think with the AI plans you already pay for, and keep everything they know in files you can open.`,
  actions: `${downloadButton(root)}<a class="btn btn--ghost btn--lg" href="${root}product/">All capabilities${icon('arrow', 'ic--move')}</a>`,
})}

<section class="section section--tight">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="On this page"><b>On this page</b>${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>

    <div style="min-width:0">
      ${legend(rel)}

      <div class="prose">
        ${h2('start')}
        <p>There is little to fill in${st('short-start')}. After a short tour you connect one AI and type your name and company. Press Start, and the app posts one automatic line in your manager’s chat, marked as the app’s start text: you just set this up, get to know me and my work, on the web and on this PC, and first ask me what you may do.</p>
        <p>So the first thing you see is the manager’s question: full access to this PC for good, this one search including private files just this once, or less. It says plainly that it technically can already. <a href="${root}access/#first-question">The choice is a question, not a barrier.</a> Then it goes as deep as your answer allows, and shows you what it still needs: a decision model and an embedding model. It can set those up with you.</p>

        ${h2('org')}
        <p>${site.name} is built like a small company, not like a single assistant. You are the owner. You start with a manager, and the manager builds the team you need. Every agent has a name, an avatar and its own instructions in a file.</p>
      </div>

      <div class="cards" style="margin-top:32px">
        ${roles.map((r, i) => `<article class="pcard" data-reveal style="--d:${i}">${icon(r.icon)}<h3>${r.h}</h3><p>${r.p}</p></article>`).join('')}
      </div>

      <div class="prose" style="margin-top:32px">
        <p><strong>People</strong>${st('people')}: invite colleagues by link or QR code to work in the same chats and tasks as your agents. People are round and AI is square, so you can tell at a glance who is human.</p>
        <p><strong>Delegation</strong>${st('delegate')} is the point of the structure. Tell the manager what you want. It splits the job and hands the parts to specialists, who ask each other for help and report back when they are done. An agent can also split itself${st('split')} into parallel parts when the work allows it.</p>
        <p>Already have agents? Hand your manager${st('import')} Claude Code subagents, a Codex <code>AGENTS.md</code> file, a CrewAI YAML file or a list of roles, and a skill shows it how to bring them in.</p>

        ${h2('work')}
        <p>Work reaches your company in three places.</p>
        <h3>Chats${st('chats')}</h3>
        <p>Talk to an agent one-to-one or in a group, like in a messenger. Every agent has a direct chat, and you can open as many more as you like. You can keep typing while an agent works. If something changes halfway, mark your message as important: it steers the work that is already running. Messages can be normal, important or quiet${st('rooms')}, in both directions, and every reply shows which model wrote it. The message box can also send later or on a schedule${st('schedule')}.</p>
        <h3>Work${st('work-inbox')}</h3>
        <p>One inbox for every task. Type or dictate. With Auto your manager takes it and decides who does it; or pick an agent yourself, or Me for your own list. The manager can split a dictated list: “research the three closest competitors, draft Friday’s newsletter, call the printer” can become one task for research, one for marketing and one on your own list. That is its judgement, not a fixed step.</p>
        <h3>My day${st('my-day')}</h3>
        <p>Your to-dos and your calendar in one calm list. It learns how long things take you, makes a morning plan and gives you a short briefing of what happened. Team${st('team-view')} shows every agent and person and what they are doing.</p>
        <p>The calendar${st('calendar')} reads ICS feeds or connects to Google Calendar both ways (not yet tested against a real Google account). And a to-do can turn into the tool it needs${st('widgets')}: a recorder, a teleprompter, a timer or a form.</p>
        <p>Next to every chat sits a strip of tabs like Chrome’s${st('side-tabs')}, for websites and for the app’s own views: My day, Work, Activity, Notes, Media, Files, Screen and an agent’s browser.</p>

        ${h2('wake')}
        <p>This is what makes ${site.name} proactive. An agent does not wait for a prompt. It sleeps until one of five things wakes it${st('wake')}:</p>
        <ul>
          <li><strong>A message</strong> from you, a colleague or another agent.</li>
          <li><strong>A task</strong> that lands on its list.</li>
          <li><strong>A timer</strong> it set itself, such as “check the upload again in an hour”.</li>
          <li><strong>A schedule</strong>, such as every weekday at 7:30.</li>
          <li><strong>An event</strong> it is waiting for, such as new mail${st('email')}.</li>
        </ul>
        <p>Awake, the agent looks at the situation, decides what to do and does it. It can plan its own follow-up: a timer, a next step, a question for a colleague. That is how a briefing gets written at 7:30 without anyone asking. Close the window and the company keeps running from the system tray${st('tray')}, as long as your computer is on.</p>
        <ul>
          <li><strong>Keep agents running</strong>${st('keep-running')}: optional, off by default (Start with Windows or Start at login in Settings). The app starts when you sign in and comes back after a crash.</li>
          <li><strong>Results checked against the goal</strong>${st('verify')}: a task with a done-condition gets its result checked by a decision model that does not see the agent’s conversation. Without one, the result stays marked unchecked.</li>
          <li><strong>Picks work up again</strong>${st('resume')}: after a lost connection, a used-up plan or a restart, the retry tells the agent what happened and what changed.</li>
        </ul>
        <p>One honest note: agents wake up reliably, but how much they do on a vague request still varies by model and by run. Sometimes they ask where they could have found out.</p>

        ${h2('engines')}
        <p>${site.name} does not sell you AI. Agents think with the plans you already have, through each provider’s official command-line tool, signed in with your own accounts:</p>
        <ul>
          <li><strong>A ChatGPT plan</strong> through OpenAI Codex${st('plans')}.</li>
          <li><strong>A paid Claude plan</strong> through Claude Code. Claude Free cannot run agents.</li>
          <li><strong>Gemini CLI, GitHub Copilot CLI and Kimi Code</strong>${st('acp-plans')} over the Agent Client Protocol. Built, but we have never seen them in a live run.</li>
          <li><strong>API keys and local models</strong>${st('apis')}: OpenAI, Anthropic, Google, OpenRouter and others, Ollama, LM Studio, llama.cpp, vLLM. Early: built, no recorded live run.</li>
        </ul>
        <p>Add as many accounts per provider as you like. Every turn gets an engine, an account, a model and an effort level${st('routing')}, and live quota bars show how much of each plan is left. You choose Best, Balanced or Cheaper.</p>
        <ul>
          <li><strong>Use it before you lose it</strong>${st('use-it')}: among accounts of the same priority, the plan quota that resets soonest goes first.</li>
          <li><strong>Switch engines without losing context</strong>${st('switch')}: when an agent moves between Codex and Claude Code, its session is rebuilt from a shared context ledger.</li>
          <li><strong>Lean context</strong>${st('lean')}: tools load only when needed, and long old output can be compacted or hidden and brought back.</li>
          <li><strong>A model for each use</strong>${st('uses')}: work, decisions, voice, speech, images, video, music, sound effects and embeddings each have a row with provider and model.</li>
        </ul>

        ${h2('open')}
        <p>Most agent apps grow by adding connectors. ${site.name} goes the other way: what the person or the AI may change is a plain file, and the running app can be called by any program. So the AI does not wait for a feature; it edits a file or writes a small script.</p>
        <ul>
          <li><strong>Settings</strong>${st('settings-file')}: <code>settings.json</code> holds every setting with a comment above it. Change a value and it applies within a second. So you can say “turn off the sound after nine” and your agent does it. The settings pages${st('settings-pages')} sit on the same file, and each one opens it.</li>
          <li><strong>Providers</strong>${st('providers-file')}: every API connection is one entry in that file, with a name, an address, a protocol (<code>openai-chat</code>, <code>openai-responses</code>, <code>anthropic</code>, <code>decision</code>) and a key as a <code>secret://</code> ID. A provider the app has never heard of works if it speaks one of these. Say “here is my DeepInfra key”; the AI can look up the address and protocol, pick a model and write the entry.</li>
          <li><strong>The AI builds its own connections</strong>${st('own-connections')}: there is no WhatsApp button. Your agent sets it up with a small script next to the app, which links your WhatsApp as a device and talks to one chat. Telegram works through a bot it creates. Other channels, such as Signal, are the same kind of script: skills ship for WhatsApp and Telegram, and ${release.renamed ? 'one' : 'the next release adds one'} that shows how for any other channel.</li>
          <li><strong>Calling the app</strong>${st('protocol')}: everything the window can do, a program can do too, with the <code>wf</code> command line or plain HTTP to the running app.</li>
          <li><strong>Files in a tab</strong>${st('file-tab')}: a plain editor and folder list beside the chat, for any path on your PC.</li>
          <li><strong>See what is sent</strong>${st('see-prompt')}: <code>last-prompt.md</code> in each agent’s folder holds the whole system prompt of its last turn. Every shipped prompt can be replaced by an own version in <code>prompts/</code>.</li>
          <li><strong>The look</strong>${st('theme')}: <code>theme.css</code> sits on top of the app’s own styles and applies at once.</li>
        </ul>

        ${h2('browser')}
        <p>Browsing has three places${st('browser-spaces')}, and an agent says which one it means:</p>
        <ul>
          <li><strong>Global:</strong> where you work. Any AI may use it, and work in the other two places leaves it alone.</li>
          <li><strong>A chat’s browser:</strong> tabs shared by everyone in that chat, group chats included. Open the chat’s globe and you see them live.</li>
          <li><strong>An agent’s own:</strong> its off-screen Chrome or Edge${st('browser')}, for what nobody else needs to see. You can watch it in a live view and take over.</li>
        </ul>
        <p>Tabs are saved in one file, <code>side-tabs.json</code>, so they survive a restart and an agent can edit them too.</p>

        ${h2('tools')}
        <p>An agent that cannot touch your tools is only a consultant. These ones can act:</p>
        <ul>
          <li><strong>Computer use</strong>${st('computer')}: on Windows agents prefer UI Automation over raw clicks, and your own mouse and keyboard win. On Linux it runs over AT-SPI, with input on X11 only. On macOS agents get screenshots but cannot control the computer. Basic for now.</li>
          <li><strong>Your Android phone</strong>${st('android')} over ADB.</li>
          <li><strong>Connected apps</strong>${st('apps')} through the <a href="https://modelcontextprotocol.io/" rel="noopener">Model Context Protocol</a>: one file, <code>connectors/mcp.json</code>, in the format other agent tools use. Agents find a server and write the entry. Settings › Apps${st('apps-page')} adds a catalog of 17 services such as Notion, Linear, GitHub and Zapier.</li>
          <li><strong>Any REST API</strong>${st('rest')}: no connector needed. An agent calls it with the key as an ID in the header, or writes a small script.</li>
          <li><strong>Email</strong>${st('email')}: your own mailbox over IMAP and SMTP with an app password (Gmail, GMX, iCloud and others; not Outlook or Microsoft 365 yet). Not yet tried on a real mailbox.</li>
          <li><strong>Telegram</strong>${st('telegram')}: mirror a chat through your own bot.</li>
        </ul>

        ${h2('memory')}
        <p>Chats end. What your company learned should not. Both of these are plain files.</p>
        <ul>
          <li><strong>Skills</strong>${st('skills-files')} are few and important: ways of working, each a folder with a <code>SKILL.md</code>. The description is what most readers see; a few are marked so that it is in every prompt. Each skill has a route: an agent’s own, its managers’, shared or built-in. An agent can also read skills from the folders of other tools, such as <code>.agents</code>, when it chooses to, and it writes new skills itself, with a skill on how to write them.</li>
          <li><strong>Memory</strong>${st('memory-files')} is the library: one Markdown file per entry, in folders for the company, a branch or a single agent. Open it, change it, version it. A change is searchable at once.</li>
          <li><strong>Search by meaning</strong>${st('vectors')}: memory and any folder an agent chooses. A small local model does this on your PC, or an embedding provider you pick.</li>
          <li><strong>A subconscious</strong>${st('subconscious')} beside each agent looks through memory around a turn, notes what people state and tidies long context. What it finds reaches the agent as if it had looked it up itself. It depends on the decision model, which is not always reliable yet.</li>
          <li><strong>Context ledger</strong>${st('ledger')}: every part of an agent’s working context has a stable ID, and what was compacted or hidden can be brought back.</li>
        </ul>

        ${h2('steering')}
        <p>There is no permission system. Agents have full access to your PC, and what steers them is text: the rules every agent gets, its <code>SYSTEM.md</code>, skills such as the one on spending${st('money-skill')}, what it remembers and what you say. The texts give reference points and leave the thinking to the model, because a bare rule mostly makes a model stop and ask.</p>
        <div class="callout">${icon('bolt')}<p><strong>Please read the access page before you install.</strong> What agents can reach, how secrets are kept out of prompts, what leaves your PC, the brake, and what is not proven yet. <a href="${root}access/">Access and data</a></p></div>

        ${h2('where')}
        <p>Your company is a folder on your own disk.</p>
        <dl class="kv">
          <dt>Your company</dt><dd>Chats, tasks, runs and accounts in a local database; agents, memory, settings and connectors as plain files in the data folder.${st('local')}</dd>
          <dt>Passwords, keys</dt><dd>Encrypted by your operating system. Agents use <code>secret://</code> IDs, and values stay out of prompts.${st('vault')}</dd>
          <dt>AI sign-ins</dt><dd>Kept by the official Codex and Claude Code tools, one folder per added account. The app does not read the tokens.</dd>
          <dt>Your phone</dt><dd>The Android app joins your company by your PC’s Remote ID, in any network. An iPhone opens the web app your PC serves, over Wi-Fi or Tailscale.${st('phone')}</dd>
          <dt>Other PCs</dt><dd>Connected by Remote ID; your own PCs mirror each other, so agents can work where the files are.${st('remote')}</dd>
          <dt>Our servers</dt><dd>None holds your data. One meeting server of ours helps your devices find each other; what passes through it is end-to-end encrypted, and devices talk directly where the network allows. You can run your own instead.</dd>
        </dl>
        <p>The exact folders are on the <a href="${root}access/#data">access page</a>: on Windows <code>${app.dataFolder.windows}</code> and <code>${app.workspace}</code>.</p>

        ${h2('day')}
        <p>An illustration:</p>
        <ul>
          <li><strong>07:30</strong> My day has your plan and a short briefing: Ivo, your research agent, finished the competitor overview overnight, and Noa in finance has a question about an invoice. You answer from your phone.</li>
          <li><strong>09:00</strong> You dictate three things into Work. Your manager turns them into a research task for Ivo, a newsletter draft for Lena and a call on your own list.</li>
          <li><strong>11:00</strong> Lena asks Ivo for two numbers, then posts her draft. You send one remark marked important, and she adjusts while she works.</li>
          <li><strong>15:00</strong> Kai checks your website in his own browser. You watch the live view and take over for a minute.</li>
          <li><strong>18:00</strong> You close the window. The company keeps running in the tray, and at 22:00 a schedule wakes Mara, your manager, to plan tomorrow.</li>
        </ul>
        <p>You did not route a single task yourself, and nothing went through a server of ours.</p>

        ${h2('setup')}
        <ol>
          ${steps.map((s, i) => `<li id="setup-${i + 1}"><strong>${esc(s.name)}.</strong> ${esc(s.text)}</li>`).join('\n          ')}
        </ol>
        <p>Links, checksums and the steps for each system are on the <a href="${root}download/">download page</a>. Questions first? Read the <a href="${root}faq/">FAQ</a>.</p>
      </div>

      <div class="btns" style="margin-top:56px">
        ${downloadButton(root)}
        <a class="btn btn--ghost btn--lg" href="${root}product/">See all capabilities${icon('arrow', 'ic--move')}</a>
      </div>
    </div>
  </div>
</section>`,
  });
}
