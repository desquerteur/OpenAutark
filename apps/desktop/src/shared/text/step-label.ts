// A run step as the person reads it (D5, "like Codex"): a tool call's name and arguments become a
// kind (the UI picks its icon), a verb ("Ran" when done, "Running" while it runs) and a target
// ("npm test", "src/app.ts", "“open invoices”") – for the compact step lines in chats and Team ›
// agent › Runs, the journaled summary of engine-native calls and the live status line. Also the
// headline of a reasoning summary ("Thought · <headline>").
// Engine-native names (Codex shell/apply_patch/web_search, Claude Code Bash/Read/Grep/Edit…, ACP
// kinds) and our own tools share one table; anything else keeps the engine's title or the
// journaled summary, else its plain name – never a target the call did not name.
// C3 fix: a call that names no target reads in the tool's own words ("Ran a command" / "Running a
// command", "Showing a page") – the same table turns an engine's bare live note into what the agent
// does ("bash" → "running a command", ui/lib/format.ts workNote), so the run line and the chat
// header say the same; only a real command is set as code (isCommandText).
// Owns: this wording (unit-tested in test/unit/ui/step-label.test.ts). Never: reads files, runs anything.

export type StepKind =
  | 'command' | 'read' | 'edit' | 'search' | 'list' | 'web' | 'browser' | 'computer' | 'chat' | 'task'
  | 'agent' | 'memory' | 'image' | 'mcp' | 'plan' | 'tool';

export interface StepLabel {
  kind: StepKind;
  /** Past tense for a finished step ("Ran"); '' when the target says it all (a summary, a title). */
  verb: string;
  /** Present tense while the step runs ("Running"); '' like `verb`. */
  active: string;
  target: string;
}

export interface StepHints {
  /** True for an engine-native call (a dotted name is then an MCP server's tool, not ours). */
  own?: boolean;
  /** The journaled human summary (our tools' action summary, an engine-native call's title). */
  summary?: string;
  /** The engine's own line for the call (ACP title). */
  title?: string;
}

const TARGET_MAX = 160;

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** One line, at most `max` characters. */
export function oneLine(value: string, max = TARGET_MAX): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The last three parts of a path ("…/ui/chat/List.tsx"), with forward slashes. */
export function shortPath(value: string): string {
  const parts = value.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return value.trim().replace(/\\/g, '/');
  return `…/${parts.slice(-3).join('/')}`;
}

const SHELLS = /^(?:bash|sh|zsh|dash|fish|powershell|pwsh|cmd)(?:\.exe)?$/i;
const SHELL_FLAGS = /^(?:-lc|-c|-command|\/c|\/s|-noprofile|-nologo|-noninteractive|-executionpolicy|bypass|-l|-i)$/i;
// "C:\…\powershell.exe" -NoProfile -Command "Get-ChildItem" → Get-ChildItem (also bash -lc '…', cmd /d /c …);
// a quoted shell path may hold spaces ("C:\Program Files\PowerShell\7\pwsh.exe").
const WRAPPED = /^\s*(?:"(?:[^"]*[\\/])?(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?"|(?:[^"\s]*[\\/])?(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?)\s+(?:(?:-NoProfile|-NoLogo|-NonInteractive|-ExecutionPolicy\s+\S+|-l|\/d|\/s)\s+)*(?:-lc|-c|-Command|\/c)\s+([\s\S]+)$/i;

function unquote(value: string): string {
  const v = value.trim();
  return v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
}

/** The command a shell call runs, without the shell wrapper the engine put around it. */
export function commandText(args: unknown): string | undefined {
  const a = rec(args);
  const value = a.command ?? a.cmd;
  if (Array.isArray(value)) {
    const parts = value.map(String);
    if (parts.length > 1 && SHELLS.test(parts[0].replace(/^.*[\\/]/, ''))) {
      const rest = parts.slice(1);
      while (rest.length > 1 && SHELL_FLAGS.test(rest[0])) rest.shift();
      return rest.join(' ').trim() || undefined;
    }
    return parts.join(' ').trim() || undefined;
  }
  const line = text(value);
  if (!line) return undefined;
  const wrapped = WRAPPED.exec(line);
  return wrapped ? unquote(wrapped[1]) : line.trim();
}

