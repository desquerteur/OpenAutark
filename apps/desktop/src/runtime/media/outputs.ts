// Agent outputs into the blob store and the chat (P12/P23): local files named in the ```ui
// blocks of an agent message (media.src and media.items[].src, file.path, cards[].image) are
// stored and the block gets their fileId, so phones, the PWA and the media library can show
// them; chat.send `files` and engine files (Codex image generation) become attachments.
// Owns: the output confinement (inside the workspace after realpath, never an account home,
// ≤ 4 GiB), the fence rewrite (adds fileId, keeps the path – a relative file.path becomes
// absolute for desktop Open – and keeps every block index), notes for files that are missing
// or outside the workspace, and the check that a fileId an agent wrote is one it may see.
// Never: reads outside the workspace, follows a symlink out of it, throws for one bad file
// (it becomes a note), or touches blocks other than media, file, cards and tabs.

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, type UiBlock } from '../../shared/blocks/catalog.ts';
import { isObj, type Obj } from '../../shared/blocks/coerce.ts';
import { parseLenientJson } from '../../shared/blocks/lenient-json.ts';
import { parseUiFence, uiBlocksOf } from '../../shared/blocks/parse.ts';
import { validateBlock } from '../../shared/blocks/validate.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { FileStore, Paths } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { EngineFile } from '../engines/types.ts';
import { kindOf } from './probe.ts';
import { MediaRepo } from './repo.ts';

export const OUTPUT_LIMITS = { bytes: 4 * 1024 ** 3, files: 10, inlineBytes: 50 * 1024 * 1024, notes: 8 } as const;

export interface OutputServices {
  db: Db;
  files: FileStore;
  paths: Pick<Paths, 'workspace' | 'accounts'>;
}

type Refusal = 'missing' | 'outside' | 'large' | 'not_file';
const REFUSED: Record<Refusal, { text: string; hint: string }> = {
  missing: { text: 'was not found', hint: 'I check the path and send the block again.' },
  outside: { text: 'is outside the workspace', hint: 'I save deliverables inside the workspace folder, then send the block again.' },
  large: { text: 'is larger than 4 GB', hint: 'I share a smaller file instead.' },
  not_file: { text: 'is a folder, not a file', hint: 'I name a file, not a folder.' },
};

