// AF-013: what a shell command line does, as far as its text tells: its parts (`a && b`, `a | b`, `a; b`), whether
// each part only reads (ls, git status, Get-ChildItem …), whether it reaches the network (curl, git push, npm install …),
// the paths it names and the pattern an "Always for this agent" answer adds. Bash and PowerShell lines alike.
// A line with a subshell ($(…), backticks, <(…)) counts as one that may do anything: it never only reads, and an
// allow pattern never covers it.
// Owns: the parsing and these word lists. Never: decides (rules.ts does) or runs anything.

import path from 'node:path';

/** One part of a command line: its words (quotes removed) and whether it writes a file through a redirection. */
export interface CommandPart { words: string[]; text: string; redirects: boolean }

export interface ParsedCommand { parts: CommandPart[]; complex: boolean }

const SUBSHELL = /\$\(|`|<\(|>\(/;

/** Splits a line at `&&`, `||`, `;`, `|` and new lines outside quotes. */
export function splitParts(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) { current += ch; if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(current); current = ''; i += 1; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The words of one part (quotes removed); a leading PowerShell call operator `&` is dropped. */
export function wordsOf(part: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  let has = false;
  for (const ch of part) {
    if (quote) { if (ch === quote) quote = undefined; else current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || current) words.push(current); current = ''; has = false; continue; }
    current += ch; has = true;
  }
  if (has || current) words.push(current);
  if (words[0] === '&') words.shift();
  return words;
}

const HARMLESS_TARGET = /^(&[12]|\/dev\/null|\$null|nul)$/i;

/** Whether a part writes into a file through `>` / `>>` (not `2>&1`, `> /dev/null`, `> $null`). */
function redirectsToFile(part: string): boolean {
  const re = /(\d?)>>?\s*("[^"]*"|'[^']*'|[^\s]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(part))) {
    const target = (match[2] ?? '').replace(/^["']|["']$/g, '');
    if (!HARMLESS_TARGET.test(target)) return true;
  }
  return false;
}

export function parseCommand(line: string): ParsedCommand {
  const complex = SUBSHELL.test(line);
  const parts = splitParts(line).map((text) => ({ text, words: wordsOf(text), redirects: redirectsToFile(text) }));
  return { parts, complex };
}

/** The program's plain name: lower case, without folder and .exe/.cmd/.ps1. */
export function programOf(word: string | undefined): string {
  if (!word) return '';
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

const READ_PROGRAMS: ReadonlySet<string> = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'pwd', 'cd', 'echo', 'printf', 'wc', 'grep', 'egrep', 'rg', 'ag',
  'where', 'which', 'whoami', 'hostname', 'tree', 'stat', 'file', 'du', 'df', 'date', 'env', 'printenv', 'uname', 'sort', 'uniq',
  'cut', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', 'jq', 'gci', 'gc', 'gi', 'sls',
  'findstr', 'ver', 'systeminfo', 'tasklist', 'set-location', 'push-location', 'pop-location', 'write-output', 'write-host',
  'out-string', 'out-host', 'out-null',
]);
/** PowerShell verbs that only read (Get-ChildItem, Select-String, Test-Path …). */
const READ_VERBS = /^(get|select|test|measure|resolve|format|sort|where|compare|convertto|convertfrom|join|split|show|find|search)-/;
const GIT_READ: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'ls-tree', 'reflog', 'help', 'version', '--version']);
const VERSION_ONLY = /^(--version|-v|-V|version|--help|-h|help)$/;

/** Whether one part only reads (an allow list; anything unknown may change something). */
export function readsOnly(part: CommandPart): boolean {
  if (part.redirects) return false;
  const [first, ...rest] = part.words;
  const program = programOf(first);
  if (!program) return true;
  if (program === 'find') return !rest.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(word));
  if (program === 'git') {
    const sub = rest.find((word) => !word.startsWith('-'));
    if (sub === 'branch') return !rest.some((word) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(word));
    if (sub === 'remote') return rest.length <= 1 || rest.includes('-v');
    if (sub === 'tag') return rest.length <= 1 || rest.includes('-l') || rest.includes('--list');
    return sub !== undefined && GIT_READ.has(sub);
  }
  if (READ_PROGRAMS.has(program) || READ_VERBS.test(program)) return true;
  return rest.length === 1 && VERSION_ONLY.test(rest[0]!); // node --version, python -V …
}

const NET_PROGRAMS: ReadonlySet<string> = new Set([
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat',
  'telnet', 'start-bitstransfer', 'gh', 'az', 'aws', 'gcloud', 'vercel', 'netlify', 'firebase',
]);
const NET_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']),
  npm: new Set(['install', 'i', 'ci', 'add', 'publish', 'update', 'upgrade', 'exec', 'x']), npx: new Set(['*']),
  pnpm: new Set(['install', 'i', 'add', 'publish', 'update', 'up', 'dlx']), yarn: new Set(['install', 'add', 'publish', 'upgrade', 'dlx']),
  bun: new Set(['install', 'i', 'add', 'x']), bunx: new Set(['*']), pip: new Set(['install', 'download']), pip3: new Set(['install', 'download']),
  uv: new Set(['add', 'sync', 'pip']), winget: new Set(['install', 'upgrade']), choco: new Set(['install', 'upgrade']), scoop: new Set(['install', 'update']),
  docker: new Set(['pull', 'push', 'login']), cargo: new Set(['install', 'publish', 'fetch']), go: new Set(['get', 'install']),
};

/** Whether one part reaches the network (a known downloader, a remote git or package command). */
export function reachesNetwork(part: CommandPart): boolean {
  const [first, ...rest] = part.words;
  const program = programOf(first);
  if (NET_PROGRAMS.has(program)) return true;
  const subs = NET_SUBCOMMANDS[program];
  if (!subs) return false;
  if (subs.has('*')) return true;
  const sub = rest.find((word) => !word.startsWith('-'));
  return sub !== undefined && subs.has(sub.toLowerCase());
}

const ABSOLUTE = /^([a-zA-Z]:[\\/]|\\\\|\/(?!dev\/null$)|~)/;

/** The paths a part names: absolute ones, `~…` and any with a `..` step (resolved against `cwd`); flags' `=value`s too. */
export function pathsIn(part: CommandPart, cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const out: string[] = [];
  for (const word of part.words.slice(1)) {
    const value = word.includes('=') && word.startsWith('-') ? word.slice(word.indexOf('=') + 1) : word;
    if (!value) continue;
    if (value.startsWith('~')) { out.push(value); continue; }
    if (ABSOLUTE.test(value)) { out.push(impl.resolve(value)); continue; }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) out.push(impl.resolve(cwd, value));
  }
  return out;
}

/** The pattern "Always for this agent" adds for this line: program and subcommand with ` *`, else the line itself. */
export function commandPattern(line: string): string {
  const parsed = parseCommand(line);
  const only = parsed.parts.length === 1 && !parsed.complex ? parsed.parts[0]! : undefined;
  if (!only) return line.trim();
  const [first, second] = only.words;
  if (!first) return line.trim();
  if (second && /^[a-z][a-z0-9:_-]*$/i.test(second)) return `${first} ${second} *`;
  return only.words.length === 1 ? first : `${first} *`;
}

/** `pattern` (`*` = anything, case-insensitive, whitespace folded) covers `text`. */
export function globMatch(pattern: string, text: string): boolean {
  const fold = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const source = fold(pattern).split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  // "git push *" also covers a bare "git push".
  return new RegExp(`^${source.replace(/ \.\*$/, '( .*)?')}$`).test(fold(text));
}
