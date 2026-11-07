// The generated maps of the open data folder: <data>/README.md – every entry, what it is and what editing it does
// (also the derived chats/ folder), the app-managed entries, the workspace and how any program or agent controls the
// running app (wf call / POST /rpc with runtime.json), the other companies on this PC (B-072) – and <data>/agents/README.md – name → folder, role, reports
// to. Written at start and again when the team changes ('agent.upserted' / 'agent.removed'; the person's name:
// 'settings.updated' – gathered for GATHER_MS), only when the text changes, as the app's own writes.
// Agents learn the map from one stable-prompt line ("Data folder: …").
// Owns: both texts and when they are written. Never: a token, secret or file content in them.

import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Logger } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { ROOT_AGENTS, ROOT_BROWSER_HISTORY, ROOT_BROWSER_ZOOM, ROOT_CHATS, ROOT_MODES, ROOT_PROMPTS, ROOT_README, ROOT_SECRETS, ROOT_SETTINGS, ROOT_SIDE_TABS, ROOT_THEME, ROOT_CONNECTORS, ROOT_PAGES } from './layout.ts';
import { canonical, readText, writeAtomic, type OwnWrites } from './text-doc.ts';
import { SETTINGS_SCHEMA_FILE } from '../settings/schema.ts';

/** Team changes are gathered this long before agents/README.md is written again. */
export const GATHER_MS = 1000;
const MAX_BYTES = 512 * 1024;

export interface MapPaths {
  data: string;
  workspace: string;
}

