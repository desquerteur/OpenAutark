// settings.json described in ONE place: every section and key of the app's settings – what it does, the allowed
// values and the default – and the two texts made from it: <data>/settings.json itself (JSON with a comment line
// above every key, like VS Code's settings.json, always written whole with the current values) and
// <data>/settings.schema.json (JSON Schema of the same keys for editors and scripts; settings.json names it in
// "$schema"). Reading the text back drops the comments and trailing commas (no dependency). defaults.ts builds the
// defaults from these definitions; validate.ts takes the known keys, the options, ranges and patterns from here.
// Owns: the definitions, both texts and how the text is read. Never: reads or writes files, decides what applies.

import type { Settings } from '../../shared/model/system.ts';
import { ONBOARDING_STEPS } from '../../shared/model/system.ts';
import { DEFAULT_DAY_SETTINGS, MAX_BUFFER_MIN } from '../../shared/model/day-settings.ts';
import { DEFAULT_RETENTION, MAX_RETENTION_DAYS } from '../../shared/model/lifecycle.ts';
import { localSpeechIds } from '../../shared/model/local-speech-models.ts';
import { MODEL_USES, OFFABLE_USES, USE_ABOUT, USE_AUTO, USE_LABELS, type ModelUse } from '../../shared/model/models-uses.ts';
import { KEY_HANDLE, PROVIDER_ID, PROVIDER_PROTOCOLS, providerNotes } from '../../shared/model/provider-entries.ts';
import { DEFAULT_RELAY } from '../../shared/model/relay.ts';
import { MAX_WORDS } from '../../shared/voice/vocabulary.ts';

type Plain = Record<string, unknown>;
type Literal = string | number | boolean;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The JSON Schema written beside settings.json. */
export const SETTINGS_SCHEMA_FILE = 'settings.schema.json';

/** B-078: profile.notes, the AI's note on how the person wants to be spoken to. */
export const NOTES_MAX = 600;

/** This PC's values the language and time zone defaults come from. */
export interface PcDefaults {
  language: string;
  timezone: string;
}

/** One key of a section. */
export interface KeyDef {
  key: string;
  /** What it does, one line without a final period. */
  about: string;
  type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
  /** The fixed choices (of an array: its items). */
  options?: readonly Literal[];
  /** The allowed values in words (an integer: a note after its range). */
  allowed?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  /** The default; absent = not set (null in the file). A function: from this PC. */
  default?: unknown;
  /** A nested object with keys of its own (lifecycle.retention). */
  keys?: readonly KeyDef[];
  /** More of its JSON Schema (an object's members, an array's items). */
  schema?: Plain;
}

/** One section of settings.json. */
export interface SectionDef {
  key: keyof Settings & string;
  /** The section's comment line. */
  title: string;
  keys: readonly KeyDef[];
  /** No defaults: the section is absent until something is set (lifecycle, calendar). */
  optional?: boolean;
  /** Its keys are free (providers: one entry per id); `keys` stays empty and validate.ts checks the entries. */
  free?: boolean;
  /** More comment lines under the title. */
  notes?: readonly string[];
}

/** Patterns shared by the schema and validate.ts. */
export const PATTERNS = {
  clock: '^([01]\\d|2[0-3]):[0-5]\\d$',
  language: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$',
  provider: '^[a-z][a-z0-9-]{1,39}$',
  googleClientId: '^[A-Za-z0-9._-]{1,200}$',
} as const;

