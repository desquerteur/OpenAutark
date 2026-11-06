// files.search (B-047 D1): find files by name or by a text inside them, read-only and bounded, where files.list
// reads (files.ts readPath: the workspace or any absolute path on this PC). Without a path it searches the workspace,
// then the person's home folder (F2: the workspace is empty at the start, the person's material lies in the home) –
// without the home's app data folders (HOME_SKIP: AppData, Library …; also when the home is the path) and, for a
// search inside files, its OneDrive folders (reading a cloud-only file downloads it). Bounds: SEARCH_MS per search (and the run's stop), MAX_ENTRIES
// entries looked at (HOME_ENTRIES with the home), MAX_DEPTH folder levels, content only of files up to CONTENT_BYTES
// that look like text, at most `maxResults` hits. Not visited: hidden entries, dependency/build folders and links (a
// search stays where it started). Shown lines are redacted. An empty search of the workspace alone names the person's
// home folder as the wider place (a fact).
// Owns: the walk, its roots and bounds, and the result text. Never: writes, follows links, or runs for a linked PC.

import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool } from './util.ts';

/** Dependency and build folders no search walks into. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'env', 'site-packages', 'bin', 'obj']);
const skipped = (name: string, directory: boolean): boolean => name.startsWith('.') || (directory && SKIP_DIRS.has(name.toLowerCase()));
/** Folders right below the home folder that hold programs' data and caches, not the person's own files. */
const HOME_SKIP: ReadonlySet<string> = new Set(['appdata', 'application data', 'local settings', 'library', 'snap']);
const homeSkipped = (name: string, content: boolean): boolean => HOME_SKIP.has(name.toLowerCase()) || (content && name.toLowerCase().startsWith('onedrive'));

export const SEARCH_MS = 8_000;
export const MAX_ENTRIES = 20_000;
/** Entries a search without a path may look at: the workspace and the home folder together (F2: ~4 s on a busy PC). */
export const HOME_ENTRIES = 60_000;
const MAX_DEPTH = 12;
const CONTENT_BYTES = 1024 * 1024;
const DEFAULT_RESULTS = 50;
const MAX_RESULTS = 200;
const LINES_PER_FILE = 12;

interface SearchArgs { query: string; path?: string; content?: boolean; maxResults?: number }
/** A folder a search starts in; `home`: the person's home folder (HOME_SKIP applies right below it). */
interface Root { dir: string; home: boolean }

/** A name test: `*` and `?` as wildcards when given, else a part of the name (both without case). */
export function nameMatcher(query: string): (name: string) => boolean {
  const q = query.trim().toLowerCase();
  if (!/[*?]/.test(q)) return (name) => name.toLowerCase().includes(q);
  const pattern = new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (name) => pattern.test(name);
}

/** Up to LINES_PER_FILE lines of a text file that contain `needle` (lower case) and how many more there are; undefined: not text or no hit. */
async function contentHits(file: string, needle: string, limit = LINES_PER_FILE): Promise<{ hits: Array<{ line: number; text: string }>; more: number } | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > CONTENT_BYTES) return undefined;
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  let body: Buffer;
  try {
    body = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(body, 0, body.length, 0);
    body = body.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (body.subarray(0, 8192).includes(0)) return undefined; // binary
  const hits: Array<{ line: number; text: string }> = [];
  let more = 0; // B-048: every hit is counted – a silent cap made an agent believe a log had 2 errors instead of 6
  const lines = body.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    if (hits.length < limit) hits.push({ line: i + 1, text: clip(lines[i].trim(), 200) });
    else more++;
  }
  return hits.length ? { hits, more } : undefined;
}

/**
 * files.search; `resolve` is files.ts readPath (the root's real path where this agent may read), `home` the person's
 * home folder (tests pass their own).
 */
export function searchTool(deps: { resolve: (ctx: ToolContext, given: string | undefined) => Promise<string>; home?: () => string }): ToolDef {
  const homeOf = deps.home ?? (() => os.homedir());
  return defineTool<SearchArgs>({
    name: 'files.search',
    description: 'Find files by name (part of it, or with * and ?) or, with content: true, by text inside them – below path, or in the one file path names. Without path: the workspace, then the person\'s home folder (its app data folders left out). Hidden and dependency folders and credential stores are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 }, path: { type: 'string', maxLength: 1024 },
        content: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      },
      required: ['query'], additionalProperties: false,
    },
    category: 'read',
    describe: (args) => ({ summary: `Search ${args.content ? 'file contents' : 'file names'} for "${clip(args.query, 80)}" in ${args.path ?? 'the workspace and the home folder'}`, resource: args.path ?? '.', reversible: true, external: false }),
    async run(args, ctx) {
      if (ctx.fromPc !== undefined) return failure('files.search runs only for agents of this PC.');
      const query = args.query.trim();
      if (!query) return failure('Name what to search for.');
      const max = Math.min(args.maxResults ?? DEFAULT_RESULTS, MAX_RESULTS);
      const home = homeOf();
      if (!args.path?.trim()) {
        const roots = await defaultRoots(ctx, deps.resolve, home);
        return text(render(ctx, roots, await walk(ctx, roots, query, args.content === true, max, roots.length > 1 ? HOME_ENTRIES : MAX_ENTRIES), args, home));
      }
      const root = await deps.resolve(ctx, args.path);
      const top = await stat(root).catch(() => undefined);
      if (top?.isFile()) return text(await oneFile(ctx, root, query, args)); // B-048: a single file is searched inside
      if (!top?.isDirectory()) return failure(`No folder at ${args.path}.`);
      const roots = [{ dir: root, home: Boolean(home) && path.relative(path.resolve(home), root) === '' }]; // the home named as path: HOME_SKIP too
      return text(render(ctx, roots, await walk(ctx, roots, query, args.content === true, max, MAX_ENTRIES), args, home));
    },
  });
}

