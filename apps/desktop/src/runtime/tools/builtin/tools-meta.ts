// tools.find / tools.call (B-049 F4): the two meta tools beside every core set (tools/core-sets.ts).
// tools.find answers which other tools fit a job – name, one-line purpose and compact arguments, best first – out of
// what the agent may use in this mode on its engine (the registry's specsFor with the calling engine's audience,
// read from the dispatcher's live activity; unknown → tools without an audience). A full tool name answers that
// tool's whole description and argument schema. Ranking: the name's parts, a short keyword index per tool family and
// the description's words.
// tools.call runs one of those tools: the registry unwraps it (registry.ts call) and runs the target through its own
// pipeline under the target's name and this call's id, so validation, the journal
// (real name), the ledger and the result are exactly a direct call's. A target run this way joins the agent's direct
// offer in this chat at the next fresh session (tools/learned.ts).
// B-075: tools.call's `company` runs the target in another company on this PC (kept apart from the target's arguments, so
// a tool's own `company` stays its own; the registry places it: placement.ts placeCompany); companies.list
// (builtin/companies.ts), which names those companies, is registered with these two.
// Owns: their wording and argument shapes, the keyword index, the compact argument line and one-line purpose (a tool's
// first sentence – B-049 F8: lean descriptions must open with a sentence that says what the tool does), the name normalisation (wire
// names, the hub's mcp__workforce__ prefix), what a tools.call may run (callRefusal) and calledTool for counting.
// Never: runs a tool itself, offers a tool the mode or engine does not allow, or nests tools.call.

import type { ModeInfo } from '../../../shared/model/knowledge.ts';
import type { ToolContext, ToolDef, ToolSpec } from '../types.ts';
import { failure, text } from '../types.ts';
import { CALL_TOOL, FIND_TOOL, META_TOOLS, coreNames } from '../core-sets.ts';
import { learnedTools } from '../learned.ts';
import { COMPANY_ARG, isRecord } from '../placement.ts';
import { companyTools } from './companies.ts';
import { clip, defineTool, internal } from './util.ts';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const HUB_PREFIX = 'mcp__workforce__';

/** A short keyword index: a family prefix ('schedules.') or a full name → words people use for that work. */
const KEYWORDS: Readonly<Record<string, string>> = {
  'schedules.': 'schedule later remind reminder recurring routine repeat daily weekly timer follow-up',
  'calendar.': 'calendar appointment meeting event free slot day block agenda move reschedule remove',
  'todos.': 'todo to-do prepare errand',
  'agents.': 'agent colleague team hire staff org role delegate handoff',
  'agents.split': 'split parallel fork worker subtask fan-out pipeline verify ultra', // B-057
  'chat.': 'chat message conversation post channel notes members invite direct dm edit delete archive reply',
  'people.': 'people person colleague employee human staff directory coworker',
  'tasks.': 'task work assign claim inbox done finish status subscribe owner',
  'knowledge.': 'memory remember recall note fact preference source document',
  'skills.': 'skill procedure instructions how-to import',
  'media.': 'image picture photo video audio sound music speech voice transcribe generate draw clip',
  'browser.': 'browser website page site click form login sign-in tab download',
  'computer.': 'screen desktop window mouse keyboard click app gui',
  'phone.': 'phone android mobile adb smartphone',
  'secrets.': 'password secret credential token key vault login 2fa',
  'secrets.import': 'import export csv env dotenv file bitwarden', // 04.11.2026: a password export or a .env by its path
  'secrets.export': 'export download file passwords logins backup', // B-075
  'secrets.delete': 'delete remove clear passwords logins', // B-075
  'spend.': 'money budget purchase payment receipt invoice cost',
  'files.': 'file folder read write directory path',
  'shell.': 'terminal command run script bash powershell cmd console linked pc remote', // 04.11.2026: a linked PC's terminal for every engine
  'web.': 'web internet search url page online',
  'references.': 'reference style example wrote person voice tone',
  'models.': 'model llm compare stronger cheaper',
  'devices.': 'pc device linked computer transfer send fetch',
  'modes.': 'mode specialist',
  'accounts.': 'account sign-in login plan subscription',
  'spaces.': 'space area branch brand private', // B-075: "company" finds companies.list – a space is an area inside one company
  'companies.': 'company firm firma profile other', // B-075: the companies on this PC; tools.call with company acts in one
  decide: 'choose choice pick option decision',
  'human.ask': 'ask person human question form confirm',
  'ui.help': 'rich answer block chart table mini-app widget',
  'feedback.report': 'bug idea problem report',
};