const flag = (key: string, about: string, value: boolean): KeyDef => ({ key, about, type: 'boolean', options: [true, false], default: value });
const choice = (key: string, about: string, options: readonly string[], value: string): KeyDef => ({ key, about, type: 'string', options, default: value });
const int = (key: string, about: string, min: number, max: number, value: number, allowed?: string): KeyDef => ({ key, about, type: 'integer', min, max, default: value, ...(allowed ? { allowed } : {}) });
const text = (key: string, about: string, allowed: string, more: Partial<KeyDef> = {}): KeyDef => ({ key, about, type: 'string', allowed, ...more });
const clock = (key: string, about: string, value: string): KeyDef => text(key, about, '"HH:MM"', { pattern: PATTERNS.clock, default: value });
const fromPc = (name: keyof PcDefaults) => (pc: PcDefaults) => pc[name];
/** One model use of the Models section (shared/model/models-uses.ts): "auto" (the app takes what is connected; Settings › Models and, for decision and embeddings the tool app.status, else wf call models.uses, name that model) or a model id; work also a plan, media also "off", tts and embeddings also "local", image also "codex". */
const useKey = (use: ModelUse): KeyDef => {
  const names = use === 'decision' || use === 'embeddings' ? 'Settings › Models and the tool app.status name that model' : 'Settings › Models and wf call models.uses name that model';
  return text(use, `${USE_LABELS[use]} – ${USE_ABOUT[use].charAt(0).toLowerCase()}${USE_ABOUT[use].slice(1)}`,
    use === 'work'
      ? `"auto" (the app takes what your plans, API keys and local servers offer; ${names}), a model "<connection>:<model>" (a connection of the section providers, also with a name its server does not list; wf call models.list lists the rest), or a plan such as "codex" (its best model for each turn)`
      : `"auto" (the app takes what is connected; ${names}) or a model "<connection>:<model>"${OFFABLE_USES.has(use) ? ', or "off"' : ''}${use === 'tts' || use === 'embeddings' ? ', or "local" (this PC)' : ''}${use === 'image' ? ', or "codex" (the ChatGPT plan)' : ''}`,
    { maxLength: 200, default: USE_AUTO });
};