/** The text of <data>/README.md. */
export function rootReadme(paths: MapPaths): string {
  const rows: Array<[string, string, string]> = [
    [ROOT_README, 'This map.', 'Nothing – the app writes it again at every start.'],
    [ROOT_SETTINGS, `Every setting of the app with its current value: profile, theme, notifications, window, voice, models, API connections, My day, calendar, devices and phones, reports, data retention. Above each key a comment line names what it does, the allowed values and the default. ${SETTINGS_SCHEMA_FILE} beside it (written by the app) describes the same keys for editors and scripts.`, 'Change a value and save: it applies within a second (null or a missing key means the default). An invalid value keeps its last good value, the reason stands above it and the app shows a quiet notice. The app writes the file whole again after each change, so the comments stay current. Skill: app-settings.'],
    [`${ROOT_AGENTS}/`, 'One folder per agent: SYSTEM.md (its whole standing text: the team\'s "How I work", its role, what it has here), skills/<name>/SKILL.md (its main skills), agent.json (its label and home project), access.json (AF-013: its access mode – read, ask, project or full – and rules; without it the agent has full access; an agent made from a folder, AF-014, starts with project), avatar.png or avatar.jpg (a copy of its picture), last-prompt.md (the whole system prompt the app sent on its last turn) and last-run.md (what it did on that turn: input, each tool call and result, final text). agents/README.md says who is who.', 'A change to SYSTEM.md or a main skill applies at once. The picture copy, last-prompt.md and last-run.md are written again by the app; editing them changes nothing. To change what is sent: SYSTEM.md, or an own version in prompts/.'],
    [`${ROOT_PROMPTS}/`, 'Own versions of the shipped prompts: identity.md, rules.md (how every agent works), skills.md, compaction.md, onboarding.md, agent-default.md (the standing rules every new agent starts with) and subconscious.md (what the subconscious does and keeps). updates/ holds full reference texts offered after app updates.', 'A file here replaces the shipped prompt of that name; deleting it brings the shipped one back. Untouched defaults follow app updates; custom versions stay and their agent (the manager for team-wide prompts) gets a review request to adopt or adapt the new default.'],
    [`${ROOT_MODES}/`, 'Own modes (<key>.md): the tools and skills for one kind of work.', 'A mode here replaces a shipped mode with the same key.'],
    [`${ROOT_SECRETS}/`, 'The secrets catalog, one file per route (<route>.md: each entry\'s id, name, description, tags, source) – never a value.', 'Name and purpose change; values stay encrypted in the app.'],
    [`${ROOT_CONNECTORS}/`, 'mcp.json (MCP servers), mail.json (mailboxes) and status.json (written by the app: what is connected).', 'A change connects or disconnects at once. The skill connect-apps explains the files.'],
    ['memory/', 'What the company, its branches and each agent know: one Markdown file per entry (frontmatter title, kind, tags, updated, source + the text), in company/, branches/<space>/, agents/<agent>/, references/<person>/ and free topic subfolders. _folder.md describes a folder; a file in a pinned/ subfolder is always in the prompt of who reads the folder.', 'Any change is findable with vector.search at once. Skill: memory.'],
    [ROOT_THEME, 'The app\'s look: CSS on top of the app\'s own styles (its colours are CSS variables such as --surface, --text, --sidebar, --focus; dark mode is :root[data-theme=dark]).', 'Applies at once in the window and on phones. Delete the file to go back to the shipped look. The skill app-look explains it.'],
    [`${ROOT_PAGES}/`, 'Views anyone adds to the app: <name>.html or <name>.js. Each is listed on the "+" page of every tab area (the global pane, each chat\'s area above its messages) and opens as a tab, in a frame that reaches the app with wf.rpc(method, params). A panel {"id":"page:<name>","panel":"page","name":"<name>"} in side-tabs.json opens one too.', 'A new file shows up at once, an open page reloads when its file changes, a deleted file is gone. The skill app-data-model explains it.'],
    [ROOT_SIDE_TABS, 'The tabs of the global pane at the window\'s right (global, where the person works) and of each chat\'s area above its messages (chat:<chat id>, shared by everyone in that chat) and of each agent\'s own area on its agent page (agent:<agent id>, the agent keeps it): {"version":2,"spaces":{"global":{"shown":"<tab id>","tabs":[…]},"chat:<chat id>":{…}}}. A tab is a website {"id":"web-…","url":"…","by":"<agent id>"} or one of the app\'s panels {"id":"day","panel":"day"} (day, work, activity, screen; notes and video with conversationId, agent with agentId, media with fileId or path – or neither: the media library, id media –, file and folder with path, page with name; the id is the panel with what it shows, as notes:<chat id>). With linked CEO PCs the areas are the same on all of them and on the phone: a website of another PC is {"id":"remote:<device>:<web id there>","panel":"remote","device":"<device id>","tab":"<web id there>","url":"…"}, and a file, folder or media tab of another PC carries "device" (id file@<device>:<path>); without device a tab is this PC\'s.', 'Add, remove, reorder or re-address a tab and save: the window follows within a second, and linked PCs too. browser.tabs lists them live.'],
    [ROOT_BROWSER_HISTORY, 'The pages the person opened in the app\'s browser tabs (the global pane and the chats\' areas), oldest first: {"version":1,"entries":[{"url":"…","title":"…","at":<ms>,"visits":<n>}]}. Up to 5,000 addresses, none with a token or a credential in it.', 'The app rewrites it while it runs and reads it at the next start. Clear history in the browser\'s menu empties it.'],
    [ROOT_BROWSER_ZOOM, 'The browser\'s zoom per site: {"version":1,"sites":{"<host name>":<percent>}}, one of Chrome\'s steps from 25 to 500; a site at 100 has no entry.', 'The app reads it at the next start.'],
    [`${ROOT_CHATS}/`, 'A readable copy of the chats: one folder per chat with chat.json (title, members) and messages/<year>-<month>.jsonl (one line per message); chats/README.md explains the format.', 'Nothing – the database is the original and the app writes these files again.'],
  ];
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  return [
    '# Autark folder',
    '',
    `This folder holds the app's data on this PC: ${paths.data}`,
    'Plain files here can be read and changed by the person and by agents with any editor or tool; the app takes changes over by itself.',
    '',
    '| Entry | What it is | What editing does |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
    '## Managed by the app',
    '',
    'workforce.db (the database: chats, tasks, runs, accounts), blobs/ (stored files), accounts/ (sign-in folders of the CLIs), logs/, tmp/, backups/, exports/, browser-profiles/, engine-cwd/, bin/ (the agents\' wf command, kept up to date by the app), runtime.json (port and owner token of the running app), boot.json (start-up checks), run-state.json, next-due.json and launcher.json ("Keep agents running": how the app last ended, the next scheduled work, the start task), git-no-hooks/, window-state.json, before-restore-<time>/ (the data a restore replaced) with restore-result.json, settings.v7-backup.json (an old settings store, after its import), keyring-name and identity-move-pending (left by the move from the old product name). Other files here belong to the window (Electron).',
    '',
    '## Workspace',
    '',
    `${paths.workspace} – projects, downloads/, inbox/. Shared skills: skills/<name>/SKILL.md there.`,
    '',
    '## Controlling the running app',
    '',
    'Everything the app window can do, a program or an agent can do too. runtime.json here holds {port, token} while the app runs:',
    '- the wf command line client: wf call <method> [json params] (also wf chats, wf send, wf todos, wf export); it finds the app through this folder;',
    '- or plain HTTP: POST http://127.0.0.1:<port>/rpc with the header "Authorization: Bearer <token>" and the body {"id":1,"method":"<method>","params":{…}}.',
    'The method rpc.methods lists every method with its params (params {"match":"chat"} narrows it and spells out the types).',
    'Other companies on this PC each have a data folder of their own (the first is the app\'s folder, the others lie in "Autark Companies/<id>" beside it): wf call companies.list names them; companies.open {"id":"<id>"} switches to one (its window opens, this one goes to the tray and keeps working), {"create":true} starts a new one.',
    'An agent acts in another of these companies right from its own chat: tools.call {"name":"<tool>","args":{…},"company":"<name or folder from companies.list>"} runs that tool there.',
    '',
  ].join('\n');
}

