// Engine-neutral mapping of engine-native tool calls for the native rebuild (B-049, owner's question 29.10.: an agent
// that switches engine sees its earlier tool work as if it had done it itself). A ledger call of a CLI's own tool
// is read into what it did (NeutralCall) and written back as the target's equivalent:
//   Claude Bash / PowerShell, Codex shell  ->  Codex exec_command (function_call; unified_exec's tool, kept by every
//                                              lean agent thread – helper-thread.ts AGENT_FEATURES_KEPT) | Claude Bash,
//                                              PowerShell on Windows when the command ran in PowerShell
//   Claude Read                            ->  our files.read {path, fromLine, lines}
//   Claude Grep / Glob                     ->  our files.search {query, path, content}
//   Claude Edit / MultiEdit / Write, Codex apply_patch -> a text note with the diff or the new content (no exact
//                                              counterpart: Codex's patch grammar is not kept, an Edit needs the old text)
//   Claude's own tools back into Claude Code -> the same tool_use, verbatim (exact)
//   Codex code mode's exec / wait (B-049 F9) -> into Codex the same custom_tool_call / function_call, when the probe saw
//                                              Codex take them and the script's source is whole; else a note with the
//                                              script (bounded) – its nested calls are never mapped one by one
// exec_command's argument names (cmd, shell) read from codex-cli 0.165.0-alpha.1.2 (its tool schema strings); a Codex
// commandExecution's `command` is its argv joined with POSIX quoting (`"…\powershell.exe" -Command '…'` on Windows,
// `/bin/bash -lc '…'` elsewhere), so the script is read back from that line.
// Owns: the table, the readers of each native call's arguments, the shell-line parsing and the target forms.
// Never: maps a call whose arguments are cut (a journal preview that is no JSON object any more), a tool of another
// engine than its origin, a tool the target lacks (Codex: the thread's dynamic tools; Claude: its built-in core and
// the hub), or a call the target tool cannot mean (files.search finds plain text: a Grep regex or glob/type filter,
// a Glob folder wildcard other than `**`; files.read reads text: a Read of an image, PDF or notebook; a background
// Bash run) – those stay notes; never invents a call: every mapped call is a real earlier call with its real output.

import type { RebuildItem } from './types.ts';
import { OUTPUT_CAP, boundOutput } from './output.ts';
import { CODE_EXEC, CODE_WAIT, isScriptCall, scriptSource } from './code-mode.ts';

type Call = NonNullable<RebuildItem['call']>;
type Args = Record<string, unknown>;
type Shell = 'powershell' | 'bash' | 'direct';

/** What an engine-native call did, independent of the engine that ran it. */
export type NeutralCall =
  /** `command`: the script in its shell ('direct': a command line run without a known shell); `line`: a POSIX command line that runs it. */
  | { kind: 'shell'; shell: Shell; command: string; line: string }
  | { kind: 'read'; path: string; fromLine?: number; lines?: number }
  | { kind: 'search'; query: string; path?: string; content: boolean }
  /** `body`: the diff or new content when the arguments carry it (a Codex patch's diffs are in its output). */
  | { kind: 'edit'; path: string; body?: string };

/** The target of a rebuild. */
export interface MapTarget {
  engine: 'codex' | 'claude';
  /** Our tools the coming turn can call (Codex: the thread's dynamic tools; Claude: the hub's). */
  offered: ReadonlySet<string>;
  /** The target CLI's own tools (Codex: CODEX_NATIVE; Claude: lean.ts coreTools). */
  native: ReadonlySet<string>;
  platform: string;
  /** B-049 F9, Codex: the version's probe saw custom_tool_call items injected (exec replays natively). */
  custom?: boolean;
}

/**
 * How a call replays: one of our tools, the target CLI's own tool, its own custom tool (`input`: the raw text – Codex
 * exec), or a text note (`detail`: an edit's diff/content, a script's source).
 */
export type Mapped = { as: 'hub' | 'native'; name: string; args: Args } | { as: 'custom'; name: string; input: string } | { as: 'note'; detail?: string };