/** Every setting, in the order settings.json shows them. */
export const SECTIONS: readonly SectionDef[] = [
  { key: 'profile', title: 'Profile – you and your company', keys: [
    text('name', 'Your name; agents address you by it', 'text up to 120 characters', { maxLength: 120, default: '' }),
    text('company', 'Your company\'s name (also the name of the company space)', 'text up to 200 characters', { maxLength: 200, default: '' }),
    text('avatarFileId', 'Your picture: the id of a stored file', 'a file id, or null (none)', { maxLength: 80 }),
    text('language', 'The language the agents speak with you (starts as this PC\'s; the AI sets it when you speak another)', 'a language code such as "en" or "de"', { pattern: PATTERNS.language, default: fromPc('language') }),
    text('timezone', 'Your time zone', 'an IANA time zone such as "Europe/Berlin"', { maxLength: 64, default: fromPc('timezone') }),
    text('notes', 'How you want to be spoken to, kept by the AI (a language per topic, a form of address) – every agent reads it', `text up to ${NOTES_MAX} characters`, { maxLength: NOTES_MAX, default: '' }),
  ] },
  { key: 'preferences', title: 'Window and app', keys: [
    choice('theme', 'Colour scheme of the window', ['system', 'light', 'dark'], 'system'),
    flag('sidebarOpen', 'The sidebar on the left is open', true),
    int('sidebarWidth', 'Width of the sidebar in pixels', 200, 420, 288),
    flag('workspaceOpen', 'The side pane on the right (the browser) is open', false),
    int('workspaceWidth', 'Width of the side pane in pixels', 280, 1200, 420),
    flag('enterSends', 'Enter sends a message, Shift+Enter starts a new line (false: Ctrl+Enter sends)', true),
    flag('closeToTray', 'Closing the window keeps the app and the agents running', true),
    flag('openAtLogin', 'Whether the app starts with the PC', false),
    flag('autoDownloadUpdates', 'New versions download by themselves', false),
  ] },
  { key: 'notifications', title: 'Notifications (to-dos for you, blockers and important messages always arrive)', keys: [
    flag('enabled', 'Desktop notifications for replies and finished work (the ones that always arrive are not affected)', true),
    flag('sound', 'A sound with each notification (one for a burst, also while the window has focus)', true),
    { key: 'quietHours', about: 'No replies or finished work in these hours (the ones that always arrive are not affected)', type: 'object', allowed: '{ "from": "HH:MM", "to": "HH:MM" }, or null (none)',
      schema: { properties: { from: { type: 'string', pattern: PATTERNS.clock }, to: { type: 'string', pattern: PATTERNS.clock } }, required: ['from', 'to'], additionalProperties: false } },
    { key: 'pushFor', about: 'What else interrupts you: finished work, replies (todo, blocker and important always do)', type: 'array',
      options: ['todo', 'blocker', 'important', 'done', 'reply'], default: ['todo', 'blocker', 'important'] },
  ] },
  { key: 'voice', title: 'Voice – how the app hears and speaks', keys: [
    text('ttsVoice', 'The voice that reads answers aloud', 'a voice name of this PC, or null (the default voice)', { maxLength: 200 }),
    { key: 'vocabulary', about: 'Extra names and terms speech recognition knows (for words it otherwise gets wrong)', type: 'array',
      allowed: `a list of up to ${MAX_WORDS} words, each up to 120 characters`, default: [], schema: { maxItems: MAX_WORDS, items: { type: 'string', minLength: 1, maxLength: 120 } } },
    choice('realtime', 'Voice conversations: auto = Realtime voice when an OpenAI or Google key offers it (billed per minute), off = this PC\'s speech', ['auto', 'off'], 'off'),
    flag('talker', 'A call without a real-time model: the Decisions model answers each spoken line at once while the agent works (false: the agent itself answers every line)', true),
    choice('localStt', 'This PC\'s speech-to-text model ("" = none; wf call voice.pullLocal downloads one)', ['', ...localSpeechIds('stt')], ''),
    choice('localTts', 'This PC\'s text-to-speech model ("" = none: the system voice reads)', ['', ...localSpeechIds('tts')], ''),
  ] },
  { key: 'routing', title: 'Models', keys: [
    ...MODEL_USES.map((use) => useKey(use)),
    choice('costMode', 'How models are chosen: economy saves, best takes the strongest', ['economy', 'balanced', 'best'], 'balanced'),
    flag('allowPaidFallback', 'Pay-per-use API keys: true = they compete with plans on every turn, false = an API key runs only when no plan or local model can', false),
  ] },
  { key: 'providers', title: 'Providers – the API connections', optional: true, free: true, keys: [], notes: providerNotes() },
  { key: 'day', title: 'My day', keys: [
    clock('workStart', 'Start of your working hours', DEFAULT_DAY_SETTINGS.workStart),
    clock('workEnd', 'End of your working hours (after workStart)', DEFAULT_DAY_SETTINGS.workEnd),
    int('bufferMin', 'Minutes between planned blocks', 0, MAX_BUFFER_MIN, DEFAULT_DAY_SETTINGS.bufferMin),
    flag('autoPlan', 'A plan of the day every morning', DEFAULT_DAY_SETTINGS.autoPlan),
    clock('planAt', 'When the morning plan is made', DEFAULT_DAY_SETTINGS.planAt),
    flag('aiHelps', 'My day: the AI tidies, sorts and prepares', DEFAULT_DAY_SETTINGS.aiHelps),
    flag('keepAwake', 'The screen stays on while agents work, and the PC awake while agent work is queued after working hours', DEFAULT_DAY_SETTINGS.keepAwake),
    flag('agentLane', 'The agents\' scheduled runs show in My day\'s calendar', DEFAULT_DAY_SETTINGS.agentLane),
  ] },
  { key: 'calendar', title: 'Calendar – your own Google client (calendars are connected with the tool calendar.connect)', optional: true, keys: [
    text('googleClientId', 'Your own Google OAuth client id for Google Calendar', 'a client id, or null (none)', { pattern: PATTERNS.googleClientId }),
    text('googleSecretId', 'The vault id of that client\'s secret – never the secret itself', 'a secret id, or null (none)', { maxLength: 80 }),
  ] },
  { key: 'devices', title: 'Linked PCs', keys: [
    choice('peer', 'Where this PC listens for linked PCs: lan = every network, tailscale = the tailnet only, off = never', ['lan', 'tailscale', 'off'], 'lan'),
    int('peerPort', 'Port for linked PCs (with a router forward of it, PCs connect directly over the internet)', 0, 65535, 47812, '0 = any free port'),
    flag('findable', 'Other PCs may find this PC and ask to connect (you accept each)', true),
    text('relay', 'Meeting server where PCs in other networks find each other by Remote ID (it only passes addresses)', '"wss://host", or "" (off); null = Autark\'s own', { default: DEFAULT_RELAY }),
  ] },
  { key: 'pwa', title: 'Browsers on this network or the tailnet (the phone app comes through the meeting server; skill phone-access)', keys: [
    flag('enabled', 'Unused since B-078: a phone or browser gets in while its accepted row in Settings › Devices exists', false),
    choice('bind', 'Who reaches it: localhost = this PC only, lan = the same network, tailscale = your tailnet', ['localhost', 'lan', 'tailscale'], 'localhost'),
  ] },
  { key: 'lifecycle', title: 'Data retention', optional: true, keys: [
    { key: 'retention', about: 'How long derived data is kept', type: 'object', keys: [
      int('traceDays', 'Days tool traces of finished runs are kept – a lower number deletes older ones', 0, MAX_RETENTION_DAYS, DEFAULT_RETENTION.traceDays, '0 = keep'),
      int('historyDays', 'Days corrected or expired knowledge versions are kept – a lower number deletes older ones', 0, MAX_RETENTION_DAYS, DEFAULT_RETENTION.historyDays, '0 = keep'),
    ] },
  ] },
  { key: 'feedback', title: 'Feedback reports', keys: [
    flag('includeDiagnostics', 'Unused since B-078: every report carries the end of the app\'s log, redacted', true),
  ] },
  { key: 'library', title: 'Public skill library (library/ in github.com/teydra/OpenAutark)', keys: [
    flag('publish', 'Skills worth sharing go to the public library as a pull request with your own GitHub sign-in, after the secret check finds nothing', true),
  ] },
  { key: 'onboarding', title: 'First run', keys: [
    flag('completed', 'Whether the first run is finished', false),
    choice('step', 'The first-run card on screen (done = finished)', ONBOARDING_STEPS, 'tour'),
  ] },
];

