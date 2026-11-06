// The memory tree: <data>/memory, one Markdown file per entry (frontmatter + text), folders by who it is for – company/
// (with websites/<host>/, apps/<name>/, modes/<key>/), branches/<space>/, agents/<agent>/, references/<person>/,
// chats/<chat>/ and any free topic subfolder. A file in a pinned/ subfolder is always in its readers' prompt; _folder.md
// describes a folder; an optional `description:` line describes a file. Names starting with "_" or "." are no entries. A file without frontmatter is a valid entry too
// (title = its first heading or its name): the files are the truth and anything may edit them.
// Owns: paths, the file format, reading, writing, listing and folder descriptions. Never: decides who reads what
// (acl.ts), talks to vectors or the database (service.ts).

import { mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { DESCRIPTION_SHOWN, type MemoryFile, type MemoryFolder, type MemoryKind } from '../../shared/model/memory.ts';
import type { KnowledgeItem, KnowledgeScope, KnowledgeSource } from '../../shared/model/knowledge.ts';
import { readText, readTextAsync, writeAtomic, type OwnWrites } from '../root/text-doc.ts';
import { parseFrontMatter, stringList } from '../skills/frontmatter.ts';
import { treeFiles } from './memory-blobs.ts';
import { foldText } from './normalize.ts';

export const MEMORY_ENTRY = 'memory';
export const FOLDER_FILE = '_folder.md';
export const PINNED_DIR = 'pinned';
/** Files listed or searched without a model at most (the newest ones). */
const WALK_MAX = 20_000;
const STATS_AT_ONCE = 64;
const BROWSE_MAX = 100;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const SLUG_MAX = 60;
/** A file changed this much later than its `updated` line was edited directly: the file's time counts. */
const EDIT_SLACK_MS = 2000;
const DEFAULT_CONFIDENCE = 0.7;

const KINDS: ReadonlySet<string> = new Set(['fact', 'preference', 'experience', 'procedure', 'plan', 'observation', 'note', 'reference']);
const SOURCE = /^(user|message|run|web|file|agent|import)(?::(.*))?$/s;
const KNOWN_KEYS: ReadonlySet<string> = new Set(['title', 'kind', 'tags', 'updated', 'source', 'valid-from', 'valid-to', 'by', 'confidence', 'untrusted']);

/** What a memory file holds beyond the shared shape (written by the app, all optional). */
export interface MemoryEntry extends MemoryFile {
  by?: string;
  confidence?: number;
  untrusted?: boolean;
  /** Other frontmatter keys somebody added – kept as they are. */
  extra?: Record<string, unknown>;
}

/** A file's id as an item id: '/' becomes ':' (RPC ids hold no '/'); both forms are accepted everywhere. */
export const memoryId = (rel: string): string => rel.replace(/\//g, ':');
/** True for the id of a memory file (a database row's id is `kn_…`). */
export const isFileId = (id: string): boolean => /\.md$/i.test(id);
/** A file's name makes it an entry (no _folder.md, nothing hidden). */
export const isEntryName = (rel: string): boolean => !/^[._]/.test(path.posix.basename(rel));

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() || undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined);

function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const PLAIN = /^[\p{L}\p{N}][\p{L}\p{N} _.,()/@+-]*$/u;
const RESERVED = /^(?:true|false|null|-?\d+(?:\.\d+)?)$/;
const scalar = (value: string): string => (PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value));

/** A folder name from an id (website host, process name, person …): one path segment, never '..'. */
const segment = (id: string): string => id.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_') || '_';