const FILE_ID = /^[a-f0-9]{64}$/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n`]*)$/; // the same fence rule as shared/blocks/parse.ts
const UI_LANGS = new Set(['ui', 'wf-ui', 'ui-json', 'a2ui']);
const APP_LANGS = new Set(['app', 'wf-app']);
const REPAIR_NS = 'repair_notes'; // the kv row agents/turn-finish.ts hands to the agent's next turn

// ---------------------------------------------------------------- confinement

/** The local path a block value names; undefined for URLs, data: sources and file ids. */
export function localPathOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 4096 || FILE_ID.test(text)) return undefined;
  if (/^file:\/\//i.test(text)) { try { return fileURLToPath(text); } catch { return undefined; } }
  if (/^[a-z][a-z0-9+.-]+:/i.test(text)) return undefined; // a URL (a one-letter "scheme" is a drive)
  return text;
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function real(value: string): Promise<string> {
  try { return await realpath(value); } catch { return path.resolve(value); }
}

/** Confines a named output to the workspace: lexically first, then again after resolving symlinks. */
export async function resolveOutput(paths: OutputServices['paths'], value: string): Promise<{ path: string; absolute: string } | { refused: Refusal }> {
  const root = path.resolve(paths.workspace);
  const absolute = path.resolve(root, value);
  const realRoot = await real(root);
  if (!inside(root, absolute) && !inside(realRoot, absolute)) return { refused: 'outside' };
  let target: string;
  try { target = await realpath(absolute); } catch { return { refused: 'missing' }; }
  if (!inside(realRoot, target) || inside(await real(paths.accounts), target)) return { refused: 'outside' };
  const info = await stat(target).catch(() => undefined);
  if (!info) return { refused: 'missing' };
  if (!info.isFile()) return { refused: 'not_file' };
  if (info.size > OUTPUT_LIMITS.bytes) return { refused: 'large' };
  return { path: target, absolute };
}

// ---------------------------------------------------------------- block references

/** A spot in a raw block that names a file: `holder[key]` is the source, `holder[idKey]` its fileId. */
interface Ref { holder: Obj; key?: string; idKey?: 'fileId'; kind?: boolean; absolute?: boolean }

const objects = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);
const firstKey = (obj: Obj, keys: string[]) => keys.find((key) => typeof obj[key] === 'string' && (obj[key] as string).trim() !== '');

function tabBlocks(tab: Obj): Obj[] {
  if (Array.isArray(tab.blocks)) return objects(tab.blocks);
  if (isObj(tab.block)) return [tab.block];
  return isObj(tab.content) ? [tab.content] : [];
}

/** File references of one raw block, found with the same key preferences as shared/blocks/shape.ts. */
function refsOf(raw: Obj, depth = 0): Ref[] {
  const checked = validateBlock(raw, { nested: depth > 0 });
  if (!checked.ok) return [];
  switch (checked.block.type) {
    case 'media':
      return [
        { holder: raw, key: firstKey(raw, ['src', 'url', 'path', 'file']), idKey: 'fileId', kind: true },
        ...objects(raw.items).map((item): Ref => ({ holder: item, key: firstKey(item, ['src', 'url']), idKey: 'fileId', kind: true })),
      ];
    case 'file':
      return [{ holder: raw, key: firstKey(raw, ['path', 'file', 'src', 'url']), idKey: 'fileId', absolute: true }];
    case 'cards':
      return objects(raw.items ?? raw.cards ?? raw.links).map((item): Ref => ({ holder: item, key: firstKey(item, ['image']) }));
    case 'tabs':
      return depth < 3 ? objects(raw.tabs ?? raw.items).flatMap(tabBlocks).flatMap((inner) => refsOf(inner, depth + 1)) : [];
    default:
      return [];
  }
}

/** (source, file id) pairs of a validated block: media src/items, file path, cards images, tabs. */
function sourcesOf(block: UiBlock, depth = 0): Array<{ source?: unknown; id?: unknown }> {
  switch (block.type) {
    case 'media': return [{ source: block.src, id: block.fileId }, ...objects(block.items).map((item) => ({ source: item.src ?? item.url, id: item.fileId }))];
    case 'file': return [{ source: block.path, id: block.fileId }];
    case 'cards': return objects(block.items).map((item) => (FILE_ID.test(String(item.image ?? '')) ? { id: item.image } : { source: item.image }));
    case 'tabs': return depth < 3 ? objects(block.tabs).flatMap((tab) => objects(tab.blocks)).flatMap((inner) => sourcesOf(inner as UiBlock, depth + 1)) : [];
    default: return [];
  }
}

/** True when an agent message has ```ui blocks that name local files or file ids (cheap pre-check). */
export function hasOutputRefs(body: string): boolean {
  if (!body.includes('```') && !body.includes('~~~')) return false;
  return uiBlocksOf(body).some(({ block }) => sourcesOf(block).some(({ source, id }) => id !== undefined || localPathOf(source) !== undefined));
}

/** File ids that the ```ui blocks of a message show (media/file fileId, cards image ids). */
export function blockFileIds(body: string): string[] {
  if (!/[a-f0-9]{64}/.test(body)) return [];
  const ids = uiBlocksOf(body).flatMap(({ block }) => sourcesOf(block)).map(({ id }) => id);
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && FILE_ID.test(id)))];
}

// ---------------------------------------------------------------- the import

interface Fence { from: number; to: number; inner: string; index: number } // inner = lines [from, to)