const BY_SECTION: ReadonlyMap<string, SectionDef> = new Map(SECTIONS.map((section) => [section.key, section]));

/** The section `name` (undefined: no such section). */
export const sectionDef = (name: string): SectionDef | undefined => BY_SECTION.get(name);

/** The key at 'section.key' or 'section.key.inner' (undefined: none). */
export function keyDef(path: string): KeyDef | undefined {
  const [section, ...parts] = path.split('.');
  let keys = sectionDef(section)?.keys;
  let found: KeyDef | undefined;
  for (const part of parts) {
    found = keys?.find((def) => def.key === part);
    keys = found?.keys;
  }
  return found;
}

/** The fixed choices of 'section.key' (validate.ts). */
export const optionsOf = (path: string): readonly Literal[] => keyDef(path)?.options ?? [];

/** The range of the integer 'section.key' (validate.ts). */
export function rangeOf(path: string): [number, number] {
  const def = keyDef(path);
  return [def?.min ?? 0, def?.max ?? 0];
}

/** The default of `def` (undefined: not set). */
export function defaultOf(def: KeyDef, pc: PcDefaults): unknown {
  const value = typeof def.default === 'function' ? (def.default as (pc: PcDefaults) => unknown)(pc) : def.default;
  return value === undefined ? undefined : structuredClone(value);
}

// ---------------------------------------------------------------- settings.json

const HEADER = [
  '// Autark settings: every setting of the app with its current value.',
  '// Above each key: what it does, the allowed values and the default. Change a value and save; the app applies it',
  '// within a second. An invalid value is not applied (the last good value stays) and a short notice says why.',
  '// null means the default. The app writes this file again after each change, so these lines stay current.',
];

