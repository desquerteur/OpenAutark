// B-055 G (WORK-PRESENCE, Q11): which files an engine-native call touches, read from its journaled tool_call row
// (agents/turn-attempt.ts writes every engine's own call there; `args` is a redacted preview of at most 2,000
// characters – a long Write or patch arrives cut, so the paths are also read from the cut text).
//   Claude Code   Edit, MultiEdit, NotebookEdit → edit · Write → write · Read → read (file_path / notebook_path)
//   Codex         apply_patch (fileChange item: files[]) → edit · shell running a patch (`*** Update File: …`) → edit,
//                 an added file → write (relative to the command's cwd)
//   ACP agents    edit_file, delete_file, move_file → edit · read_file → read (paths[] the ACP mapping adds from the
//                 call's locations – engines/acp/updates.ts –, else path / file_path / abs_path / filePath)
// Our own files tools record themselves (tools/builtin/files.ts, with the real path) and are not read here.
// Owns: that table and the argument readers. Never: guesses a path from free text (a title, a shell command other
// than a patch).

export type WorkKind = 'edit' | 'write' | 'read';

export interface Touch {
  path: string;
  kind: WorkKind;
  /** The folder a relative path is resolved against when the call names one (a Codex command's cwd). */
  base?: string;
}

type Args = Record<string, unknown>;
const MAX_TOUCHES = 20;
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'abs_path', 'filePath'];
const PATCH_LINE = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** The journaled args as an object: parsed JSON, or – for a cut preview – the string keys and arrays this module reads. */
export function readArgs(args: unknown): Args {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Args;
  if (typeof args !== 'string') return {};
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Args;
  } catch { /* a cut preview: read what is there */ }
  return cutArgs(args);
}

function unquote(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

/** The string values and string arrays of a cut JSON preview; a cut command keeps what arrived (escapes undone). */
function cutArgs(text: string): Args {
  const out: Args = {};
  for (const match of text.matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) out[match[1]] ??= unquote(match[2]);
  for (const match of text.matchAll(/"(files|paths)"\s*:\s*\[([^\]]*)/g)) out[match[1]] = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => unquote(item[1]));
  const command = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (command && typeof out.command !== 'string') out.command = command[1].replace(/\\\\/g, '\u0000').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\u0000/g, '\\');
  return out;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []);

function firstPath(args: Args): string | undefined {
  for (const key of PATH_KEYS) { const value = str(args[key]); if (value) return value; }
  return undefined;
}

function one(args: Args, kind: WorkKind): Touch[] {
  const path = firstPath(args);
  return path ? [{ path, kind }] : [];
}

/** The files of a patch in a command (Codex runs apply_patch through its shell too); relative to the command's cwd. */
export function patchFiles(command: unknown, cwd?: string): Touch[] {
  const line = Array.isArray(command) ? strings(command).join(' ') : str(command);
  if (!line || !line.includes('*** Begin Patch')) return [];
  const out: Touch[] = [];
  for (const match of line.matchAll(PATCH_LINE)) {
    const path = (match[2] ?? match[3] ?? '').trim();
    if (path) out.push({ path, kind: match[1] === 'Add' ? 'write' : 'edit', ...(cwd ? { base: cwd } : {}) });
  }
  return out;
}

function acpFiles(args: Args, kind: WorkKind): Touch[] {
  const listed = strings(args.paths);
  if (listed.length) return listed.map((path) => ({ path, kind }));
  return one(args, kind);
}

const OWN: Record<string, (args: Args) => Touch[]> = {
  Edit: (a) => one(a, 'edit'),
  MultiEdit: (a) => one(a, 'edit'),
  NotebookEdit: (a) => one(a, 'edit'),
  Write: (a) => one(a, 'write'),
  Read: (a) => one(a, 'read'),
  apply_patch: (a) => strings(a.files).map((path) => ({ path, kind: 'edit' as const })),
  shell: (a) => patchFiles(a.command, str(a.cwd)),
  edit_file: (a) => acpFiles(a, 'edit'),
  delete_file: (a) => acpFiles(a, 'edit'),
  move_file: (a) => acpFiles(a, 'edit'),
  read_file: (a) => acpFiles(a, 'read'),
};

/** The files an engine-native call touches (at most MAX_TOUCHES; a file named twice once, its strongest kind). */
export function touchesOf(name: string | undefined, args: unknown): Touch[] {
  const read = name && Object.hasOwn(OWN, name) ? OWN[name] : undefined;
  if (!read) return [];
  const seen = new Map<string, Touch>();
  for (const touch of read(readArgs(args))) {
    const known = seen.get(touch.path);
    if (!known || known.kind === 'read') seen.set(touch.path, touch);
    if (seen.size >= MAX_TOUCHES) break;
  }
  return [...seen.values()];
}
