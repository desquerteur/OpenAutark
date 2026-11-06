// Files an agent's mini-app to-do hands back (X03): the host stores the frame's wf.upload Blob
// (files.uploadChunk) and registers it with blocks.file for that one ```app todo=true block – kv
// 'app_files', key `<messageId>:<blockIndex>`, value {ids, bytes}. A kv value naming a file counts
// as a use (files/references.ts), so registered takes stay until they are released.
// The to-do's answer attaches only these files (tasks/answer-files.ts): the ones its data names,
// or all of them when it names none. Answering or declining the to-do (tasks/human.ts), cancelling
// or removing it – an agent's cancel, its message deleted, the to-do removed (tasks/lifecycle.ts) –
// or deleting its chat (chat/lifecycle.ts, chat/reclaim.ts chatAppTakes) releases the entry and
// queues the takes it did not hand back for the blob clean-up (files/cleanup.ts keeps a file that
// anything else uses). A refused file stored in the last two minutes is queued too (the host just
// stored it for nothing) – never an older one, so blocks.file cannot queue arbitrary stored files.
// When an agent's open mini-app to-do refuses such a file for its type or size, its bytes count
// against the block's 300 MB, so an app cannot loop refused uploads past the cap; the refusal's
// details carry the block's totals, so the host stops before storing the next one.
// Owns: the registry, its checks (shared/blocks/app-files.ts, on the stored file's sniffed type)
// and the release. Never: reads bytes, accepts a file for a block the person or a bridge wrote,
// for a finished to-do or beyond the block's limits, cuts short a hold another queue entry set,
// keeps a refused file's id (a kv value naming it would count as a use), or counts as consent.

import { WorkforceError } from '../../shared/errors.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { APP_UPLOAD_LIMITS, appBlockRefusal, appFileRefusal, type AppUploadLimits } from '../../shared/blocks/app-files.ts';
import { appTodosOf } from '../../shared/blocks/parse.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { FILE_ID, unqueuedIds } from '../files/references.ts';
import { KvRepo } from '../store/kv.ts';
import { blockTodo } from './block-todo.ts';

export const APP_FILES_NS = 'app_files';
/** A refused file is queued for the clean-up only when it was stored this recently (the upload just made). */
export const APP_FILE_FRESH_MS = 2 * 60_000;
/** Values of an answer read when looking for the files it names (and how deep). */
const WALK_VALUES = 500;
const WALK_DEPTH = 4;

/** ids: registered files in order; bytes: theirs plus those of fresh files the block refused (stored for nothing). */
interface Entry { ids: string[]; bytes: number }
type RegisterDeps = Pick<RuntimeServices, 'db' | 'chats' | 'files' | 'clock'> & Partial<Pick<RuntimeServices, 'log'>>;
type ReleaseDeps = Pick<RuntimeServices, 'db'> & Partial<Pick<RuntimeServices, 'files' | 'log'>>;

const keyOf = (messageId: string, blockIndex: number) => `${messageId}:${blockIndex}`;

function entryOf(db: Db, messageId: string, blockIndex: number): Entry {
  const value = new KvRepo(db).get<Partial<Entry>>(APP_FILES_NS, keyOf(messageId, blockIndex));
  const ids = Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === 'string' && FILE_ID.test(id)) : [];
  const bytes = typeof value?.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes > 0 ? value.bytes : 0;
  return { ids, bytes };
}

/** The files registered for block `blockIndex` of message `messageId`, in the order they came. */
export function appFileIds(db: Db, messageId: string, blockIndex: number): string[] {
  return entryOf(db, messageId, blockIndex).ids;
}

/** Queues files for the blob clean-up; a file already queued keeps its due time (an external upload's hold). */
function queue(s: ReleaseDeps, ids: readonly string[]): void {
  if (!ids.length) return;
  try {
    const unqueued = unqueuedIds(s.db, ids);
    if (unqueued.length) reclaimerOf(s.files)?.reclaim(unqueued);
  } catch (error) {
    s.log?.debug('mini-app files not queued for clean-up', { files: ids.length, error: String(error) });
  }
}