/** A value on one line ({ "a": 1 }, ["x", "y"]). */
function oneLine(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `[${value.map(oneLine).join(', ')}]` : '[]';
  if (isPlain(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length ? `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${oneLine(item)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** A value as written after its key: one line when short, else indented JSON. */
function valueText(value: unknown, indent: string): string {
  const line = oneLine(value);
  return line.length <= 100 ? line : JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

const shown = (value: unknown): string => (typeof value === 'string' ? (value === '' ? '""' : value) : oneLine(value));
const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** The allowed values of `def` in words. */
function allowedText(def: KeyDef): string | undefined {
  if (def.type === 'integer') return `From ${def.min} to ${def.max}${def.allowed ? ` (${def.allowed})` : ''}`;
  if (def.options && def.type === 'array') return `Any of: ${def.options.join(', ')}`;
  if (def.options) return `Options: ${def.options.map(shown).join(' | ')}`;
  return def.allowed ? capital(def.allowed) : undefined;
}

/** The comment line of a key: what it does, the allowed values, the default. */
export function commentOf(def: KeyDef, pc: PcDefaults): string {
  const parts = [def.about, allowedText(def)];
  if (!def.keys) {
    const value = defaultOf(def, pc);
    parts.push(`Default: ${value === undefined ? 'null' : shown(value)}${typeof def.default === 'function' ? ' (this PC)' : ''}`);
  }
  return parts.filter(Boolean).join('. ');
}

interface Member { comments: string[]; key: string; lines: string[] }

/**
 * The members of an object: with `defs`, every defined key in their order with its comment (`asWritten`: only the
 * keys `value` has, as it has them) and then keys no definition knows; without, the value's own keys.
 */
function members(value: unknown, defs: readonly KeyDef[] | undefined, indent: string, pc: PcDefaults, asWritten: boolean): Member[] {
  const object = isPlain(value) ? value : {};
  const out: Member[] = [];
  for (const def of defs ?? []) {
    if (asWritten && !(def.key in object)) continue;
    const item = object[def.key];
    const comments = [`${indent}// ${commentOf(def, pc)}`];
    if (def.keys && (isPlain(item) || item === undefined)) {
      out.push({ comments, key: def.key, lines: objectLines(item, def.keys, indent, pc, asWritten) });
    } else {
      const shownValue = asWritten ? item : item ?? defaultOf(def, pc) ?? null;
      out.push({ comments, key: def.key, lines: [valueText(shownValue, indent)] });
    }
  }
  for (const [key, item] of Object.entries(object)) {
    if (defs?.some((def) => def.key === key) || item === undefined) continue;
    out.push({ comments: [], key, lines: [valueText(item, indent)] });
  }
  return out;
}

/** `{`, the members (comma-separated, each comment above its key), `}` – the first line follows the key. */
function objectLines(value: unknown, defs: readonly KeyDef[], indent: string, pc: PcDefaults, asWritten: boolean): string[] {
  const inner = `${indent}  `;
  const list = members(value, defs, inner, pc, asWritten);
  if (!list.length) return ['{}'];
  return ['{', ...joined(list, inner), `${indent}}`];
}

/** The members as lines: comments, `"key": value`, a comma after each but the last. */
function joined(list: readonly Member[], indent: string, gap = false): string[] {
  const lines: string[] = [];
  list.forEach((member, index) => {
    if (gap && index > 0) lines.push('');
    lines.push(...member.comments);
    const [first, ...rest] = member.lines;
    const body = [`${indent}${JSON.stringify(member.key)}: ${first}`, ...rest];
    if (index < list.length - 1) body[body.length - 1] += ',';
    lines.push(...body);
  });
  return lines;
}

/**
 * The text of settings.json: the header, "$schema", then every section with its comment and every key with its
 * comment and current value (a key not set reads null). A section in `rejected` (not applied) is written as it was
 * written, with the reason above it (`why`: section → reason); sections no definition knows follow at the end.
 */
export function settingsText(settings: Settings, pc: PcDefaults, rejected: Plain = {}, why: Readonly<Record<string, string>> = {}): string {
  const top: Member[] = [{ comments: [], key: '$schema', lines: [JSON.stringify(`./${SETTINGS_SCHEMA_FILE}`)] }];
  const reason = (section: string) => `  // Not applied (${why[section] ?? 'an invalid value'}) – the last good values are used until this is fixed.`;
  for (const section of SECTIONS) {
    const written = rejected[section.key];
    const comments = [`  // ${section.title}`, ...(section.notes ?? []).map((note) => `  // ${note}`)];
    if (written !== undefined) comments.push(reason(section.key));
    const lines = written !== undefined && !isPlain(written)
      ? [valueText(written, '  ')]
      : objectLines(written ?? (settings as unknown as Plain)[section.key], section.keys, '  ', pc, written !== undefined);
    top.push({ comments, key: section.key, lines });
  }
  for (const [key, written] of Object.entries(rejected)) {
    if (!BY_SECTION.has(key)) top.push({ comments: [reason(key)], key, lines: [valueText(written, '  ')] });
  }
  return [...HEADER, '{', ...joined(top, '  ', true), '}', ''].join('\n');
}

// ---------------------------------------------------------------- settings.schema.json

function keySchema(def: KeyDef, pc: PcDefaults): Plain {
  const out: Plain = { description: commentOf(def, pc) };
  if (def.keys) return { ...out, type: 'object', properties: propertiesOf(def.keys, pc), additionalProperties: false };
  const value = defaultOf(def, pc);
  const nullable = value === undefined;
  if (def.type === 'array') {
    Object.assign(out, { type: 'array', ...(def.options ? { items: { enum: def.options }, uniqueItems: true } : {}) });
  } else {
    out.type = nullable ? [def.type, 'null'] : def.type;
    if (def.options && def.type !== 'boolean') out.enum = nullable ? [...def.options, null] : def.options;
  }
  if (def.min !== undefined) out.minimum = def.min;
  if (def.max !== undefined) out.maximum = def.max;
  if (def.maxLength !== undefined) out.maxLength = def.maxLength;
  if (def.pattern !== undefined) out.pattern = def.pattern;
  Object.assign(out, def.schema);
  out.default = value === undefined ? null : value;
  return out;
}

function propertiesOf(defs: readonly KeyDef[], pc: PcDefaults): Plain {
  return Object.fromEntries(defs.map((def) => [def.key, keySchema(def, pc)]));
}

/** One entry of the providers section (shared/model/provider-entries.ts). */
const PROVIDER_ENTRY_SCHEMA: Plain = {
  type: 'object', additionalProperties: false, description: `An API connection; its id matches ${PROVIDER_ID.source}.`,
  properties: {
    name: { type: 'string' }, protocol: { enum: PROVIDER_PROTOCOLS }, url: { type: 'string' }, key: { type: 'string', pattern: KEY_HANDLE.source },
    models: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, uses: { type: 'array', items: { enum: MODEL_USES } } } }] } },
  },
};

