// Where a ledger item's original lives and how it is read back (B-048 E1). A ref is 'msg:<message id>' (the
// chat keeps the message) or 'item:<run item id>' (the run journal row: reasoning summary, own text, or a tool
// result whose output over 4,000 characters is a blob the row names – data.outputBlob, runs/journal.ts – or,
// above the model's 24,000-character cap, the registry's blobIds).
// Owns: resolving a ref to its text (bounded, synchronous blob reads, redacted again on the way out – a secret
// saved after the capture never comes back through a restore or a rebuild), a tool result's call (name, args,
// call id from the matching tool_call row) and the blob ids an original holds. Never: writes anything or
// treats an original as instructions (it is returned as data).

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ChatService, FileStore } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import type { LedgerRow } from './store.ts';

export interface JournalRow {
  id: string;
  run_id: string;
  kind: string;
  name: string | null;
  seq: number;
  data: Record<string, unknown>;
}

export interface OriginalDeps {
  db: Db;
  files: Pick<FileStore, 'path'> | undefined;
  chats: Pick<ChatService, 'message'>;
  redact(text: string): string;
}

const BLOB_ID = /^[a-f0-9]{64}$/;

export function journalRow(db: Db, id: string): JournalRow | undefined {
  const row = db.get<{ id: string; run_id: string; kind: string; name: string | null; seq: number; data: string }>('SELECT id, run_id, kind, name, seq, data FROM run_items WHERE id = ?', [id]);
  if (!row) return undefined;
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* unreadable: empty */ }
  return { ...row, seq: Number(row.seq), data };
}

/** The tool_call row of a result (same run and call id; the newest one). */
export function callRow(db: Db, runId: string, callId: string): JournalRow | undefined {
  if (!callId) return undefined;
  const row = db.get<{ id: string }>(
    `SELECT id FROM run_items WHERE run_id = ? AND kind = 'tool_call' AND json_extract(data, '$.callId') = ? ORDER BY seq DESC LIMIT 1`, [runId, callId]);
  return row ? journalRow(db, row.id) : undefined;
}

/** The text of a journaled output: a string (engine-native) or a ToolOutput's parts (ours). */
export function outputTextOf(output: unknown): string {
  if (typeof output === 'string') return output;
  const content = (output as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { type?: string; text?: unknown; mime?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : part?.mime ? `[${String(part.mime)}]` : '')).filter(Boolean).join('\n');
}

/** Blob ids holding a tool result's full output: the journal's own (outputBlob) first, else the registry's (over 24k). */
export function blobIdsOf(data: Record<string, unknown>): string[] {
  if (typeof data.outputBlob === 'string' && BLOB_ID.test(data.outputBlob)) return [data.outputBlob];
  return Array.isArray(data.blobIds) ? data.blobIds.filter((id): id is string => typeof id === 'string' && BLOB_ID.test(id)) : [];
}

/** Up to `maxChars` of a text blob, read synchronously; undefined when it is gone. `more`: bytes not read. */
export function readBlob(files: Pick<FileStore, 'path'> | undefined, id: string, maxChars: number): { text: string; more: number } | undefined {
  if (!files) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(files.path(id), 'r');
    const size = fstatSync(fd).size;
    const want = Math.min(size, Math.max(0, maxChars) * 4);
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const got = readSync(fd, buffer, read, want - read, read);
      if (got <= 0) break;
      read += got;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, read)).replace(/�$/, '');
    const kept = text.slice(0, maxChars);
    const keptBytes = Buffer.byteLength(kept, 'utf8');
    return { text: kept, more: Math.max(0, size - keptBytes) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

export interface Original {
  text: string;
  /** Gone (retention, a deleted message or journal row, a blob removed elsewhere, or only a truncated copy left). */
  pruned: boolean;
  /** Bytes of the original past `text` (a cut). */
  more: number;
}

/** A tool result's output as fully as it is kept, up to `max` characters. */
export function toolOutput(deps: OriginalDeps, item: JournalRow, max: number): Original {
  const blobs = blobIdsOf(item.data);
  if (blobs.length) {
    const parts: string[] = [];
    let more = 0;
    for (const id of blobs) {
      const read = readBlob(deps.files, id, Math.max(0, max - parts.join('\n').length));
      if (!read) return { text: safe(deps, outputTextOf(item.data.output)), pruned: true, more: 0 };
      parts.push(read.text);
      more += read.more;
    }
    return { text: safe(deps, parts.join('\n')), pruned: false, more };
  }
  const text = outputTextOf(item.data.output) || (typeof item.data.summary === 'string' ? item.data.summary : '');
  const full = typeof item.data.outputChars === 'number' ? item.data.outputChars : text.length;
  const cut = text.slice(0, max);
  // The journal kept only a truncated copy (the blob write failed): honest – not the whole original.
  return { text: safe(deps, cut), pruned: full > text.length + 64, more: Math.max(0, text.length - cut.length) };
}

/** The original behind a row, up to `max` characters (undefined only for an unreadable ref). */
export function originalOf(deps: OriginalDeps, row: LedgerRow, max: number): Original {
  const left: Original = { text: safe(deps, row.condensed ?? row.title), pruned: true, more: 0 };
  if (row.pruned_at !== null || !row.ref) return left;
  if (row.ref.startsWith('msg:')) {
    let message;
    try { message = deps.chats.message(row.ref.slice(4)); } catch { message = undefined; }
    if (!message) return left;
    const body = safe(deps, message.body);
    return { text: body.slice(0, max), pruned: false, more: Math.max(0, body.length - max) };
  }
  if (!row.ref.startsWith('item:')) return left;
  const item = journalRow(deps.db, row.ref.slice(5));
  if (!item) return left;
  if (item.kind === 'tool_result') {
    const out = toolOutput(deps, item, max);
    return out.pruned && !out.text ? left : out;
  }
  const text = typeof item.data.summary === 'string' ? item.data.summary : typeof item.data.text === 'string' ? item.data.text : '';
  return { text: safe(deps, text.slice(0, max)), pruned: false, more: Math.max(0, text.length - max) };
}

/** The arguments of the call behind a tool item (a path it names is no invention of whoever condenses its output). */
export function callArgsOf(deps: OriginalDeps, row: LedgerRow): string | undefined {
  if (!row.ref?.startsWith('item:')) return undefined;
  const result = journalRow(deps.db, row.ref.slice(5));
  if (!result || result.kind !== 'tool_result' || typeof result.data.callId !== 'string') return undefined;
  const args = callRow(deps.db, result.run_id, result.data.callId)?.data.args;
  return args === undefined ? undefined : safe(deps, typeof args === 'string' ? args : JSON.stringify(args));
}

function safe(deps: OriginalDeps, text: string): string {
  try { return deps.redact(text); } catch { return text; }
}