/** Closed ```ui fences with the index of their first block (numbered exactly like parse.ts). */
function uiFences(lines: string[]): Fence[] {
  const fences: Fence[] = [];
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const lang = (open[2].trim().split(/\s+/)[0] ?? '').toLowerCase();
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (candidate.length >= marker.length && candidate[0] === marker[0] && /^(`+|~+)$/.test(candidate)) { close = j; break; }
    }
    const end = close >= 0 ? close : lines.length;
    if (UI_LANGS.has(lang)) {
      const inner = lines.slice(i + 1, end).join('\n');
      if (close >= 0) fences.push({ from: i + 1, to: end, inner, index: next });
      next += parseUiFence(inner, close >= 0).length;
    } else if (APP_LANGS.has(lang)) next += 1;
    i = end;
  }
  return fences;
}

interface ImportState {
  s: OutputServices;
  canSee: (fileId: string) => boolean;
  stored: Map<string, FileRef>; // real path → stored file (one putPath per path)
  own: Set<string>; // ids stored by this import (not yet linked to any chat)
  notes: string[];
  changes: number;
}

const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// B-076: blocks are counted from 1 in what the agent reads (the parser numbers them from 0).
const note = (index: number, problem: string, hint: string) => `[file-error block ${index + 1}: ${problem}] ${hint}`;

async function settle(state: ImportState, ref: Ref, index: number): Promise<void> {
  const { holder, key, idKey } = ref;
  if (idKey && holder[idKey] !== undefined) {
    const id = typeof holder[idKey] === 'string' ? (holder[idKey] as string).trim().toLowerCase() : '';
    if (FILE_ID.test(id) && (state.own.has(id) || state.canSee(id))) return; // already stored and visible
    delete holder[idKey];
    state.changes++;
    if (FILE_ID.test(id)) state.notes.push(note(index, `file ${id.slice(0, 12)}… is not available to me`, 'I use a file from this chat or a workspace path.'));
  }
  const source = key ? holder[key] : undefined;
  if (!idKey && key && typeof source === 'string' && FILE_ID.test(source.trim())) {
    // A card image given as a file id: kept only when the agent may see that file.
    if (state.own.has(source.trim()) || state.canSee(source.trim())) return;
    delete holder[key];
    state.changes++;
    state.notes.push(note(index, `file ${source.trim().slice(0, 12)}… is not available to me`, 'I use a file from this chat or a workspace path.'));
    return;
  }
  const local = localPathOf(source);
  if (!key || !local) return;
  const resolved = await resolveOutput(state.s.paths, local);
  if ('refused' in resolved) {
    state.notes.push(note(index, `"${clip(local)}" ${REFUSED[resolved.refused].text}`, REFUSED[resolved.refused].hint));
    return;
  }
  let file = state.stored.get(resolved.path);
  if (!file) {
    try { file = await state.s.files.putPath(resolved.path); } catch (error) {
      state.notes.push(note(index, `"${clip(local)}" could not be stored (${clip(messageOf(error))})`, 'I check the file and send the block again.'));
      return;
    }
    state.stored.set(resolved.path, file);
    state.own.add(file.id);
  }
  if (idKey) holder[idKey] = file.id;
  else holder[key] = file.id; // cards: the image becomes the stored file
  if (ref.absolute && !path.isAbsolute(local)) holder[key] = resolved.absolute;
  const kind = kindOf(file.mime);
  if (ref.kind && holder.kind === undefined && (kind === 'image' || kind === 'audio' || kind === 'video')) holder.kind = kind;
  state.changes++;
}

/**
 * Stores the local files the ```ui blocks of an agent message name and returns the body with
 * their fileIds (unchanged text when nothing was stored), plus notes for the agent's next turn.
 */
export async function importOutputs(s: OutputServices, input: { body: string; agentId: string; conversationId?: string }): Promise<{ body: string; notes: string[]; files: FileRef[] }> {
  const repo = new MediaRepo(s.db);
  const state: ImportState = { s, canSee: (id) => repo.visibleTo(id, input.agentId), stored: new Map(), own: new Set(), notes: [], changes: 0 };
  const lines = input.body.replace(/\r\n?/g, '\n').split('\n');
  const rewrites: Array<{ fence: Fence; text: string }> = [];
  for (const fence of uiFences(lines)) {
    if (Buffer.byteLength(fence.inner) > LIMITS.uiJsonBytes) continue;
    let values: unknown[];
    try { values = parseLenientJson(fence.inner.replace(/^\s*(json5?|jsonc|ui)\s*\n/i, '')); } catch { continue; }
    const blocks = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
    const before = state.changes;
    for (const [offset, block] of blocks.entries()) {
      if (!isObj(block)) continue;
      for (const ref of refsOf(block)) await settle(state, ref, fence.index + offset);
    }
    if (state.changes === before) continue;
    const text = values.map((value) => JSON.stringify(value)).join('\n');
    if (Buffer.byteLength(text) <= LIMITS.uiJsonBytes) rewrites.push({ fence, text });
  }
  if (!rewrites.length) return { body: input.body, notes: state.notes, files: [...state.stored.values()] };
  for (const { fence, text } of rewrites.reverse()) lines.splice(fence.from, fence.to - fence.from, text);
  return { body: lines.join('\n'), notes: state.notes, files: [...state.stored.values()] };
}

// ---------------------------------------------------------------- attachments

export function toAttachment(file: FileRef): Attachment {
  const out: Attachment = { fileId: file.id, name: file.name, mime: file.mime, size: file.size };
  if (file.width !== undefined) out.width = file.width;
  if (file.height !== undefined) out.height = file.height;
  if (file.durationMs !== undefined) out.durationMs = file.durationMs;
  return out;
}

/** chat.send `files`: workspace paths are stored, 64-hex ids must be files the agent may see – and, with `toChat`,
 *  files the agent may see. */
export async function importFiles(s: OutputServices, agentId: string, entries: readonly string[], toChat?: string): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const repo = new MediaRepo(s.db);
  const attachments = new Map<string, Attachment>();
  const errors: string[] = [];
  for (const raw of entries.slice(0, OUTPUT_LIMITS.files)) {
    const entry = String(raw).trim();
    const id = entry.toLowerCase();
    if (FILE_ID.test(id)) {
      const file = s.files.get(id);
      if (file && repo.visibleTo(id, agentId)) attachments.set(id, toAttachment(file));
      else errors.push(`File ${id.slice(0, 12)}… is not available to me.`);
      continue;
    }
    const local = localPathOf(entry);
    if (!local) { errors.push(`"${clip(entry)}" is neither a workspace path nor a file id.`); continue; }
    const resolved = await resolveOutput(s.paths, local);
    if ('refused' in resolved) { errors.push(`"${clip(local)}" ${REFUSED[resolved.refused].text}.`); continue; }
    try {
      const file = await s.files.putPath(resolved.path);
      attachments.set(file.id, toAttachment(file));
    } catch (error) { errors.push(`"${clip(local)}" could not be stored: ${clip(messageOf(error))}`); }
  }
  return { attachments: [...attachments.values()], errors };
}

function decodeInline(value: string): { data: Uint8Array; mime?: string } {
  const match = /^data:([^;,]*)(;base64)?,/i.exec(value);
  const body = match ? value.slice(match[0].length) : value;
  if (body.length > Math.ceil(OUTPUT_LIMITS.inlineBytes / 3) * 4 + 4) throw new Error('The file is larger than 50 MB.');
  const buffer = Buffer.from(body, 'base64');
  return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), mime: match?.[1] || undefined };
}