const STOP: ReadonlySet<string> = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'from', 'my', 'me', 'i', 'it', 'is', 'do', 'how', 'what', 'which', 'tool', 'tools', 'want', 'need', 'can', 'this', 'that', 'some', 'find', 'use', 'get', 'make']);

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word));
/** Same word, or one a prefix of the other when both have at least four letters ("remind" ~ "reminders"). */
const same = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Our dotted name for what an agent wrote: a wire name ("ui__help"), the hub's qualified name or the dotted name. */
export function normalizeName(raw: string): string {
  const name = raw.trim().startsWith(HUB_PREFIX) ? raw.trim().slice(HUB_PREFIX.length) : raw.trim();
  return name.replace(/__/g, '.').toLowerCase();
}

/** The target of a tools.call: its normalised name and arguments ({} when none; top-level extras as arguments). B-075:
 *  `company` beside args is the company it runs in, kept apart from the arguments (a tool may have its own `company`). */
export function callTarget(args: unknown): { name: string; args: Record<string, unknown>; company?: unknown } | { error: string } {
  if (!isRecord(args) || typeof args.name !== 'string' || !args.name.trim()) return { error: 'tools.call needs the tool\'s name: {"name": "<a tool from tools.find>", "args": {…}}.' };
  let inner: unknown = args.args;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* reported below */ } }
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'name' && key !== 'args'));
  const { [COMPANY_ARG]: company, ...rest } = extra;
  if (inner === undefined) inner = extra; // a model that put the arguments beside the name (a `company` there is placed like one in args)
  else if (Object.keys(rest).length) return { error: `tools.call takes only name, args and company – put ${Object.keys(rest).join(', ')} inside args.` };
  if (!isRecord(inner)) return { error: 'tools.call: args must be an object with the tool\'s arguments.' };
  const name = normalizeName(args.name);
  return company === undefined || inner === extra ? { name, args: inner } : { name, args: inner, company };
}

/** A tools.call as the tool it runs (turn-attempt counts and labels it so); any other call unchanged. */
export function calledTool(name: string, args: unknown): { name: string; args: unknown } {
  if (name !== CALL_TOOL) return { name, args };
  const target = callTarget(args);
  return 'error' in target ? { name, args } : target;
}

function modeOf(ctx: ToolContext): ModeInfo | undefined {
  try { return ctx.services.modes.get(ctx.mode); } catch { return undefined; }
}

/** The calling engine's audience (the run's live activity); undefined when unknown – then only tools without an audience. */
function engineOf(ctx: ToolContext): { ownTools: boolean; via: 'mcp' | 'native' } | undefined {
  try {
    const id = ctx.services.dispatcher?.activity?.().find((entry) => entry.runId === ctx.runId)?.engine;
    if (!id) return undefined;
    const caps = ctx.services.engines.get(id).caps;
    return { ownTools: caps.ownTools, via: caps.dynamicTools ? 'native' : 'mcp' };
  } catch {
    return undefined;
  }
}

/** What the agent may use in this mode on its engine, without the meta tools; undefined when the mode is unknown. */
function usableSpecs(ctx: ToolContext, mode: ModeInfo | undefined): ToolSpec[] | undefined {
  if (!mode) return undefined;
  try { return ctx.services.tools.specsFor(ctx.agent, mode, engineOf(ctx)).filter((spec) => !META_TOOLS.includes(spec.name)); } catch { return undefined; }
}

/** Why tools.call may not run `name` for this call (undefined: it may – the registry's own checks still apply). */
export function callRefusal(ctx: ToolContext, name: string): string | undefined {
  if (name === CALL_TOOL) return 'tools.call runs another tool, not itself: name the tool I want.';
  if (name === FIND_TOOL) return undefined;
  const usable = usableSpecs(ctx, modeOf(ctx));
  if (!usable || usable.some((spec) => spec.name === name)) return undefined;
  return ctx.services.tools.get(name)
    ? `Tool "${name}" is not available to me in mode "${ctx.mode}". tools.find lists what I can use here.`
    : `Unknown tool "${name}". tools.find lists what I can use here.`;
}

function typeOf(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) { const values = prop.enum.map(String); return values.length > 6 ? `${values.slice(0, 6).join('|')}|…` : values.join('|'); }
  const type = Array.isArray(prop.type) ? prop.type.join('|') : typeof prop.type === 'string' ? prop.type : prop.oneOf || prop.anyOf ? 'several forms' : 'any';
  if (type === 'array') { const items = isRecord(prop.items) ? typeOf(prop.items) : 'any'; return items.includes('|') ? `(${items})[]` : `${items}[]`; }
  if ((type === 'integer' || type === 'number') && (typeof prop.minimum === 'number' || typeof prop.maximum === 'number')) return `${type} ${prop.minimum ?? ''}–${prop.maximum ?? ''}`;
  return type;
}

/** "query*: string, limit: integer 1–20, kinds: (a|b)[]" – * marks a required argument. */
export function compactArgs(schema: Record<string, unknown>): string {
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parts = Object.entries(props).map(([key, prop]) => `${key}${required.has(key) ? '*' : ''}: ${isRecord(prop) ? typeOf(prop) : 'any'}`);
  return parts.length ? clip(parts.join(', '), 300) : 'none';
}