function pathOf(args: unknown): string | undefined {
  const a = rec(args);
  return text(a.file_path) ?? text(a.path) ?? text(a.abs_path) ?? text(a.notebook_path) ?? text(a.file) ?? text(a.filename);
}

function filesOf(args: unknown): string {
  const a = rec(args);
  const list = Array.isArray(a.files) ? a.files.filter((file): file is string => typeof file === 'string' && file.trim() !== '') : [];
  if (!list.length) { const one = pathOf(args); return one ? shortPath(one) : ''; }
  const names = list.slice(0, 3).map((file) => file.replace(/\\/g, '/').split('/').pop() ?? file);
  return list.length > 3 ? `${names.join(', ')} +${list.length - 3}` : names.join(', ');
}

function quoted(value: string | undefined): string {
  return value ? `“${oneLine(value, 100)}”` : '';
}

function urlText(value: string | undefined): string {
  if (!value) return '';
  return oneLine(value.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), 100);
}

/** "tasks.create" → "Tasks create", "mcp__github__create_issue" → "github · create issue". */
function plainName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}`;
  const words = name.replace(/[._]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Tool';
}

const label = (kind: StepKind, verb: string, active: string, target: string): StepLabel => ({ kind, verb, active, target: oneLine(target) });

const COMMAND = new Set(['shell', 'bash', 'execute', 'exec', 'exec_command', 'local_shell', 'run_shell_command', 'powershell', 'shell.exec', 'secrets.run']);
const READ = new Set(['read', 'read_file', 'files.read', 'notebookread', 'view']);
const EDIT = new Set(['edit', 'multiedit', 'edit_file', 'apply_patch', 'notebookedit', 'str_replace_based_edit_tool', 'replace']);
const WRITE = new Set(['write', 'write_file', 'files.write']);
const SEARCH = new Set(['grep', 'search', 'files.search', 'search_file_content', 'glob', 'find']);
const LIST = new Set(['ls', 'list', 'files.list', 'list_directory']);
const WEB_SEARCH = new Set(['web_search', 'websearch', 'web.search', 'google_web_search']);
const WEB_OPEN = new Set(['web_fetch', 'webfetch', 'web.fetch', 'fetch']);
const PLAN = new Set(['todowrite', 'update_plan', 'exitplanmode']);
const AGENT = new Set(['task', 'agent', 'agents.delegate', 'agents.handoff']);

/** A tool's own words for a call that names no target: [past, present, object] ("Ran" / "Running" "a
 *  command"). Names as engines report them: dotted, underscored or spaced ("browser.show", "Browser show"). */
const DOING: ReadonlyArray<readonly [RegExp, string, string, string]> = [
  [/^(?:shell|bash|sh|exec|execute|exec_command|local_shell|run_shell_command|powershell|shell[ ._]exec|secrets[ ._]run)$/, 'Ran', 'Running', 'a command'],
  [/^(?:read|read_file|files[ ._]read|view|notebookread)$/, 'Read', 'Reading', 'a file'],
  [/^(?:write|write_file|files[ ._]write)$/, 'Wrote', 'Writing', 'files'],
  [/^(?:edit|multiedit|edit_file|apply_patch|notebookedit|str_replace_based_edit_tool|replace)$/, 'Edited', 'Editing', 'files'],
  [/^(?:grep|glob|find|search|search_file_content|files[ ._]search)$/, 'Searched', 'Searching', 'files'],
  [/^(?:ls|list|list_directory|files[ ._]list)$/, 'Listed', 'Listing', 'a folder'],
  [/^(?:web[ ._]?search|google_web_search)$/, 'Searched', 'Searching', 'the web'],
  [/^(?:web[ ._]?fetch|fetch|browser[ ._](?:navigate|open|goto))$/, 'Opened', 'Opening', 'a page'],
  [/^browser[ ._]show$/, 'Showed', 'Showing', 'a page'],
  [/^(?:browser|playwright)(?:[ ._].*)?$/, 'Used', 'Using', 'the browser'],
  [/^computer(?:[ ._].*)?$/, 'Used', 'Using', 'the computer'],
  [/^(?:todowrite|update_plan|exitplanmode)$/, 'Updated', 'Updating', 'the plan'],
  [/^(?:image_generation|media[ ._]image)$/, 'Made', 'Making', 'an image'],
];

const doing = (name: string) => DOING.find(([pattern]) => pattern.test(name.trim().toLowerCase()));

/** What the agent does when an engine's live note is a bare tool name ("bash" → "running a command",
 *  "browser.show" → "showing a page"); undefined for any other note. */
export function toolDoing(name: string): string | undefined {
  const row = doing(name);
  return row ? `${row[2].toLowerCase()} ${row[3]}` : undefined;
}

/** True when the step's target is the call's own command line (drawn as code) – not the words a call
 *  without one reads in ("Ran a command") or an engine's title for it. */
export function isCommandText(step: StepLabel): boolean {
  return step.kind === 'command' && step.verb !== '' && step.target !== '' && step.target !== 'a command';
}

/** B-057: the split tools – "Split into 3 parts" / "Splitting into 3 parts", "Read split results", "Stopped splits",
 *  "Merged split part #2" / "Discarded split part #2" (by its action, else its summary "Discard part #2 …").
 *  The count comes from the call's parts, else from its summary ("Split into 3 parts: …"). */
function splitStep(n: string, a: Record<string, unknown>, told: string | undefined): StepLabel | undefined {
  if (n === 'agents.split_results') return label('agent', 'Read', 'Reading', 'split results');
  if (n === 'agents.split_stop') return label('agent', 'Stopped', 'Stopping', 'splits');
  if (n === 'agents.split_merge') {
    const discard = a.action === 'discard' || (a.action === undefined && /^\s*discard\b/i.test(told ?? ''));
    const part = `split part${Number.isInteger(a.idx) && (a.idx as number) > 0 ? ` #${a.idx}` : ''}`;
    return discard ? label('agent', 'Discarded', 'Discarding', part) : label('agent', 'Merged', 'Merging', part);
  }
  if (n !== 'agents.split') return undefined;
  const count = Array.isArray(a.parts) ? a.parts.length : Number(/\binto (\d+) parts?\b/i.exec(told ?? '')?.[1] ?? NaN);
  return label('agent', 'Split', 'Splitting', Number.isInteger(count) && count > 0 ? `into ${count} part${count === 1 ? '' : 's'}` : 'into parts');
}

/** The step line for one tool call. */
export function stepLabel(name: string | undefined, args: unknown, hints: StepHints = {}): StepLabel {
  const raw = (name ?? '').trim();
  const n = raw.toLowerCase();
  const told = text(hints.title) ?? text(hints.summary);
  const a = rec(args);
  /** No target named: the engine's title or summary, else the tool's own words, else its plain name. */
  const fallback = (kind: StepKind): StepLabel => {
    if (told) return label(kind, '', '', told);
    const row = doing(n);
    return row ? label(kind, row[1], row[2], row[3]) : label(kind, '', '', plainName(raw));
  };
  if (COMMAND.has(n)) { const command = commandText(args); return command ? label('command', 'Ran', 'Running', command) : fallback('command'); }
  if (READ.has(n)) { const file = pathOf(args); return file ? label('read', 'Read', 'Reading', shortPath(file)) : fallback('read'); }
  if (EDIT.has(n) || WRITE.has(n) || n === 'delete_file' || n === 'move_file') {
    const files = filesOf(args);
    const [verb, active] = WRITE.has(n) ? ['Wrote', 'Writing'] : n === 'delete_file' ? ['Deleted', 'Deleting'] : n === 'move_file' ? ['Moved', 'Moving'] : ['Edited', 'Editing'];
    return files ? label('edit', verb, active, files) : told ? fallback('edit') : label('edit', verb, active, 'files');
  }
  if (SEARCH.has(n)) {
    const pattern = text(a.pattern) ?? text(a.query) ?? text(a.regex) ?? text(a.glob);
    const where = pathOf(args) ?? text(a.dir_path);
    if (!pattern) return fallback('search');
    return label('search', 'Searched', 'Searching', `${quoted(pattern)}${where ? ` in ${shortPath(where)}` : ''}`);
  }
  if (LIST.has(n)) { const where = pathOf(args) ?? text(a.dir_path); return label('list', 'Listed', 'Listing', where ? shortPath(where) : 'a folder'); }
  if (WEB_SEARCH.has(n)) { const query = text(a.query) ?? text(a.q); return query ? label('web', 'Searched the web', 'Searching the web', quoted(query)) : label('web', 'Searched', 'Searching', 'the web'); }
  if (WEB_OPEN.has(n)) { const url = urlText(text(a.url) ?? text(a.uri)); return url ? label('web', 'Opened', 'Opening', url) : fallback('web'); }
  if (PLAN.has(n)) return label('plan', 'Updated', 'Updating', 'the plan');
  if (AGENT.has(n)) return label('agent', '', '', text(a.description) ?? told ?? plainName(raw));
  if (n === 'image_generation' || n === 'media.image') return fallback('image');
  if (n === 'think') return label('plan', '', '', told ?? 'Thought it over');
  if (n.startsWith('browser') || n.startsWith('playwright')) {
    const url = urlText(text(a.url));
    return url && /navigate|open|goto/.test(n) ? label('browser', 'Opened', 'Opening', url) : fallback('browser');
  }
  if (n === 'computer' || n.startsWith('computer.') || n.startsWith('computer_')) return fallback('computer');
  if (n === 'chat.send') return label('chat', '', '', told ?? 'Posted in the chat');
  if (n.startsWith('chat.')) return label('chat', '', '', told ?? plainName(raw));
  if (n.startsWith('tasks.') || n.startsWith('todos.')) return label('task', '', '', told ?? (text(a.title) ? `${plainName(raw)}: ${text(a.title)}` : plainName(raw)));
  const split = splitStep(n, a, told); // B-057
  if (split) return split;
  if (n.startsWith('agents.')) return label('agent', '', '', told ?? plainName(raw));
  if (n.startsWith('knowledge.') || n.startsWith('memory')) return label('memory', '', '', told ?? (text(a.query) ? `Looked up ${quoted(text(a.query))}` : plainName(raw)));
  if (n.startsWith('mcp__') || (hints.own && n.includes('.'))) return label('mcp', '', '', told ?? plainName(raw));
  return label('tool', '', '', told ?? plainName(raw));
}

/** The line as plain text ("Ran npm test"; `running` → "Running npm test"). */
export function stepText(step: StepLabel, running = false): string {
  const verb = running ? step.active : step.verb;
  return [verb, step.target].filter(Boolean).join(' ');
}

const TITLE = /^\s*\*\*([^*\n]{1,120})\*\*\s*$/;

/**
 * The headline of a reasoning summary: its latest "**Title**" line (Codex marks each section so),
 * else its first sentence (at most 80 characters); '' for an empty text.
 */
export function reasoningHeadline(summary: string): string {
  const lines = summary.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = TITLE.exec(lines[i]);
    if (match) return oneLine(match[1], 80);
  }
  const flat = summary.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentence = /^(.+?[.!?:])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return oneLine(sentence.replace(/[.:]$/, ''), 80);
}