/** Engine files (EngineTurnResult.files): inline bytes or a saved file inside the workspace. */
export async function storeEngineFiles(s: OutputServices, files: readonly EngineFile[]): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const attachments = new Map<string, Attachment>();
  const errors: string[] = [];
  for (const file of files.slice(0, OUTPUT_LIMITS.files)) {
    try {
      let ref: FileRef | undefined;
      if (file.dataBase64) {
        const inline = decodeInline(file.dataBase64);
        ref = await s.files.put(inline.data, file.name, file.mime ?? inline.mime);
      } else if (file.path) {
        const resolved = await resolveOutput(s.paths, file.path);
        if ('refused' in resolved) { errors.push(`${file.name} ${REFUSED[resolved.refused].text}`); continue; }
        ref = await s.files.putPath(resolved.path, file.mime);
      }
      if (ref) attachments.set(ref.id, toAttachment(ref));
    } catch (error) { errors.push(`${file.name}: ${messageOf(error)}`); }
  }
  return { attachments: [...attachments.values()], errors };
}

/** Adds notes to the repair notes the agent's next turn in this chat receives (agents/turn-finish.ts). */
export function saveOutputNotes(db: Db, now: number, agentId: string, conversationId: string, notes: readonly string[]): void {
  if (!notes.length) return;
  const key = `${agentId}:${conversationId}`;
  const row = db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [REPAIR_NS, key]);
  let current: string[] = [];
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : [];
    if (Array.isArray(parsed)) current = parsed.filter((item): item is string => typeof item === 'string');
  } catch { /* an unreadable row is replaced */ }
  const merged = [...new Set([...current, ...notes])].slice(0, OUTPUT_LIMITS.notes);
  db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [REPAIR_NS, key, JSON.stringify(merged), now]);
}
