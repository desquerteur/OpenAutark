// Files a chat deletion or a message deletion may free (MM6): collected while the rows still
// exist and handed to the blob clean-up of the store (files/cleanup.ts decides – it removes
// only files nothing else uses, never younger than 60 s, never while an agent works with
// them). A changed draft frees nothing: the composer clears it right before sending.
// Owns: which file ids a chat (its draft and its mini-app takes included) and a message hold.
// Never: removes anything itself or queues anything for a store without a clean-up (test fakes).

import type { Conversation, Message } from '../../shared/model/chat.ts';
import { json, type Db } from '../db/database.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { FILE_ID, unqueuedIds } from '../files/references.ts';
import { blockFileIds } from '../media/outputs.ts';
import { MediaRepo } from '../media/repo.ts';
import { APP_FILES_NS } from '../tasks/app-files.ts';

/** kv keys `<messageId>:…` of the messages of chat `?`. */
export const OF_CHAT_MESSAGE = `substr(key, 1, instr(key, ':') - 1) IN (SELECT id FROM messages WHERE conversation_id = ?)`;

const attachmentIds = (list: unknown): string[] => (Array.isArray(list) ? list : [])
  .map((item) => (item && typeof item === 'object' ? (item as { fileId?: unknown }).fileId : undefined))
  .filter((id): id is string => typeof id === 'string' && FILE_ID.test(id));

/** True when the store has a clean-up (collecting ids is skipped otherwise). */
export function canReclaim(files: unknown): boolean {
  return reclaimerOf(files) !== undefined;
}

/** Attachments and ```ui block files of one message. */
export function messageFileIds(message: Pick<Message, 'kind' | 'body' | 'attachments'>): string[] {
  const ids = new Set(attachmentIds(message.attachments));
  if (message.kind === 'text') for (const id of blockFileIds(message.body)) ids.add(id);
  return [...ids];
}

/** Every file a chat holds: its media rows, attachments and block files, its draft and its picture. */
export function chatFileIds(db: Db, conversation: Pick<Conversation, 'id' | 'settings'>, draft?: readonly unknown[]): string[] {
  const ids = new Set(new MediaRepo(db).fileIdsIn(conversation.id));
  const rows = db.all<{ attachments: string }>(`SELECT attachments FROM messages WHERE conversation_id = ? AND attachments <> '[]'`, [conversation.id]);
  for (const row of rows) for (const id of attachmentIds(json<unknown[]>(row.attachments, []))) ids.add(id);
  const fenced = db.all<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = ? AND kind = 'text' AND (instr(body, '\`\`\`') > 0 OR instr(body, '~~~') > 0)`, [conversation.id]);
  for (const row of fenced) for (const id of blockFileIds(row.body)) ids.add(id);
  for (const id of attachmentIds(draft)) ids.add(id);
  if (conversation.settings.image && FILE_ID.test(conversation.settings.image)) ids.add(conversation.settings.image);
  return [...ids];
}

/**
 * X03: the takes registered for the chat's mini-app to-dos (kv APP_FILES_NS, keyed
 * `<messageId>:<block>`, value {ids, bytes}). Their entries go with the chat (chat/lifecycle.ts),
 * so nothing holds them any more. A take already queued is left out: it keeps its due time (a hold).
 */
export function chatAppTakes(db: Db, conversationId: string): string[] {
  const ids = new Set<string>();
  const rows = db.all<{ value: string }>(`SELECT value FROM kv WHERE ns = ? AND ${OF_CHAT_MESSAGE}`, [APP_FILES_NS, conversationId]);
  for (const row of rows) {
    const listed = json<{ ids?: unknown } | null>(row.value, null)?.ids;
    for (const id of Array.isArray(listed) ? listed : []) if (typeof id === 'string' && FILE_ID.test(id)) ids.add(id);
  }
  return unqueuedIds(db, [...ids]);
}

/** Hands file ids to the store's clean-up; never throws (a deletion must not fail on it). */
export function queueReclaim(files: unknown, ids: readonly string[]): void {
  if (!ids.length) return;
  try { reclaimerOf(files)?.reclaim(ids); } catch { /* the clean-up logs its own failures */ }
}
