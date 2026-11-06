// The to-do behind a chat ask block, for every path that names a block by message + index
// (answers, snoozes, secret capture, the block's answered state): the one made from that block
// (client id `blk:<messageId>:<index>`), or – after a later block with the same "id" replaced it
// (tasks/human.ts ingestBlocks keeps the first client id and moves the to-do's messageId to the
// newer message) – the to-do of that block id anchored to this message, open or finished.
// Owns: that lookup (one indexed query each). Never: changes a task or reads a block of another chat.

import { uiBlocksOf } from '../../shared/blocks/parse.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { ChatService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { TaskRepo, toTask } from './repo.ts';

/** The to-do of block `blockIndex` (the chat's parse index) of message `messageId`, if it has one. */
export function blockTodo(s: { db: Db; chats: Pick<ChatService, 'message'> }, messageId: string, blockIndex: number): Task | undefined {
  const keyed = new TaskRepo(s.db).byClientId(`blk:${messageId}:${blockIndex}`);
  if (keyed) return keyed;
  const message = s.chats.message(messageId);
  if (!message) return undefined;
  const blockId = uiBlocksOf(message.body).find((item) => item.index === blockIndex)?.block.id;
  if (typeof blockId !== 'string' || !blockId) return undefined;
  const row = s.db.get<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE conversation_id = ? AND message_id = ? AND assignee_kind = 'human'
     AND json_extract(widget, '$.id') = ? ORDER BY created_at DESC LIMIT 1`,
    [message.conversationId, messageId, blockId],
  );
  return row ? toTask(row) : undefined; // none when a newer block took it over (its messageId moved on)
}