/** The text of <data>/agents/README.md (archived agents last). */
export function agentsReadme(agents: readonly Agent[], personName: string): string {
  const person = personName.trim() || 'The person';
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cell = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const boss = (agent: Agent) => (agent.managerId && agent.managerId !== HUMAN_ID ? byId.get(agent.managerId)?.name ?? agent.managerId : person);
  const row = (agent: Agent) => `| ${cell(agent.name)} | ${agent.id}/ | ${cell(agent.role || '–')} | ${cell(boss(agent))} |`;
  const active = agents.filter((agent) => agent.archivedAt === undefined);
  const archived = agents.filter((agent) => agent.archivedAt !== undefined);
  return [
    '# Agents',
    '',
    'Who is who in this folder. The app writes this list when the team changes. Each folder holds SYSTEM.md (the agent\'s instructions) and skills/ (its main skills).',
    '',
    '| Name | Folder | Role | Reports to |',
    '|---|---|---|---|',
    ...active.map(row),
    ...(archived.length ? ['', '## Archived', '', '| Name | Folder | Role | Reported to |', '|---|---|---|---|', ...archived.map(row)] : []),
    '',
  ].join('\n');
}

/** Writes `text` to `file` unless it already says that; true when written. */
export function writeMap(file: string, text: string, writes?: OwnWrites): boolean {
  const read = readText(file, { maxBytes: MAX_BYTES });
  if (read.kind === 'ok' && read.text === canonical(text)) return false;
  writeAtomic(file, text, writes);
  return true;
}

export interface RootMapsDeps {
  paths: MapPaths;
  bus: Pick<Bus, 'on'>;
  log: Logger;
  agents(): Agent[];
  personName(): string;
  writes?: OwnWrites;
}

/** Keeps both maps current; start() writes them and follows team changes; stop() ends that. */
export class RootMaps {
  private readonly deps: RootMapsDeps;
  private timer?: NodeJS.Timeout;
  private off: Array<() => void> = [];

  constructor(deps: RootMapsDeps) {
    this.deps = deps;
  }

  get readme(): string {
    return path.join(this.deps.paths.data, ROOT_README);
  }

  start(): void {
    this.writeRoot();
    this.writeAgents();
    const later = () => this.later();
    // settings.updated: the person's name heads "Reports to" (written only when the text changes).
    this.off = [this.deps.bus.on('agent.upserted', later), this.deps.bus.on('agent.removed', later), this.deps.bus.on('settings.updated', later)];
  }

  stop(): void {
    for (const off of this.off) off();
    this.off = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The root map now (written when it is missing or out of date); never throws. */
  writeRoot(): boolean {
    try { return writeMap(this.readme, rootReadme(this.deps.paths), this.deps.writes); } catch (error) {
      this.deps.log.warn('README.md of the data folder not written', { error: String(error) });
      return false;
    }
  }

  /** The agents map now; never throws. */
  writeAgents(): boolean {
    try {
      const file = path.join(this.deps.paths.data, ROOT_AGENTS, ROOT_README);
      return writeMap(file, agentsReadme(this.deps.agents(), this.deps.personName()), this.deps.writes);
    } catch (error) {
      this.deps.log.warn('agents/README.md not written', { error: String(error) });
      return false;
    }
  }

  private later(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.writeAgents(); }, GATHER_MS);
    this.timer.unref?.();
  }
}
