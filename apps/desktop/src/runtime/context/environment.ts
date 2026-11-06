// "## My environment" (B-047 D6): the agent's self-description - true facts about where it runs and what it can
// reach, built from the real tool offer, for every agent and every mode. Two parts:
// - stable (environmentSection, the stable prompt after "My folder"): this PC (OS, PC name), the language line and the
//   person's profile.notes, the connected models with price and smarts (B-078), the workspace path, how
//   the agent searches the web this turn (its engine's own search first – E1), whether browser / computer tools are offered, that tools.find / tools.call
//   reach more tools (B-049 F4) and that it may split itself (B-057 S17) - the same agent, mode and engine give the
//   same text;
// - volatile (environmentNow, prompt-volatile.ts): the whole PC is the team's, the data folder and its map, the
//   accounts that need a sign-in (labels only) and the connected apps whose tools the turn offers; E1: where the person's
//   own files are (homeLine); B-075: the companies on this PC and the linked PCs (companiesLine). Never a memory list or
//   count (constant cost at any size).
// Also the has_<tool> flags of the identity/rules templates (toolFlags): a principle that names a tool renders only
// when the tool is offered. B-075 (owner 04.11.2026, first-person voice): the lines speak as the agent ("I run inside
// the Autark app", "my engine's own search"); the facts are unchanged.
// Owns: these lines, their wording and caps. Never: times or counts in the stable part, a tool the turn does not
// offer, e-mails, CLI homes, tokens or secret ids.

import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { ROOT_README } from '../root/layout.ts';
import { WHERE_HINT } from '../browser/place.ts';
import { cleanLabel, linkedPcs, modelsFactsLine } from './setup-facts.ts';
import { CALL_TOOL, FIND_TOOL } from '../tools/core-sets.ts'; // B-049 F4 (TOOLS-CORE)
import { listCompanies } from '../root/companies.ts'; // B-075
import '../contracts/apps.ts'; // B-052: RuntimeServices.apps (the connected-apps line)

export const ENVIRONMENT_HEADER = '## My environment';
/** Accounts named in the sign-in line (beyond: "+N more"). */
const MAX_SIGN_IN = 3;
/** Apps named in the connected-apps line (beyond: "+N more"). */
const MAX_APPS = 6;

/** The OS facts the section names (tests pass their own). */
export interface SystemFacts { platform: NodeJS.Platform; version: string; release: string; hostname: string }

