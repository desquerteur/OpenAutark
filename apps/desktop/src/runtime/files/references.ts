// Who still uses a stored file (MM6) – asked before the blob clean-up (files/cleanup.ts) or the
// person (media.delete) removes it. A file id is a sha256, so any place whose text contains the
// 64-hex id names exactly this file; every check below is a lookup for that id:
//   messages   attachments (partial index messages_files, migration 020) and the body – ```ui
//              blocks with fileId/image, links and blob paths – through the full-text index
//              (an id is one token there; status lines carry no files and are not indexed).
//              A message that attaches the file or shows it in a block uses it; one that only
//              names the id in its text (a link in a report) is a mention: it keeps the file
//              from the clean-up, but media.delete leaves the message alone.
//   drafts     attachments of an unsent draft (the composer's uploads)
//   tasks      a to-do's widget, its answer and evidence (result) and the notes
//   knowledge  a memory learned from the file (source ref) or naming it: an old version's row, or a memory file (the tree's
//              record of what it names, knowledge/memory-blobs.ts – reading the tree here would stop the app at its size)
//   agents     image avatars (archived agents too: they can be restored)
//   chats      a group chat's picture (settings.image)
//   settings   the person's profile picture and any other setting naming it (<data>/settings.json, the one store)
//   feedback   screenshots and annotations of feedback reports
//   schedules  active ones only
//   kv         saved mini-app/block state and other module state (not the clean-up queue)
// "Busy" (an agent works with it): an unfinished run's journal or a pending wake names the id
// (tool calls and results, "path: …" lines of answer wakes – a blob path ends with the id).
// The media library row itself is not a use, and a finished run's journal is history.
// Owns: that list and its queries, and which files the clean-up queue holds already (unqueuedIds).
// Never: deletes anything or reads blob bytes.

import { readFileSync } from 'node:fs';
import type { Db } from '../db/database.ts';
import { MEMORY_BLOBS_NS } from '../knowledge/memory-blobs.ts';
import { blockFileIds } from '../media/outputs.ts';
import { MEDIA_USE_KINDS, type MediaUseKind, type MediaUses } from '../../shared/model/media-uses.ts';

export const FILE_ID = /^[a-f0-9]{64}$/;
/** The clean-up queue's kv namespace (files/cleanup.ts) – never counted as a use. */
export const RECLAIM_NS = 'files.reclaim';
/** Messages listed per file (media.uses, conflict details). */
export const MESSAGE_LIMIT = 100;

/** One query per kind; `?1` is the file id, `chat` the conversation the use belongs to (or NULL). Settings: see inSettings. */
const OTHER_SQL: Record<Exclude<MediaUseKind, 'settings'>, string> = {
  draft: 'SELECT conversation_id AS chat FROM drafts WHERE instr(attachments, ?1) > 0 LIMIT 1',
  task: 'SELECT conversation_id AS chat FROM tasks WHERE instr(widget, ?1) > 0 OR instr(result, ?1) > 0 OR instr(notes, ?1) > 0 LIMIT 1',
  knowledge: `SELECT NULL AS chat FROM knowledge WHERE instr(source, ?1) > 0 OR instr(body, ?1) > 0
    UNION ALL SELECT NULL AS chat FROM kv WHERE ns = '${MEMORY_BLOBS_NS}' AND instr(value, ?1) > 0 LIMIT 1`,
  avatar: 'SELECT NULL AS chat FROM agents WHERE instr(avatar, ?1) > 0 LIMIT 1',
  chat: 'SELECT id AS chat FROM conversations WHERE instr(settings, ?1) > 0 LIMIT 1',
  feedback: 'SELECT NULL AS chat FROM feedback WHERE screenshot_file_id = ?1 OR annotation_file_id = ?1 LIMIT 1',
  schedule: 'SELECT conversation_id AS chat FROM schedules WHERE active = 1 AND instr(payload, ?1) > 0 LIMIT 1',
  app: `SELECT NULL AS chat FROM kv WHERE ns NOT IN ('${RECLAIM_NS}', '${MEMORY_BLOBS_NS}') AND instr(value, ?1) > 0 LIMIT 1`,
};

const ATTACHED = `SELECT id, conversation_id FROM messages WHERE attachments <> '[]' AND instr(attachments, ?) > 0 LIMIT ?`;
const NAMED = `SELECT m.id, m.conversation_id, m.kind, m.body FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? LIMIT ?`;
const RUNNING = `SELECT 1 AS hit FROM run_items i JOIN runs r ON r.id = i.run_id WHERE r.status IN ('queued', 'running') AND instr(i.data, ?) > 0 LIMIT 1`;
const WAKING = 'SELECT 1 AS hit FROM wakes WHERE instr(note, ?) > 0 LIMIT 1';