/** The text of settings.schema.json (JSON Schema draft-07; allowComments/allowTrailingCommas let VS Code accept the comments). */
export function schemaText(pc: PcDefaults): string {
  const properties: Plain = { $schema: { type: 'string', description: 'This JSON Schema (written by the app).' } };
  for (const section of SECTIONS) properties[section.key] = { description: section.title, type: 'object', properties: propertiesOf(section.keys, pc), additionalProperties: section.free ? PROVIDER_ENTRY_SCHEMA : false };
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Autark settings',
    description: 'Every setting of the app (settings.json beside this file). The app writes this file from the same definitions as the comments in settings.json.',
    allowComments: true,
    allowTrailingCommas: true,
    type: 'object',
    properties,
    additionalProperties: false,
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

// ---------------------------------------------------------------- reading the text

/** The text without comments (// and /* *\/) and trailing commas – plain JSON (strings are never touched). */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  let last = -1; // index in `out` of the last piece that is not white space
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      out.push(text.slice(i, end + 1));
      last = out.length - 1;
      i = end;
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out.push(' ');
      i = end < 0 ? text.length : end + 1;
    } else {
      if ((char === '}' || char === ']') && last >= 0 && out[last] === ',') out[last] = ' ';
      out.push(char);
      if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') last = out.length - 1;
    }
  }
  return out.join('');
}

/** The file's sections, or why the whole file cannot be used. */
export function parseText(text: string): { data?: Plain; whole?: string } {
  let data: unknown;
  try {
    const json = stripJsonc(text);
    data = json.trim() ? JSON.parse(json) : {};
  } catch { return { whole: 'settings.json is not valid JSON' }; }
  return isPlain(data) ? { data } : { whole: 'settings.json is not a JSON object' };
}