/** A script's source in its note at most (head and tail). */
const SCRIPT_NOTE_CHARS = 4_000;

/** Codex's own shell tool (unified_exec) and the native tools of a lean Codex agent thread this module maps to. */
export const CODEX_SHELL = 'exec_command';
export const CODEX_NATIVE: ReadonlySet<string> = new Set([CODEX_SHELL]);
const QUERY_MAX = 200; // files.search's query bound
const PATH_MAX = 1024;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined);

/** POSIX single quoting ('…', a quote as '\''); a plain word stays as it is. */
export function posixQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A POSIX-quoted command line as its words; undefined when a quote is not closed. */
export function shellWords(line: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let open = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end); open = true; i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length && '$`"\\\n'.includes(line[j + 1])) j++;
        word += line[j];
      }
      if (j >= line.length) return undefined;
      open = true; i = j;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]; open = true;
    } else if (/\s/.test(c)) {
      if (open) words.push(word);
      word = ''; open = false;
    } else { word += c; open = true; }
  }
  if (open) words.push(word);
  return words;
}

/** A program's bare name ("C:\…\powershell.exe" → "powershell"). */
const program = (word: string): string => (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

/** A Codex commandExecution's command line read back: the script and the shell it ran in. */
export function codexShell(command: unknown): NeutralCall | undefined {
  const line = Array.isArray(command) && command.every((part) => typeof part === 'string') ? command.map(posixQuote).join(' ') : text(command);
  if (!line) return undefined;
  const words = shellWords(line);
  const name = words?.length ? program(words[0]) : '';
  if (words && (name === 'powershell' || name === 'pwsh')) {
    const at = words.findIndex((word, index) => index > 0 && /^-(c|command)$/i.test(word));
    const script = at > 0 ? words.slice(at + 1).join(' ') : '';
    if (script.trim()) return { kind: 'shell', shell: 'powershell', command: script, line };
  }
  if (words && ['bash', 'sh', 'zsh', 'dash'].includes(name)) {
    const at = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
    const script = at > 0 ? words[at + 1] : undefined;
    if (script?.trim()) return { kind: 'shell', shell: 'bash', command: script, line };
  }
  return { kind: 'shell', shell: 'direct', command: line, line };
}

/** A Claude Glob as a files.search name search: the last segment is the name pattern, the literal folders before the first wildcard the path. */
export function globSearch(pattern: unknown, base: unknown): NeutralCall | undefined {
  const given = text(pattern)?.replace(/\\/g, '/');
  if (!given) return undefined;
  const cut = given.lastIndexOf('/');
  const name = given.slice(cut + 1);
  if (!name || name === '**' || /[[\]{}]/.test(name)) return undefined; // files.search knows * and ? only
  const folders = cut >= 0 ? given.slice(0, cut).split('/') : [];
  const wild = folders.findIndex((part) => /[*?[\]{}]/.test(part));
  // files.search walks every folder below its path: only `**` folders after the literal ones mean the same.
  if (wild >= 0 && folders.slice(wild).some((part) => part !== '**')) return undefined;
  const literal = (wild < 0 ? folders : folders.slice(0, wild)).join('/');
  const root = text(base)?.replace(/[\\/]+$/, '');
  const absolute = /^([A-Za-z]:)?\//.test(literal);
  const path = absolute ? literal : [root, literal].filter(Boolean).join('/');
  return { kind: 'search', query: name, ...(path ? { path } : {}), content: false };
}

/** A Claude Edit/MultiEdit's change as diff lines. */
function editBody(args: Args): string | undefined {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  const hunks = edits.filter((edit): edit is Args => !!edit && typeof edit === 'object' && typeof (edit as Args).new_string === 'string')
    .map((edit) => {
      const lines = (value: unknown, sign: string) => (typeof value === 'string' && value ? value.split('\n').map((line) => `${sign}${line}`) : []);
      return [...lines(edit.old_string, '-'), ...lines(edit.new_string, '+'), ...(edit.replace_all === true ? ['(every occurrence)'] : [])].join('\n');
    });
  return hunks.length ? hunks.join('\n@@\n') : undefined;
}

function claudeShell(shell: 'bash' | 'powershell', args: Args): NeutralCall | undefined {
  const command = text(args.command);
  // A background run's output names a shell id only Claude Code's own output tools know: no exec_command meaning.
  if (!command || args.run_in_background === true) return undefined;
  return { kind: 'shell', shell, command, line: shell === 'bash' ? command : `powershell -Command ${posixQuote(command)}` };
}

/** Files Claude Code's Read shows as images, PDF pages or notebook cells – files.read reads text only. */
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i;
/** Regular-expression syntax: files.search finds a plain text (a `.` is taken as itself – a literal dot in practice). */
const REGEX_SYNTAX = /[\\^$*+?()[\]{}|]/;

function claudeRead(args: Args): NeutralCall | undefined {
  const path = text(args.file_path);
  if (!path || MEDIA_FILE.test(path) || args.pages !== undefined) return undefined;
  const fromLine = count(args.offset);
  const lines = count(args.limit);
  return { kind: 'read', path, ...(fromLine ? { fromLine } : {}), ...(lines ? { lines } : {}) };
}

function claudeGrep(args: Args): NeutralCall | undefined {
  const pattern = text(args.pattern);
  const path = text(args.path);
  // Grep takes a regular expression and narrowing filters; files.search a plain text without them – only that maps
  // (an escaped sign like `\.` is that sign as text).
  if (!pattern || REGEX_SYNTAX.test(pattern.replace(/\\[^A-Za-z0-9]/g, '')) || text(args.glob) || text(args.type) || args.multiline === true) return undefined;
  const query = pattern.replace(/\\([^A-Za-z0-9])/g, '$1');
  return { kind: 'search', query, ...(path ? { path } : {}), content: true };
}

function claudeEdit(args: Args, body: string | undefined): NeutralCall | undefined {
  const path = text(args.file_path);
  return path ? { kind: 'edit', path, ...(body ? { body } : {}) } : undefined;
}

/** The table: each engine-native tool, the engine that has it, and how its arguments read. */
const FROM: Record<string, { engine: 'claude' | 'codex'; read: (args: Args) => NeutralCall | undefined }> = {
  Bash: { engine: 'claude', read: (a) => claudeShell('bash', a) },
  PowerShell: { engine: 'claude', read: (a) => claudeShell('powershell', a) },
  Read: { engine: 'claude', read: claudeRead },
  Grep: { engine: 'claude', read: claudeGrep },
  Glob: { engine: 'claude', read: (a) => globSearch(a.pattern, a.path) },
  Edit: { engine: 'claude', read: (a) => claudeEdit(a, editBody(a)) },
  MultiEdit: { engine: 'claude', read: (a) => claudeEdit(a, editBody(a)) },
  Write: { engine: 'claude', read: (a) => claudeEdit(a, typeof a.content === 'string' ? a.content : undefined) },
  shell: { engine: 'codex', read: (a) => codexShell(a.command) },
  apply_patch: { engine: 'codex', read: (a) => ({ kind: 'edit', path: Array.isArray(a.files) ? a.files.filter((f) => typeof f === 'string').join(', ') : '' }) },
};

/** Call arguments as an object; undefined for a cut journal preview (no JSON object). */
export function argsRecord(args: unknown): Args | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Args;
  if (typeof args !== 'string') return undefined;
  try { const parsed = JSON.parse(args); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Args : undefined; } catch { return undefined; }
}