/** blocks.file: registers stored file `fileId` for the agent mini-app to-do of the block (see the header). */
export function registerAppFile(s: RegisterDeps, input: { messageId: string; blockIndex: number; fileId: string }, limits: AppUploadLimits = APP_UPLOAD_LIMITS): { file: FileRef; count: number; bytes: number } {
  const { messageId, blockIndex, fileId } = input;
  if (!FILE_ID.test(fileId)) throw new WorkforceError('bad_request', 'Invalid parameter "fileId": expected a file id.', { details: { param: 'fileId' } });
  let file: FileRef | undefined;
  try { file = s.files.get(fileId); } catch { file = undefined; }
  const fresh = file !== undefined && s.clock.now() - file.createdAt <= APP_FILE_FRESH_MS;
  const refuse = (error: WorkforceError): never => {
    if (fresh) queue(s, [fileId]);
    throw error;
  };
  const message = s.chats.message(messageId);
  if (!message) return refuse(new WorkforceError('not_found', 'Message not found.', { details: { messageId } }));
  if (message.authorKind !== 'agent' || message.meta?.via === 'bridge') {
    return refuse(new WorkforceError('bad_request', 'Invalid parameter "messageId": expected a message written by an agent.', { details: { param: 'messageId' } }));
  }
  if (!appTodosOf(message.body).some((item) => item.index === blockIndex)) {
    return refuse(new WorkforceError('bad_request', 'Invalid parameter "blockIndex": expected a mini-app to-do.', { details: { param: 'blockIndex' } }));
  }
  const todo = blockTodo(s, messageId, blockIndex);
  if (!todo) return refuse(new WorkforceError('not_found', 'To-do not found.', { details: { messageId, blockIndex } }));
  if (todo.status === 'done' || todo.status === 'cancelled') return refuse(new WorkforceError('conflict', 'This to-do is already finished.', { details: { taskId: todo.id } }));
  if (!file) throw new WorkforceError('not_found', 'File not found.', { details: { fileId } });
  const kv = new KvRepo(s.db);
  const entry = entryOf(s.db, messageId, blockIndex);
  // The block's own refusals name its totals (the host stops before storing what cannot fit).
  const refuseHere = (code: 'bad_request' | 'rate_limited', text: string, totals: Entry): never =>
    refuse(new WorkforceError(code, text, { details: { messageId, blockIndex, fileId, count: totals.ids.length, bytes: totals.bytes } }));
  const refusal = appFileRefusal(file, limits);
  if (refusal) {
    const spent: Entry = fresh ? { ids: entry.ids, bytes: entry.bytes + file.size } : entry; // stored for this block for nothing
    if (fresh) kv.set(APP_FILES_NS, keyOf(messageId, blockIndex), spent, s.clock.now());
    return refuseHere('bad_request', refusal, spent);
  }
  if (entry.ids.includes(fileId)) return { file, count: entry.ids.length, bytes: entry.bytes };
  const over = appBlockRefusal({ count: entry.ids.length, bytes: entry.bytes }, file.size, limits);
  if (over) return refuseHere('rate_limited', over, entry);
  const next: Entry = { ids: [...entry.ids, fileId], bytes: entry.bytes + file.size };
  kv.set(APP_FILES_NS, keyOf(messageId, blockIndex), next, s.clock.now());
  return { file, count: next.ids.length, bytes: next.bytes };
}

/**
 * The registered files an app's answer hands back: the strings in its data (up to four levels
 * deep, at most 500 values read) that are registered ids, in the order found – all registered
 * ids when it names none. An id that is not registered for the block never counts.
 */
export function appAnswerFileIds(answer: unknown, registered: readonly string[]): string[] {
  if (!registered.length) return [];
  const known = new Set(registered);
  const named = new Set<string>();
  let budget = WALK_VALUES;
  const walk = (value: unknown, depth: number): void => {
    if (budget-- <= 0) return;
    if (typeof value === 'string') { if (known.has(value)) named.add(value); return; }
    if (depth >= WALK_DEPTH || !value || typeof value !== 'object') return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (budget <= 0) return;
      walk(item, depth + 1);
    }
  };
  walk(answer, 0);
  return named.size ? [...named] : [...registered];
}

/**
 * After a mini-app to-do was answered, declined, cancelled or removed: its registry entry goes and
 * the registered files not in `kept` (the answer's attachments) are queued for the clean-up. Other
 * widgets: nothing.
 */
export function releaseAppFiles(s: ReleaseDeps, widget: unknown, kept: readonly string[]): void {
  const app = appWidgetOf(widget);
  if (!app) return;
  const { ids } = entryOf(s.db, app.messageId, app.index);
  new KvRepo(s.db).delete(APP_FILES_NS, keyOf(app.messageId, app.index));
  const keep = new Set(kept);
  queue(s, ids.filter((id) => !keep.has(id)));
}