/** The workspace, then the person's home folder when it is a folder and not the workspace or inside it. */
async function defaultRoots(ctx: ToolContext, resolve: (ctx: ToolContext, given: string | undefined) => Promise<string>, home: string): Promise<Root[]> {
  const roots: Root[] = [{ dir: await resolve(ctx, undefined), home: false }];
  const dir = home ? await resolve(ctx, home).catch(() => undefined) : undefined;
  if (dir && !inside(roots[0].dir, dir) && (await stat(dir).catch(() => undefined))?.isDirectory()) roots.push({ dir, home: true });
  return roots;
}

/** `target` is `root` or below it (path.relative folds case on Windows). */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

interface Found { hits: string[]; entries: number; stopped?: string }

/** files.search with `path` naming one file: its matching lines (content search), up to maxResults, with the count of the rest. */
async function oneFile(ctx: ToolContext, file: string, query: string, args: SearchArgs): Promise<string> {
  const workspace = path.resolve(ctx.services.paths.workspace);
  const name = shown(workspace, file);
  const max = Math.min(args.maxResults ?? DEFAULT_RESULTS, MAX_RESULTS);
  const result = await contentHits(file, query.toLowerCase(), max).catch(() => undefined);
  if (!result) return `No line of ${name} contains "${query}" (or it is not a text file up to 1 MB).`;
  const total = result.hits.length + result.more;
  const lines = result.hits.map((hit) => `${name}:${hit.line}: ${redact(ctx, hit.text)}`);
  return [`${total} line${total === 1 ? '' : 's'} of ${name} contain "${query}":`, ...lines, ...(result.more ? [`+${result.more} more – raise maxResults or read with files.read fromLine.`] : [])].join('\n');
}

/** The roots one after the other, each breadth-first, within one set of bounds; a root met again inside another is not walked twice. */
async function walk(ctx: ToolContext, roots: readonly Root[], query: string, content: boolean, max: number, limit: number): Promise<Found> {
  const started = Date.now();
  const matches = nameMatcher(query);
  const needle = query.toLowerCase();
  const workspace = path.resolve(ctx.services.paths.workspace);
  const found: Found = { hits: [], entries: 0 };
  const late = () => Date.now() - started > SEARCH_MS || ctx.signal.aborted;
  for (const root of roots) {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root.dir, depth: 0 }];
    for (let next = 0; next < queue.length; next++) {
      const { dir, depth } = queue[next];
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.hits.length >= max) { found.stopped = `the first ${max} hits`; return found; }
        if (++found.entries > limit) { found.stopped = `${limit.toLocaleString('en-US')} entries`; return found; }
        if (late()) { found.stopped = ctx.signal.aborted ? 'the run stopped' : `${SEARCH_MS / 1000} s`; return found; }
        if (entry.isSymbolicLink() || skipped(entry.name, entry.isDirectory())) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (root.home && depth === 0 && homeSkipped(entry.name, content)) continue;
          if (roots.some((other) => other !== root && path.relative(other.dir, full) === '')) continue; // searched as its own root
          if (depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
          if (!content && matches(entry.name)) found.hits.push(`${shown(workspace, full)}/`);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!content) { if (matches(entry.name)) found.hits.push(shown(workspace, full)); continue; }
        const result = await contentHits(full, needle).catch(() => undefined);
        if (!result) continue;
        const name = shown(workspace, full);
        for (const hit of result.hits) found.hits.push(`${name}:${hit.line}: ${redact(ctx, hit.text)}`);
        if (result.more) found.hits.push(`${name}: +${result.more} more matching line${result.more === 1 ? '' : 's'} in this file (search that file with path, or read it with files.read fromLine)`);
      }
    }
  }
  return found;
}

/** A workspace path '/'-separated and relative to it; any other one absolute. */
function shown(workspace: string, file: string): string {
  const relative = path.relative(workspace, file);
  if (relative === '') return '.';
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
}

function redact(ctx: ToolContext, value: string): string {
  try { return ctx.services.secrets.redact(value); } catch { return '[line hidden: secrets could not be checked]'; }
}

function render(ctx: ToolContext, roots: readonly Root[], found: Found, args: SearchArgs, home: string): string {
  const workspace = path.resolve(ctx.services.paths.workspace);
  const where = roots.map((root) => shown(workspace, root.dir)).map((name) => (name === '.' ? 'the workspace' : name)).join(' and ');
  const head = found.hits.length
    ? `${found.hits.length} hit${found.hits.length === 1 ? '' : 's'} for "${args.query}" ${args.content ? 'inside files' : 'in names'} below ${where}:`
    : `No ${args.content ? 'file contains' : 'name matches'} "${args.query}" below ${where}.`;
  const tail = (found.stopped ? `Stopped after ${found.stopped} – name a narrower path or query for more.` : `Looked at ${found.entries} entries.`)
    + (args.content ? ' Only text files up to 1 MB are searched inside.' : ''); // B-049 F8: the bound the description no longer names
  return [head, ...found.hits, tail, ...wider(ctx, roots, found, home)].join('\n');
}

/** Nothing in the workspace alone (B-047 D1): the person's own folders are the wider place, said as a fact. */
function wider(ctx: ToolContext, roots: readonly Root[], found: Found, home: string): string[] {
  if (!home || found.hits.length || roots.length !== 1 || path.resolve(roots[0].dir) !== path.resolve(ctx.services.paths.workspace)) return [];
  return [`That was only the workspace. This whole PC is mine to search – e.g. path "${home}".`];
}
