// Core tool sets (B-049 F4): the few tools an engine is offered directly per mode – every other tool the agent may
// use in that mode stays reachable through the two meta tools tools.find and tools.call (builtin/tools-meta.ts).
// One place names every core tool together with the reason it is offered directly:
// - BASE_CORE: every mode (the F4 contract list, plus what the prompt and the turn rely on; B-050 K10 added chat.read
//   and chat.direct – together about 940 characters of spec, ~235 tokens, under the 600-token bound K10 set; a mode's
//   direct offer stays at most 27 tools – test/unit/tools/tools-core.test.ts. B-057's agents.split is no core tool (owner
//   30.10.2026: the agent does not need it all the time): tools.find / tools.call reach it, the environment's one
//   'Splitting' line names it, and once an agent used it in a chat it is direct there from the next fresh session on – tools/learned.ts);
// - MODE_CORE: a built-in mode's own essentials; a saved (custom) mode gets the essentials of the tool families
//   its patterns name (FAMILY_CORE), a '*' mode the general ones;
// - NO_OWN_TOOLS_CORE: the execution core of an engine without its own shell/file tools (HTTP/local models),
//   as F2 keeps Bash/Read/Edit/Write/Glob/Grep for Claude Code;
// - META_TOOLS: tools.find and tools.call, beside every core set.
// The registry intersects a core set with what the mode really offers the agent on that engine (registry.ts
// offerFor), so a core name the mode, the agent or the engine does not get is simply not offered.
// Owns: these lists and their reasons. Never: widens what a mode allows, or decides per turn (tools learned from
// use are added by tools/learned.ts at a fresh session).

import type { ModeInfo } from '../../shared/model/knowledge.ts';

export const FIND_TOOL = 'tools.find';
export const CALL_TOOL = 'tools.call';
export const META_TOOLS: readonly string[] = [FIND_TOOL, CALL_TOOL];

/** tool name → why it is offered directly. */
type Reasons = Readonly<Record<string, string>>;

export const BASE_CORE: Reasons = {
  'model.set': 'self-routing (RT4): the rules tell every agent to say which model its work needs',
  'tasks.create': 'contract tasks.*, narrowed to the lifecycle every agent runs; the other tasks.* tools via tools.find',
  'tasks.update': 'contract tasks.*: status, notes and due dates of the own work',
  'tasks.complete': 'contract tasks.*: finishing work with evidence (turn-finish judges the task change)',
  'chat.send': 'the rules send work updates with chat.send status: true',
  'chat.read': 'B-050 K10: a chat\'s lines again (the context compacts them; render.ts points to chat.read for a cut message) – ~120 tokens',
  'chat.direct': 'B-050 K10: the 1:1 with any member (agent, person, colleague) without a search first – ~120 tokens',
  'files.read': 'contract: reading files is everyday work',
  'files.search': 'contract; the rules name it (has_files_search)',
  'web.search': 'contract; the environment web line names it',
  'web.fetch': 'contract; the environment web line names it beside web.search',
  'skills.load': 'contract; the skills index says to load a skill before that kind of work',
  'skills.find': 'F5: the skills line names skills.find with skills.load (offered once that tool exists)',
  'knowledge.find': 'contract: the one permission-checked find path; the what-you-know line names it',
  'knowledge.open': 'opens what knowledge.find returns (its result says so)',
  subconscious: 'owner 15.10./01.11.2026: the main AI can start the subconscious itself with any text; its answer is the tool output – ~110 tokens',
  'human.ask': 'the rules name it; turn-finish reads a human.ask call as asking the person (must-see)',
  'agents.delegate': 'the environment hands web and screen work to a colleague with it where the mode lacks those tools',
};

const BROWSER_BASICS: Reasons = {
  'browser.open': 'opening a page in the agent\'s own browser profile',
  'browser.snapshot': 'the page\'s refs before every act',
  'browser.act': 'click, fill, select on the page',
  'browser.extract': 'reading the page\'s text',
};

const COMPUTER_BASICS: Reasons = {
  'computer.windows': 'mode text: start here',
  'computer.ui_tree': 'the refs computer.act works on',
  'computer.act': 'acting on a UI element by ref',
  'computer.screenshot': 'looking at the screen',
};

/** The block prompt (shared/blocks/prompt.ts) tells chat agents to look a block type up with it before its first use. */
const UI_HELP: Reasons = { 'ui.help': 'the block prompt: look a block type up with it before its first use' };

