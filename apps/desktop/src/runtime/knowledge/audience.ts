// Who reads a chat (the owner and its active human members) – the readers a turn writes for. Memory has no
// chat-scoped audience any more: every agent reads the organisation's notes, a note private to one chat uses
// scope 'conversation'.
// Owns: that read. Never: hides anything.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Db } from '../db/database.ts';

/** The owner's eyes: the owner's views and turns without a chat. */
export const OWNER_READERS: readonly string[] = [HUMAN_ID];

/** The humans of a chat now (the owner always among them). */
export function chatReaders(db: Db, conversationId: string): { readers: string[] } {
  const rows = db.all<{ member_id: string }>(`SELECT member_id FROM members WHERE conversation_id = ? AND kind = 'human' AND left_at IS NULL`, [conversationId]);
  return { readers: [...new Set([HUMAN_ID, ...rows.map((row) => row.member_id)])].sort() };
}

/** The readers of a turn: its chat's, or the owner's for a turn without a chat. */
export function turnReaders(db: Db | undefined, conversationId: string | undefined): string[] {
  return conversationId && db ? chatReaders(db, conversationId).readers : [...OWNER_READERS];
}