/** What a native call did; undefined for a tool outside the table, another origin's tool or cut arguments. */
export function neutralOf(call: Pick<Call, 'name' | 'args'>, origin?: string): NeutralCall | undefined {
  const entry = Object.hasOwn(FROM, call.name) ? FROM[call.name] : undefined;
  const args = argsRecord(call.args);
  if (!entry || !args || (origin && origin !== entry.engine)) return undefined;
  return entry.read(args);
}

const note = (call: NeutralCall | undefined): Mapped => ({ as: 'note', ...(call?.kind === 'edit' && call.body ? { detail: boundOutput(call.body, OUTPUT_CAP) } : {}) });

/** Our files tool for a read or search, when the target offers it and the arguments fit its schema. */
function filesTool(call: NeutralCall, offered: ReadonlySet<string>): Mapped | undefined {
  if (call.kind === 'read' && offered.has('files.read') && call.path.length <= PATH_MAX) {
    return { as: 'hub', name: 'files.read', args: { path: call.path, ...(call.fromLine ? { fromLine: call.fromLine } : {}), ...(call.lines ? { lines: call.lines } : {}) } };
  }
  if (call.kind === 'search' && offered.has('files.search') && call.query.length <= QUERY_MAX && (call.path?.length ?? 0) <= PATH_MAX) {
    return { as: 'hub', name: 'files.search', args: { query: call.query, ...(call.path ? { path: call.path } : {}), content: call.content } };
  }
  return undefined;
}