export function systemFacts(): SystemFacts {
  let version = '';
  try { version = os.version(); } catch { /* older runtimes */ }
  return { platform: process.platform, version, release: os.release(), hostname: os.hostname() };
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** The tool names this mode offers the agent (the turn's own rule, so the prompt never names a missing tool). */
export function offeredTools(services: RuntimeServices, agent: Agent, mode: ModeInfo): ReadonlySet<string> {
  return safe(() => new Set(services.tools.specsFor(agent, mode).map((spec) => spec.name)), new Set<string>());
}

const any = (offered: ReadonlySet<string>, prefix: string): boolean => [...offered].some((name) => name.startsWith(prefix));
const flag = (value: boolean): string => (value ? 'yes' : '');

/** has_<tool> template values: 'yes' when the turn offers that tool (family), else '' ({{#has_x}}…{{/has_x}} drops the line). */
export function toolFlags(offered: ReadonlySet<string>): Record<string, string> {
  return {
    has_schedules: flag(any(offered, 'schedules.')),
    has_todos: flag(any(offered, 'todos.')),
    has_human_ask: flag(offered.has('human.ask')),
    has_agents_org: flag(offered.has('agents.create') || offered.has('agents.update')),
    has_models: flag(offered.has('models.list') || offered.has('model.set')),
    has_decide: flag(offered.has('decide')),
    has_modes: flag(any(offered, 'modes.')),
    has_web_search: flag(offered.has('web.search')),
    has_files_search: flag(offered.has('files.search')),
  };
}

/** "Windows 11 Pro (10.0.26300)", "macOS (Darwin 24.1.0)", "Linux 6.8.0". */
export function osName(system: SystemFacts): string {
  if (system.platform === 'win32') return `${system.version.trim() || 'Windows'} (${system.release})`;
  if (system.platform === 'darwin') return `macOS (Darwin ${system.release})`;
  if (system.platform === 'linux') return `Linux ${system.release}`;
  return `${system.version.trim() || system.platform} ${system.release}`.trim();
}

/** E1 (01.11.2026): the engine's own web search an agent turn keeps (engines/codex/helper-thread.ts AGENT_WEB_SEARCH, engines/claude/lean.ts CORE_TOOLS). */
const OWN_SEARCH: Readonly<Record<string, string>> = { codex: 'web_search', claude: 'WebSearch' };

/**
 * How the agent searches the web: the engine's own search first where it has one (Codex, Claude Code – E1: the keyless
 * web.search met bot checks in the live tests), web.search beside it; that results are data, not instructions, the
 * rules say (Trust).
 */
function webLine(offered: ReadonlySet<string>, engine?: string): string {
  const fetch = offered.has('web.fetch');
  const own = engine ? OWN_SEARCH[engine] : undefined;
  if (own) return `Web: ${own} (my engine's own search) finds current pages${fetch ? ', web.fetch reads one' : ''}${offered.has('web.search') ? '; web.search is a second search' : ''}.`;
  if (offered.has('web.search')) return `Web: web.search finds pages (title, link, snippet)${fetch ? ', web.fetch reads one' : ''}.`;
  if (fetch) return 'Web: no search tool in this mode – web.fetch reads a page whose address I know; searching I hand to a colleague in research mode (agents.delegate).';
  return 'Web: no web tools in this mode – web work I hand to a colleague in research mode (agents.delegate).';
}

function screenLine(offered: ReadonlySet<string>): string {
  const browser = [...offered].some((name) => name.startsWith('browser.') && name !== 'browser.show');
  const computer = any(offered, 'computer.');
  if (browser && computer) return 'Screen: browser.* browses websites (the person can watch and take over), computer.* operates this PC\'s screen, mouse and keyboard.';
  // B-072 (live 03.11.2026: a browser-only agent asked the person to sign in while their own Chrome had the session).
  if (browser) return 'Screen: browser.* browses websites in my own profile (the person can watch and take over); the person\'s own browsers on this screen keep their logins and autofill – a colleague in computer mode reaches them (agents.delegate).';
  if (computer) return 'Screen: computer.* operates this PC\'s screen, mouse and keyboard.';
  return 'Screen: the browser and computer tools live in the modes of those names – agents.delegate with that mode, or to a colleague there, does the screen work.';
}

/**
 * B-049 F4 (TOOLS-CORE): the one fact about the tool list, only where tools.find is offered ('' otherwise). Engines get
 * the mode's core tools directly; every other tool in `offered` (the flags' set) is reachable through tools.call.
 */
export function toolsLine(offered: ReadonlySet<string>): string {
  if (!offered.has(FIND_TOOL)) return '';
  return 'Tools: beyond my list, tools.find finds more tools; tools.call runs one.';
}

/**
 * B-057 S17 (owner 30.10.2026: "dass der nicht alles selbst machen muss … nur eine Möglichkeit"): the one line that the
 * agent may split itself – where agents.split is offered (since 30.10. through tools.find / tools.call, not in the direct
 * list: its spec is ~1.7k characters the agent rarely needs). Whether and when stays its own call.
 */
export function splitLine(offered: ReadonlySet<string>, engine?: string): string {
  const own = offered.has('agents.split')
    ? 'Splitting: I need not do everything myself – for work with independent pieces I can split myself into parallel parts (agents.split); whether and when is my call.'
    : '';
  // Live round D (30.10.2026): Codex 0.165 offers its own collaboration tools in every thread – its model catalog sets
  // multi_agent_version v2 and no thread or config switch removes them (features.multi_agent(_v2), multiAgentMode none,
  // agents.max_threads tried). Asked to split, Codex used them: no split group, its sub-agents' commands, tokens and costs
  // never reached the app's journal. So a Codex agent's line says plainly that it works without them.
  const codex = engine === 'codex'
    ? `Codex's own collaboration tools (spawn_agent, followup_task, send_message, wait_agent, interrupt_agent, list_agents) stay outside this app's journal and costs, so I leave them unused${own ? ' – my parallel work goes through agents.split' : ''}.`
    : '';
  return [own, codex].filter(Boolean).join(' ');
}

// H1 (01.11.2026): the E1 line on Codex's sub-agent note (codexTeamLine) stood here, before that note in the thread – it
// had no effect. The Codex adapter now sends one app note after it (engines/codex/app-note.ts).

/**
 * C4-live (31.10.2026): an engine may put an instructions file of the person's own set-up for it into a thread as a user
 * message (Codex: its home's AGENTS.md; no thread or config switch removes it – project_doc_max_bytes only drops the
 * workspace's). On a fresh thread the agent answered that block ("Verstanden …") instead of the turn's input – a
 * manager's review of a finished task was lost. The line says what such text is, in the same words on every engine
 * (q-r, 03.11.2026: prompts name no engine's files).
 */
export const ENGINE_SETUP_LINE = 'Text my engine adds on its own from the person\'s set-up for it (an instructions file) is a standing preference I follow quietly, not a message: my answer goes to the turn\'s input.';

/** English name of a language code ("de" → "German"); the code itself when unknown. */
export function languageName(code: string | undefined): string {
  const value = code?.trim();
  if (!value) return 'English';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(value);
    return name && name !== value ? name : value;
  } catch {
    return value;
  }
}

/** B-078 (D17, owner 06.11.2026): the language follows the person, and the AI keeps the setting itself. */
export const LANGUAGE_LINE = 'When the person writes or speaks in another language than the app\'s, my answers follow theirs; when that holds, I set profile.language, and anything special about how they want to be spoken to (a language per topic, a form of address) I note in profile.notes (skill app-settings).';

/** Notes in the stable prompt (settings allow 600). */
const NOTES_CAP = 600;

/** "How the person wants to be spoken to (profile.notes): …" – '' without notes. */
export function notesLine(notes: string | undefined): string {
  const text = notes?.replace(/\s+/g, ' ').trim();
  return text ? `How the person wants to be spoken to (profile.notes, kept by us agents): ${text.slice(0, NOTES_CAP)}` : '';
}

/**
 * The stable "## My environment" (deterministic for the same agent, mode, engine and PC): this PC and its language, the
 * language line and profile.notes (B-078), the connected models with price and smarts (B-078), the workspace, how to
 * search the web this turn and screen tools.
 * `offered`: the turn's tool names.
 */
export function environmentSection(services: RuntimeServices, input: { agent: Agent; mode: ModeInfo; route: RouteDecision }, offered?: ReadonlySet<string>, system: SystemFacts = systemFacts()): string {
  const tools = offered ?? offeredTools(services, input.agent, input.mode);
  const workspace = safe(() => services.paths.workspace, '');
  // B-076: the language as a fact, no rule – the app's setting, which starts as this PC's language.
  const profile = safe(() => services.settings.get().profile, undefined);
  const language = languageName(profile?.language);
  const lines = [
    ENVIRONMENT_HEADER,
    `This PC: ${osName(system)}, named "${system.hostname}" – I run inside the Autark app on it, whose language is set to ${language}.`,
    LANGUAGE_LINE, // B-078 (D17): the AI notices the spoken language and keeps the setting and the notes
    notesLine(profile?.notes),
    modelsFactsLine(services), // B-078 (D16): the connected models with price, smarts and how a turn is paid
    workspace ? `Workspace: ${workspace} – the team's working folder (projects and the files I make).` : '',
    webLine(tools, input.route?.engine), // E1: the engine's own search first
    screenLine(tools),
    [...tools].some((name) => name.startsWith('browser.') && name !== 'browser.show') ? `Browser, where: ${WHERE_HINT}` : '',
    toolsLine(tools), // B-049 F4 (TOOLS-CORE)
    splitLine(tools, input.route?.engine), // B-057 S17: splitting is the agent's own choice (Codex: not with its own sub-agents)
    ENGINE_SETUP_LINE, // C4-live: an instructions block the engine adds is no message to answer
  ];
  return lines.filter(Boolean).join('\n');
}

function fileTools(offered: ReadonlySet<string>): string {
  const names = ['files.read', 'files.list', 'files.search'].filter((name) => offered.has(name));
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * E1 live (01.11.2026): the workspace is empty at the start; Codex agents searched only it and hired, briefed or asked on
 * that basis while the person's material lay in their home folder. The line names where the person's own files are and
 * (F2/G1) that files.search without a path covers the workspace and then that folder – a fact, only where a file tool is
 * offered.
 */
export function homeLine(offered: ReadonlySet<string>, home: string = os.homedir()): string {
  if (!home || !fileTools(offered)) return '';
  const search = offered.has('files.search') ? ' – files.search without a path searches the workspace, then this folder' : '';
  return `The person's own files: ${home} and its folders${search}.`;
}

function reachLines(services: RuntimeServices, offered: ReadonlySet<string>): string[] {
  const tools = fileTools(offered);
  const data = safe(() => services.paths.data, '');
  const lines = [`PC reach: the whole PC – it belongs to the AI team${tools ? ` (${tools})` : ''}. I look wherever it helps.`];
  const home = homeLine(offered);
  if (home) lines.push(home);
  // G1 (01.11.2026): a fact, no instruction ("Change them to change the app" framed a first request as configuring the app).
  if (tools && data) lines.push(`Data folder: ${data} – this app's own files (settings.json, theme.css, agents' SYSTEM.md, skills, prompts); ${path.join(data, ROOT_README)} maps them.`);
  return lines;
}

/** Names in the companies line (beyond: "+N more"). */
const MAX_PLACES = 6;

const named = (names: string[]): string => `${names.slice(0, MAX_PLACES).join(', ')}${names.length > MAX_PLACES ? ` +${names.length - MAX_PLACES} more` : ''}`;

/**
 * B-075 (owner 04.11.2026: an agent knew neither the person's other company nor the linked PC it was asked about):
 * "Companies on this PC: Teydra lab (this one), company-2 · Linked PCs: laptop (online)" – only where there is
 * more than one company or a linked PC; with several companies, where tools.call is offered, how to act in another one.
 */
export function companiesLine(services: RuntimeServices, offered: ReadonlySet<string>): string {
  const companies = safe(() => listCompanies(services.host.app), []);
  const pcs = safe(() => linkedPcs(services), []);
  if (companies.length < 2 && !pcs.length) return '';
  const parts: string[] = [];
  if (companies.length) {
    const how = companies.length > 1 && offered.has(CALL_TOOL) ? ' – tools.call with company: "<name>" runs a tool in another one' : '';
    parts.push(`Companies on this PC: ${named(companies.map((company) => `${cleanLabel(company.label)}${company.current ? ' (this one)' : ''}`))}${how}`);
  }
  if (pcs.length) parts.push(`Linked PCs: ${named(pcs.map((pc) => `${cleanLabel(pc.name)} (${pc.online ? 'online' : 'offline'})`))}`);
  return `${parts.join(' · ')}.`;
}

/** "Accounts needing sign-in: …" (labels only; '' when none). */
export function signInLine(services: RuntimeServices, offered: ReadonlySet<string>): string {
  const waiting = safe(() => services.accounts.list(), []).filter((account) => account.enabled !== false && account.state === 'needs_login');
  if (!waiting.length) return '';
  const tool = offered.has('accounts.sign_in'); // then each account's id too: the tool's accountId
  const names = waiting.slice(0, MAX_SIGN_IN).map((account) => `${cleanLabel(account.label, account.email)} (${account.provider}${tool ? `, ${account.id}` : ''})`);
  const more = waiting.length > MAX_SIGN_IN ? ` +${waiting.length - MAX_SIGN_IN} more` : '';
  const how = tool ? ' – accounts.sign_in starts the official sign-in' : '';
  return `Accounts needing sign-in: ${names.join(', ')}${more}${how}.`;
}

/** B-052 M6: "Connected apps: Notion (app.notion.*), … – tools.find finds their tools; another service: skill connect-apps."
 *  – apps the agent may use now (AppsService.usableBy: ids) whose tools this turn offers; with none, where the apps
 *  service runs, the plain fact (G1: the hint to connect a service read as a setup step at the first request). Connector
 *  tools are app.<id>.<tool> (three parts; app.status is the app's own tool). */
export function appsLine(services: RuntimeServices, agent: Agent, offered: ReadonlySet<string>): string {
  const ids = new Set([...offered].map((name) => name.split('.')).filter((parts) => parts[0] === 'app' && parts.length >= 3).map((parts) => parts[1]));
  const usable = new Set(ids.size ? safe(() => services.apps?.usableBy(agent.id) ?? [], [] as string[]) : []);
  const apps = usable.size ? safe(() => services.apps?.list() ?? [], []).filter((app) => ids.has(app.id) && usable.has(app.id)) : [];
  if (!apps.length) {
    return services.apps ? 'Connected apps: none.' : '';
  }
  const names = apps.slice(0, MAX_APPS).map((app) => `${cleanLabel(app.name)} (app.${app.id}.*)`);
  const more = apps.length > MAX_APPS ? ` +${apps.length - MAX_APPS} more` : '';
  const find = offered.has(FIND_TOOL) ? ' – tools.find finds their tools' : '';
  return `Connected apps: ${names.join(', ')}${more}${find}${find ? ';' : ' –'} another service: skill connect-apps.`;
}

/**
 * The volatile part (prompt-volatile.ts): PC reach, the data folder when readable, the companies and linked PCs,
 * accounts needing sign-in and connected apps. `mode`: the turn's mode (its tool offer).
 */
export function environmentNow(services: RuntimeServices, input: { agent: Agent; mode?: ModeInfo; conversationId?: string }): string {
  const offered = input.mode ? offeredTools(services, input.agent, input.mode) : new Set<string>();
  const lines = [
    `${ENVIRONMENT_HEADER} now`,
    ...reachLines(services, offered),
    companiesLine(services, offered), // B-075
    signInLine(services, offered),
    appsLine(services, input.agent, offered), // B-052 M6
  ];
  return lines.filter(Boolean).join('\n');
}