type MessageRow = { id: string; conversation_id: string; kind?: string; body?: string };

/** settings.json (`settingsFile`, absent: none) names the file – the profile picture or any other setting. */
function inSettings(settingsFile: string | undefined, fileId: string): boolean {
  if (!settingsFile) return false;
  try { return readFileSync(settingsFile, 'utf8').includes(fileId); } catch { return false; }
}

/** The use of one kind, with its chat (NULL: none) – undefined when that kind does not use the file. */
function useOf(db: Db, kind: MediaUseKind, fileId: string, settingsFile: string | undefined): { chat: string | null } | undefined {
  if (kind === 'settings') return inSettings(settingsFile, fileId) ? { chat: null } : undefined;
  return db.get<{ chat: string | null }>(OTHER_SQL[kind], [fileId]);
}

/** Messages that attach or show the file, those that only name its id, and whether either list was cut. */
interface MessageHits { using: MessageRow[]; mentioning: MessageRow[]; more: boolean }

/** A text message whose ```ui blocks show the file (media, file or cards blocks). */
const shows = (row: MessageRow, fileId: string): boolean =>
  row.kind === 'text' && typeof row.body === 'string' && blockFileIds(row.body).includes(fileId);

/** Distinct messages naming the file (at most `limit` + 1 each). A cut full-text list counts as "more" (an unread hit may show it). */
function messagesNaming(db: Db, fileId: string, limit: number): MessageHits {
  const using = new Map<string, MessageRow>();
  const mentioning = new Map<string, MessageRow>();
  const attached = db.all<MessageRow>(ATTACHED, [fileId, limit + 1]);
  for (const row of attached) using.set(row.id, row);
  let more = attached.length > limit;
  if (!more) {
    const named = db.all<MessageRow>(NAMED, [`"${fileId}"`, limit + 1]);
    more = named.length > limit;
    for (const row of named) if (!using.has(row.id)) (shows(row, fileId) ? using : mentioning).set(row.id, row);
  }
  return { using: [...using.values()].slice(0, limit + 1), mentioning: [...mentioning.values()].slice(0, limit), more: more || using.size > limit };
}

/** Every use of the file (messages listed up to MESSAGE_LIMIT, mentions counted) and whether an agent works with it. */
export function fileUses(db: Db, fileId: string, settingsFile?: string, limit = MESSAGE_LIMIT): MediaUses {
  if (!FILE_ID.test(fileId)) return { messages: [], other: [] };
  const hits = messagesNaming(db, fileId, limit);
  const uses: MediaUses = {
    messages: hits.using.slice(0, limit).map((row) => ({ id: row.id, conversationId: row.conversation_id })),
    other: MEDIA_USE_KINDS.filter((kind) => useOf(db, kind, fileId, settingsFile) !== undefined),
  };
  if (hits.more) uses.moreMessages = true;
  if (hits.mentioning.length) uses.mentions = hits.mentioning.length;
  if (isBusy(db, fileId)) uses.busy = true;
  return uses;
}

/**
 * The first use found (messages first – a mention counts here – then the kinds in their stable
 * order) with the chat it belongs to – undefined when nothing uses the file. Stops at the first hit.
 */
export function firstUse(db: Db, fileId: string, settingsFile?: string): { kind: 'message' | MediaUseKind; conversationId?: string } | undefined {
  if (!FILE_ID.test(fileId)) return undefined;
  const hits = messagesNaming(db, fileId, 1);
  const message = hits.using[0] ?? hits.mentioning[0];
  if (message) return { kind: 'message', conversationId: message.conversation_id };
  for (const kind of MEDIA_USE_KINDS) {
    const row = useOf(db, kind, fileId, settingsFile);
    if (row) return row.chat ? { kind, conversationId: row.chat } : { kind };
  }
  return undefined;
}

/** True when anything uses the file (see the header). */
export function isReferenced(db: Db, fileId: string, settingsFile?: string): boolean {
  return firstUse(db, fileId, settingsFile) !== undefined;
}

/** The ids not in the clean-up queue yet: one already queued keeps its due time (a hold another entry set). */
export function unqueuedIds(db: Db, ids: readonly string[]): string[] {
  return ids.filter((id) => db.get('SELECT 1 AS hit FROM kv WHERE ns = ? AND key = ?', [RECLAIM_NS, id]) === undefined);
}

/** An unfinished run's journal or a pending wake names the file: an agent is working with it. */
export function isBusy(db: Db, fileId: string): boolean {
  if (!FILE_ID.test(fileId)) return false;
  return db.get(RUNNING, [fileId]) !== undefined || db.get(WAKING, [fileId]) !== undefined;
}