/** A neutral call on Codex: exec_command for a shell (with `shell` when it is not the platform's default), our files tools, else a note. */
export function toCodex(call: NeutralCall, target: Pick<MapTarget, 'offered' | 'native' | 'platform'>): Mapped {
  if (call.kind === 'shell') {
    if (!target.native.has(CODEX_SHELL)) return note(call);
    const windows = target.platform === 'win32';
    const shell = call.shell === 'powershell' && !windows ? 'powershell' : call.shell === 'bash' && windows ? 'bash' : undefined;
    return { as: 'native', name: CODEX_SHELL, args: { cmd: call.command, ...(shell ? { shell } : {}) } };
  }
  return filesTool(call, target.offered) ?? note(call);
}

/** A neutral call on Claude Code: Bash (PowerShell on Windows for a PowerShell script), our files tools, else a note. */
export function toClaude(call: NeutralCall, target: Pick<MapTarget, 'offered' | 'native'>): Mapped {
  if (call.kind === 'shell') {
    if (call.shell === 'powershell' && target.native.has('PowerShell')) return { as: 'native', name: 'PowerShell', args: { command: call.command } };
    if (target.native.has('Bash')) return { as: 'native', name: 'Bash', args: { command: call.shell === 'bash' ? call.command : call.line } };
    return note(call);
  }
  return filesTool(call, target.offered) ?? note(call);
}

/**
 * B-049 F9: a code-mode call. Into Codex (custom items taken) exec as its custom tool with the whole source, wait as its
 * function call; otherwise a note – an exec note carries the script (bounded; a cut record as it is).
 */
function scriptCall(call: Pick<Call, 'name' | 'args'>, target: MapTarget): Mapped {
  const source = scriptSource(call.args);
  const native = target.engine === 'codex' && target.custom === true;
  if (call.name === CODE_WAIT) {
    const args = argsRecord(call.args);
    return native && args ? { as: 'native', name: CODE_WAIT, args } : note(undefined);
  }
  if (native && source) return { as: 'custom', name: CODE_EXEC, input: source };
  const text = (source ?? (typeof call.args === 'string' ? call.args : '')).trimEnd();
  return text.trim() ? { as: 'note', detail: boundOutput(text, SCRIPT_NOTE_CHARS) } : note(undefined);
}

/** An engine-native ledger call (not one of ours) as the target replays it. */
export function mapNativeCall(call: Pick<Call, 'name' | 'args'>, origin: string | undefined, target: MapTarget): Mapped {
  if (isScriptCall(call.name, origin)) return scriptCall(call, target);
  const entry = Object.hasOwn(FROM, call.name) ? FROM[call.name] : undefined;
  const args = argsRecord(call.args);
  // Exact: Claude Code's own tool back into Claude Code, with its own input.
  if (target.engine === 'claude' && entry?.engine === 'claude' && args && (!origin || origin === 'claude') && target.native.has(call.name)) {
    return { as: 'native', name: call.name, args };
  }
  const neutral = neutralOf(call, origin);
  if (!neutral) return note(undefined);
  return target.engine === 'codex' ? toCodex(neutral, target) : toClaude(neutral, target);
}