export const MODE_CORE: Readonly<Record<string, Reasons>> = {
  general: {
    'agents.handoff': 'general mode switches to a specialist mode by a handoff (mode text)',
    ...UI_HELP,
  },
  manager: {
    ...UI_HELP,
    'agents.templates': 'mode text: hiring starts from a template',
    'agents.create': 'mode text: hiring (agents.templates, agents.create)',
    'agents.update': 'mode text and the agent-default note: shaping a hire\'s role and instructions',
    'tasks.assign': 'a manager gives tasks to owners',
    'chat.create': 'work groups and topic chats are everyday manager work (B-050 R5 searched for it); members by name, so no agents.list first',
  },
  secretary: {
    ...UI_HELP,
    'calendar.list': 'appointments and the person\'s day',
    'calendar.add': 'putting an appointment into the calendar',
    'todos.prepare': 'the rules: the person\'s to-dos are prepared, never ticked off (has_todos)',
    'schedules.remind': 'mode text: self-reminders for the agent\'s own follow-ups',
  },
  research: {
    'browser.open': 'primary sources that need a real browser',
    'browser.extract': 'reading such a page',
    'knowledge.remember': 'mode text: save durable findings with source and date',
  },
  writing: {},
  browser: { // B-055: browser.batch, find, console, network, eval and wait are reached through tools.find (the core stays ≤ 28)
    ...BROWSER_BASICS,
    'browser.screenshot': 'visual checks of the page',
    'secrets.list': 'handles for sign-ups and sign-ins (browser.act fills secret:// handles)',
    'secrets.save': 'owner 29.10.2026: a key or password met on the way goes straight into the catalog',
  },
  computer: {
    ...COMPUTER_BASICS,
    'computer.type': 'typing into the focused element',
    'computer.key': 'keys and shortcuts',
  },
  finance: {
    ...BROWSER_BASICS,
    'secrets.list': 'handles for bank and portal sign-ins',
    'secrets.save': 'owner 29.10.2026: a key or password met on the way goes straight into the catalog',
  },
  social: {
    'browser.open': 'the platform UI in the agent\'s own profile',
    'browser.snapshot': 'the page\'s refs before every act',
    'browser.act': 'posting and replying on the page',
    'browser.screenshot': 'checking a post as it looks',
    'media.look': 'mode text: watch a video before describing or posting it',
    'media.listen': 'mode text: hear audio before describing or posting it',
    'schedules.routine': 'mode text: every publish gets its comment routine',
  },
  video: {
    'media.look': 'mode text: watch a video (keyframes) before answering about it',
    'media.listen': 'hearing music, sounds and voices',
    'media.transcribe': 'what is said in a recording',
    'media.search': 'finding stored footage',
    'media.video': 'B-058 G13: generated clips are part of video work (media.music and media.sound via tools.find: the 28-tool bound)',
    'media.speak': 'B-058 G12: voice-overs, free in the local voice',
  },
  web: {
    'browser.open': 'checking the built site',
    'browser.screenshot': 'seeing the built site',
  },
};

/** A saved mode's essentials by the tool families its patterns name ('*' → general's). */
const FAMILY_CORE: Readonly<Record<string, Reasons>> = {
  browser: BROWSER_BASICS,
  computer: COMPUTER_BASICS,
  media: { 'media.search': 'finding stored media', 'media.look': 'watching a stored video', 'media.view': 'B-058 G10: every image line not attached to the turn names media.view' },
};

export const NO_OWN_TOOLS_CORE: Reasons = {
  'files.list': 'an engine without its own file tools lists folders with ours',
  'files.write': 'an engine without its own file tools writes with ours',
  'shell.exec': 'an engine without its own shell runs commands with ours',
};

function modeCore(mode: Pick<ModeInfo, 'key' | 'tools'>): Reasons {
  if (Object.hasOwn(MODE_CORE, mode.key)) return MODE_CORE[mode.key];
  const patterns = mode.tools ?? ['*'];
  if (!patterns.length || patterns.includes('*')) return MODE_CORE.general;
  const families = new Set(patterns.filter((pattern) => !pattern.startsWith('!')).map((pattern) => pattern.split('.')[0]));
  return Object.assign({}, ...[...families].filter((family) => Object.hasOwn(FAMILY_CORE, family)).map((family) => FAMILY_CORE[family]));
}

const reasonIn = (reasons: Reasons, name: string): string | undefined => (Object.hasOwn(reasons, name) ? reasons[name] : undefined);

/**
 * The names an engine is offered directly in `mode` (before the registry intersects them with the mode's offer).
 * `engine`: whether it brings its own shell/file tools; undefined counts as yes (the CLI engines).
 */
export function coreNames(mode: Pick<ModeInfo, 'key' | 'tools'>, engine?: { ownTools: boolean }): Set<string> {
  const names = new Set([...Object.keys(BASE_CORE), ...Object.keys(modeCore(mode)), ...META_TOOLS]);
  if (engine && !engine.ownTools) for (const name of Object.keys(NO_OWN_TOOLS_CORE)) names.add(name);
  return names;
}

/** Why `name` is offered directly in `mode` (undefined: it is not a core tool there) – for docs and tests. */
export function coreReason(mode: Pick<ModeInfo, 'key' | 'tools'>, name: string): string | undefined {
  if (META_TOOLS.includes(name)) return 'B-049 F4 meta tool: finds and runs every other tool the agent may use here';
  return reasonIn(BASE_CORE, name) ?? reasonIn(modeCore(mode), name) ?? reasonIn(NO_OWN_TOOLS_CORE, name);
}