/** The one-line purpose: the description's first sentence ("e.g." / "i.e." do not end it), clipped. */
export const purpose = (description: string): string => clip(description.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s/)[0]?.trim() ?? '', 160);

function keywordsOf(name: string): string[] {
  const family = `${name.split('.')[0]}.`;
  return words([KEYWORDS[family] ?? '', Object.hasOwn(KEYWORDS, name) ? KEYWORDS[name] : ''].join(' '));
}

/** The specs that fit `query`, best first (score: name part 4, keyword 3, description word 1 per query word). */
export function rankTools(specs: readonly ToolSpec[], query: string, limit: number): ToolSpec[] {
  const asked = [...new Set(words(query))];
  if (!asked.length) return [];
  const scored = specs.map((spec) => {
    const parts = words(spec.name.replace(/[._-]/g, ' '));
    const keys = keywordsOf(spec.name);
    const described = words(spec.description);
    const score = asked.reduce((sum, word) => sum + (parts.some((part) => same(part, word)) ? 4 : keys.some((key) => same(key, word)) ? 3 : described.some((item) => same(item, word)) ? 1 : 0), 0);
    return { spec, score };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || (a.spec.name < b.spec.name ? -1 : 1)).slice(0, limit).map((item) => item.spec);
}

/** The names this agent is offered directly here (its core set and learned tools). */
function directNames(ctx: ToolContext, mode: ModeInfo): Set<string> {
  const names = coreNames(mode, engineOf(ctx));
  try { for (const name of learnedTools(ctx.services.db, ctx.agent.id, ctx.conversationId ?? ctx.split?.parentConversationId)) names.add(name); } catch { /* core set only */ } // B-057: a split's list is its parent chat's
  return names;
}

function families(specs: readonly ToolSpec[]): string {
  const counts = new Map<string, number>();
  for (const spec of specs) { const family = spec.name.split('.')[0]; counts.set(family, (counts.get(family) ?? 0) + 1); }
  return [...counts].map(([family, count]) => (count > 1 ? `${family}.* (${count})` : [...specs].find((spec) => spec.name.split('.')[0] === family)!.name)).join(', ');
}

const find = defineTool<{ query: string; limit?: number }>({
  name: FIND_TOOL,
  description: 'Find tools beyond my list: describe the job, or give a tool name for its full arguments (* = required); run one with tools.call.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    required: ['query'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Find tools for "${clip(args.query, 60)}"`),
  async run(args, ctx) {
    const mode = modeOf(ctx);
    const usable = usableSpecs(ctx, mode);
    if (!mode || !usable) return failure('My tools cannot be listed right now.');
    const exact = usable.find((spec) => spec.name === normalizeName(args.query));
    if (exact) {
      return text([`${exact.name} – ${exact.description}`, `Args (* = required): ${compactArgs(exact.inputSchema)}`, `Schema: ${JSON.stringify(exact.inputSchema)}`,
        directNames(ctx, mode).has(exact.name) ? 'It is in my list: I call it directly.' : `Run it with tools.call {"name": "${exact.name}", "args": {…}}.`].join('\n'));
    }
    const found = rankTools(usable, args.query, args.limit ?? DEFAULT_LIMIT);
    if (!found.length) return text(`Nothing fits "${clip(args.query, 80)}". I can use these here: ${families(usable)}. Ask with other words or a tool name.`);
    const direct = directNames(ctx, mode);
    const lines = found.map((spec) => `- ${spec.name}${direct.has(spec.name) ? ' (in my list)' : ''}: ${purpose(spec.description)} Args: ${compactArgs(spec.inputSchema)}`);
    return text([`Tools for "${clip(args.query, 80)}" – run one with tools.call {"name": …, "args": {…}}; a name as query shows its full arguments:`, ...lines].join('\n'));
  },
});

const call = defineTool<{ name: string; args?: Record<string, unknown>; company?: string }>({
  name: CALL_TOOL,
  description: 'Run a tool that is not in my list: name and args as tools.find gives them. It runs just as a direct call does; with company, in that other company on this PC.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 }, args: { type: 'object' },
      [COMPANY_ARG]: { type: 'string', minLength: 1, maxLength: 120, description: 'another company on this PC to run it in: its name or folder from companies.list' }, // B-075
    },
    required: ['name'], additionalProperties: false,
  },
  category: 'read', // never judged itself: the registry runs the target under its own category
  describe: (args) => internal(`Run ${clip(String(args.name), 60)}`),
  // The registry unwraps tools.call before it would get here; a direct run takes the same path.
  async run(args, ctx) {
    const { services, ...base } = ctx;
    return services.tools.call(CALL_TOOL, args, base, ctx.callId ?? '');
  },
});

export const metaTools: ToolDef[] = [find, call, ...companyTools]; // B-075: companies.list names tools.call's companies