/** 'Größe & Preis!' → 'groesse-preis'; a name Windows reserves for a device gets a word behind it. */
export function slugOf(title: string): string {
  const slug = foldText(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX).replace(/-+$/, '') || 'note';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-note` : slug;
}

/** The folder of a knowledge scope (website, app and mode areas are shared, so they live below company/). */
export function folderOfScope(scope: KnowledgeScope, scopeId: string | undefined): string {
  const id = segment(scopeId ?? '_');
  switch (scope) {
    case 'global': return 'company';
    case 'space': return `branches/${id}`;
    case 'agent': return `agents/${id}`;
    case 'reference': return `references/${id}`;
    case 'conversation': return `chats/${id}`;
    case 'website': return `company/websites/${id}`;
    case 'app': return `company/apps/${id}`;
    case 'mode': return `company/modes/${id}`;
  }
}

/** The folder holding every file of a scope, whatever its id. */
export function folderOfWholeScope(scope: KnowledgeScope): string {
  return { global: 'company', space: 'branches', agent: 'agents', reference: 'references', conversation: 'chats', website: 'company/websites', app: 'company/apps', mode: 'company/modes' }[scope];
}

/** The scope a file's place stands for (a free top-level folder counts as company-wide). */
export function scopeOfPath(rel: string): { scope: KnowledgeScope; scopeId?: string } {
  const parts = rel.split('/');
  const owned = parts.length > 2 ? parts[1] : undefined;
  if (parts[0] === 'branches' && owned) return { scope: 'space', scopeId: owned };
  if (parts[0] === 'agents' && owned) return { scope: 'agent', scopeId: owned };
  if (parts[0] === 'references' && owned) return { scope: 'reference', scopeId: owned };
  if (parts[0] === 'chats' && owned) return { scope: 'conversation', scopeId: owned };
  if (parts[0] === 'company' && parts.length > 3) {
    const area = ({ websites: 'website', apps: 'app', modes: 'mode' } as const)[parts[1] as 'websites' | 'apps' | 'modes'];
    if (area) return { scope: area, scopeId: parts[2] };
  }
  return { scope: 'global' };
}

const isPinned = (rel: string): boolean => rel.split('/').slice(0, -1).includes(PINNED_DIR);

/** Moves a path into or out of its place's pinned/ folder (the one a prompt reads; a topic folder below it has none). */
export function withPinned(rel: string, pinned: boolean): string {
  const parts = rel.split('/');
  const name = parts.pop()!;
  const folder = parts.filter((part) => part !== PINNED_DIR);
  if (!pinned) return [...folder, name].join('/');
  const { scope, scopeId } = scopeOfPath(rel);
  return [folderOfScope(scope, scopeId), PINNED_DIR, name].join('/');
}

/** The entry as a knowledge item (the old API's shape). */
export function itemOfEntry(entry: MemoryEntry): KnowledgeItem {
  const match = entry.source ? SOURCE.exec(entry.source) : undefined;
  const source: KnowledgeSource = {
    kind: match ? match[1] as KnowledgeSource['kind'] : entry.source === 'human' ? 'user' : 'agent',
    ...(match?.[2] ? { ref: match[2] } : entry.source && !match && entry.source !== 'human' ? { ref: entry.source } : {}),
    trusted: entry.untrusted !== true,
  };
  return {
    id: memoryId(entry.path), ...scopeOfPath(entry.path), kind: entry.kind ?? 'note', title: entry.title,
    ...(entry.description ? { description: entry.description } : {}), body: entry.text, tags: entry.tags ?? [], source,
    confidence: entry.confidence ?? DEFAULT_CONFIDENCE, pinned: isPinned(entry.path),
    ...(entry.validFrom !== undefined ? { validFrom: entry.validFrom } : {}), ...(entry.validTo !== undefined ? { validTo: entry.validTo } : {}),
    recordedAt: entry.updated, createdBy: entry.by ?? 'human', uses: 0,
  };
}

/** The `source` line of a knowledge source. */
export const sourceLine = (source: KnowledgeSource): string => `${source.kind}${source.ref ? `:${source.ref}` : ''}`;

/** The entry a knowledge item is written as. */
export function entryOfItem(item: Pick<KnowledgeItem, 'kind' | 'title' | 'body' | 'tags' | 'source' | 'confidence' | 'validFrom' | 'validTo' | 'createdBy'>, updated: number): Omit<MemoryEntry, 'path'> {
  return {
    title: item.title, kind: item.kind, ...(item.tags.length ? { tags: item.tags } : {}), updated, source: sourceLine(item.source), text: item.body,
    ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}), ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
    by: item.createdBy, confidence: item.confidence, ...(item.source.trusted ? {} : { untrusted: true }),
  };
}

/** Would writing `next` change nothing an entry says? */
export function sameEntry(old: MemoryEntry, next: Omit<MemoryEntry, 'path'>): boolean {
  return old.title === next.title && old.text === next.text.trim() && old.kind === next.kind && JSON.stringify(old.tags ?? []) === JSON.stringify(next.tags ?? [])
    && old.source === next.source && old.validFrom === next.validFrom && old.validTo === next.validTo && (old.description ?? '') === (next.description ?? '');
}

/** The file's text: frontmatter + body. */
export function formatEntry(entry: Omit<MemoryEntry, 'path'>): string {
  const lines = [`title: ${scalar(entry.title)}`];
  if (entry.description) lines.push(`description: ${scalar(entry.description)}`);
  if (entry.kind) lines.push(`kind: ${entry.kind}`);
  if (entry.tags?.length) lines.push(`tags: [${entry.tags.map(scalar).join(', ')}]`);
  lines.push(`updated: ${new Date(entry.updated).toISOString()}`);
  if (entry.source) lines.push(`source: ${scalar(entry.source)}`);
  if (entry.validFrom !== undefined) lines.push(`valid-from: ${new Date(entry.validFrom).toISOString()}`);
  if (entry.validTo !== undefined) lines.push(`valid-to: ${new Date(entry.validTo).toISOString()}`);
  if (entry.by) lines.push(`by: ${scalar(entry.by)}`);
  if (entry.confidence !== undefined && entry.confidence !== DEFAULT_CONFIDENCE) lines.push(`confidence: ${entry.confidence}`);
  if (entry.untrusted) lines.push('untrusted: true');
  for (const [key, value] of Object.entries(entry.extra ?? {})) if (key !== 'description' || !entry.description) lines.push(`${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n${entry.text.trim()}\n`;
}

/** A file's entry; `mtime` = the file's own time (a direct edit counts as a change). */
export function parseEntry(rel: string, raw: string, mtime: number): MemoryEntry {
  const { data, body } = parseFrontMatter(raw);
  const updated = time(data.updated);
  const kind = text(data.kind);
  const tags = stringList(data.tags);
  const confidence = typeof data.confidence === 'number' ? data.confidence : undefined;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const description = (typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : '') || undefined; // a string only; anything else stays in extra
  const extra = Object.fromEntries(Object.entries(data).filter(([key]) => !KNOWN_KEYS.has(key) && !(key === 'description' && typeof data.description === 'string')));
  const validFrom = time(data['valid-from']);
  const validTo = time(data['valid-to']);
  return {
    path: rel,
    title: text(data.title) ?? heading ?? path.posix.basename(rel, '.md'),
    ...(description ? { description } : {}),
    ...(kind && KINDS.has(kind) ? { kind: kind as MemoryKind } : {}),
    ...(tags.length ? { tags } : {}),
    updated: updated === undefined || mtime - updated > EDIT_SLACK_MS ? Math.floor(mtime) : updated,
    ...(text(data.source) ? { source: text(data.source) } : {}),
    text: body,
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validTo !== undefined ? { validTo } : {}),
    ...(text(data.by) ? { by: text(data.by) } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(data.untrusted === true ? { untrusted: true } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

const newestFirst = (files: ReadonlyMap<string, number>, max: number): Array<{ rel: string; mtime: number }> =>
  [...files].map(([rel, mtime]) => ({ rel, mtime })).sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? 1 : -1)).slice(0, max);

export class MemoryTree {
  private readonly rootOf: () => string;
  private readonly writes?: OwnWrites;

  constructor(rootOf: () => string, writes?: OwnWrites) {
    this.rootOf = rootOf;
    this.writes = writes;
  }

  get root(): string {
    return this.rootOf();
  }

  /** A path as anybody names it – relative, "memory/…", an item id or absolute inside the tree – in its normal form ('' = the root). */
  rel(input: string): string {
    let value = input.trim().replace(/\\/g, '/');
    if (path.isAbsolute(value) || /^[a-z]:\//i.test(value)) {
      const inside = path.relative(this.root, value).replace(/\\/g, '/');
      if (inside === '..' || inside.startsWith('../') || path.isAbsolute(inside)) throw new WorkforceError('bad_request', `Not a place in the memory folder: ${input}`);
      value = inside;
    }
    const parts = value.replace(/:/g, '/').split('/').filter((part) => part && part !== '.');
    if (parts[0]?.toLowerCase() === MEMORY_ENTRY) parts.shift();
    if (parts.some((part) => part === '..' || /[<>"|?*\x00-\x1f]/.test(part))) throw new WorkforceError('bad_request', `Not a place in the memory folder: ${input}`);
    return parts.join('/');
  }

  /** The normal path of a file (".md" added when missing). */
  fileRel(input: string): string {
    const rel = this.rel(input);
    if (!rel) throw new WorkforceError('bad_request', 'Name a file in the memory folder.');
    return /\.md$/i.test(rel) ? rel : `${rel}.md`;
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  read(rel: string): MemoryEntry | undefined {
    const file = this.abs(rel);
    const read = readText(file, { maxBytes: FILE_MAX_BYTES });
    if (read.kind !== 'ok') return undefined;
    return parseEntry(rel, read.text, statSync(file).mtimeMs);
  }

  /** read() with the event loop free. */
  async readAsync(rel: string): Promise<MemoryEntry | undefined> {
    const file = this.abs(rel);
    const read = await readTextAsync(file, { maxBytes: FILE_MAX_BYTES });
    if (read.kind !== 'ok') return undefined;
    const info = await stat(file).catch(() => undefined);
    return info ? parseEntry(rel, read.text, info.mtimeMs) : undefined;
  }

  /** The file's text as it is on disk, undefined when it cannot be read. */
  raw(rel: string): string | undefined {
    const read = readText(this.abs(rel), { maxBytes: FILE_MAX_BYTES });
    return read.kind === 'ok' ? read.text : undefined;
  }

  /** Writes the entry; the file's time is `entry.updated`, so its time and its `updated` line tell one story. */
  write(rel: string, entry: Omit<MemoryEntry, 'path'>): void {
    const file = this.abs(rel);
    writeAtomic(file, formatEntry(entry), this.writes);
    try { utimesSync(file, new Date(entry.updated), new Date(entry.updated)); } catch { /* the time stays the write's */ }
  }

  remove(rel: string): void {
    const file = this.abs(rel);
    rmSync(file, { force: true });
    this.writes?.wrote(file, null);
  }

  /** Moves a file (pin / unpin); the time stays. */
  move(from: string, to: string): void {
    const source = this.abs(from);
    const target = this.abs(to);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(source, target);
    const moved = readText(target, { maxBytes: FILE_MAX_BYTES });
    this.writes?.wrote(source, null);
    if (moved.kind === 'ok') this.writes?.wrote(target, moved.text);
  }

  /**
   * The file `title` belongs to in `folder`: the file holding this title. `fresh` (a new item that is no update): another
   * title or other text on that name takes the next free name, the same title and text is that file again.
   */
  slot(folder: string, title: string, fresh?: { text: string }): string {
    const key = foldText(title);
    const base = slugOf(title);
    for (let index = 1; index < 1000; index++) {
      const rel = [folder, `${base}${index === 1 ? '' : `-${index}`}.md`].filter(Boolean).join('/');
      const entry = this.read(rel);
      if (!entry) { if (!this.exists(rel)) return rel; continue; }
      if (foldText(entry.title) === key && (!fresh || entry.text.trim() === fresh.text.trim())) return rel;
    }
    throw new WorkforceError('conflict', 'Too many memory files with this title in this folder.');
  }

  /** The entry files below `folders` (relative; '' = everything), newest first; subfolders included, capped at `max`. */
  files(folders: readonly string[], max = WALK_MAX): Array<{ rel: string; mtime: number }> {
    const out = new Map<string, number>();
    const walk = (rel: string) => {
      for (const entry of this.entries(rel)) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          try { out.set(child, statSync(this.abs(child)).mtimeMs); } catch { /* gone meanwhile */ }
        }
      }
    };
    for (const folder of folders) walk(folder);
    return newestFirst(out, max);
  }

  /** files() with the event loop free: a scope may hold 100,000 files. */
  async filesAsync(folders: readonly string[], max = WALK_MAX): Promise<Array<{ rel: string; mtime: number }>> {
    const out = new Map<string, number>();
    const statAll = async (rels: string[]) => {
      await Promise.all(rels.map(async (rel) => {
        const info = await stat(this.abs(rel)).catch(() => undefined); // gone meanwhile
        if (info) out.set(rel, info.mtimeMs);
      }));
    };
    for (const folder of folders) {
      let batch: string[] = [];
      for await (const rel of treeFiles(this.root, folder)) {
        if (!/\.md$/i.test(rel) || rel.split('/').some((part) => part.startsWith('_'))) continue;
        batch.push(rel);
        if (batch.length >= STATS_AT_ONCE) { await statAll(batch); batch = []; }
      }
      await statAll(batch);
    }
    return newestFirst(out, max);
  }

  /** One folder: its description, subfolders and the newest files (titles, with a file's description when it has one). */
  browse(folder: string): MemoryFolder {
    const entries = this.entries(folder);
    const join = (name: string) => (folder ? `${folder}/${name}` : name);
    const isEntry = (entry: { name: string; isFile(): boolean }) => entry.isFile() && /^[^._].*\.md$/i.test(entry.name);
    const folders = entries.filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name)).map((entry) => {
      const rel = join(entry.name);
      const description = this.description(rel);
      return { path: rel, ...(description ? { description } : {}) };
    }).sort((a, b) => (a.path < b.path ? -1 : 1));
    const files = entries.filter(isEntry).flatMap((entry) => {
      try { return [{ rel: join(entry.name), mtime: statSync(this.abs(join(entry.name))).mtimeMs }]; } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime);
    const description = this.description(folder);
    return {
      path: folder,
      ...(description ? { description } : {}),
      folders,
      files: files.slice(0, BROWSE_MAX).flatMap(({ rel }) => {
        const entry = this.read(rel);
        return entry ? [{
          path: rel, title: entry.title, ...(entry.description ? { description: entry.description.slice(0, DESCRIPTION_SHOWN) } : {}),
          ...(entry.kind ? { kind: entry.kind } : {}), updated: entry.updated,
        }] : [];
      }),
      ...(files.length > BROWSE_MAX ? { more: true } : {}),
    };
  }

  /** Writes a folder's description unless it has one. */
  describe(folder: string, description: string): void {
    const rel = folder ? `${folder}/${FOLDER_FILE}` : FOLDER_FILE;
    if (this.exists(rel)) return;
    const file = this.abs(rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${description.trim()}\n`, { encoding: 'utf8', flag: 'wx' });
    this.writes?.wrote(file, `${description.trim()}\n`);
  }

  exists(rel: string): boolean {
    return statSync(this.abs(rel), { throwIfNoEntry: false }) !== undefined;
  }

  private description(folder: string): string | undefined {
    const read = readText(this.abs(folder ? `${folder}/${FOLDER_FILE}` : FOLDER_FILE), { maxBytes: 64 * 1024 });
    if (read.kind !== 'ok') return undefined;
    const { data, body } = parseFrontMatter(read.text);
    return (text(data.description) ?? (body || undefined))?.slice(0, 400);
  }

  private entries(rel: string) {
    try { return readdirSync(this.abs(rel), { withFileTypes: true }); } catch { return []; }
  }
}
