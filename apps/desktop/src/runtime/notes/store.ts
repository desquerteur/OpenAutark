// A chat's shared notes: one Markdown text per chat (chat_notes, migration 67; deleted with the chat) that every
// member edits – the owner, people of the chat (person variants, rpc/handlers/notes.ts) and its agents
// (chat.notes.* tools). Last write wins; every write bumps the version and sends 'notes.updated' on the chat's
// topic (ids and numbers only). A person sees ids from their side (people/perspective.ts).
// Owns: the row, the version and the event. Never: history, merges or refusals beyond "the chat exists" and,
// for a person, "you are in it".

import { WorkforceError } from '../../shared/errors.ts';
import type { ChatNotes, NotesMeta } from '../../shared/model/notes.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { membership } from '../people/access.ts';
import { viewId } from '../people/perspective.ts';

type Services = Pick<RuntimeServices, 'db' | 'clock' | 'bus' | 'chats'>;
type NotesRow = { text: string; version: number; updated_at: number; updated_by: string };

/** The version of a chat's notes (0: none) – one indexed read for the prompt's chat line; 0 without the table. */
export function notesVersion(db: Db, conversationId: string): number {
  try { return Number(db.get<{ version: number }>('SELECT version FROM chat_notes WHERE conversation_id = ?', [conversationId])?.version ?? 0); } catch { return 0; }
}

/** The chat's notes now (version 0 and empty text when nobody wrote any). */
export function getNotes(s: Pick<Services, 'db'>, conversationId: string): ChatNotes {
  const row = s.db.get<NotesRow>('SELECT text, version, updated_at, updated_by FROM chat_notes WHERE conversation_id = ?', [conversationId]);
  if (!row) return { conversationId, text: '', version: 0 };
  return { conversationId, text: String(row.text), version: Number(row.version), updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by) };
}

/** The same without the text. */
export function notesMeta(s: Pick<Services, 'db'>, conversationId: string): NotesMeta {
  const { text, ...rest } = getNotes(s, conversationId);
  return { ...rest, size: text.length };
}

/** Replaces the text (last write wins). */
export function saveNotes(s: Services, conversationId: string, text: string, by: string): ChatNotes {
  const now = s.clock.now();
  const version = notesVersion(s.db, conversationId) + 1;
  s.db.run(
    `INSERT INTO chat_notes (conversation_id, text, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [conversationId, text, version, now, by],
  );
  s.bus.emit('notes.updated', { conversationId, version, updatedAt: now });
  return { conversationId, text, version, updatedAt: now, updatedBy: by };
}

/** Adds text at the end (a blank line between). */
export function appendNotes(s: Services, conversationId: string, addition: string, by: string): ChatNotes {
  const current = getNotes(s, conversationId).text.trimEnd();
  return saveNotes(s, conversationId, current ? `${current}\n\n${addition.trim()}\n` : `${addition.trim()}\n`, by);
}

/** The chat exists (else not_found). */
export function openChat(s: Pick<Services, 'chats'>, conversationId: string): void {
  if (!s.chats.get(conversationId)) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId } });
}

/** A person opens only chats they are an active member of. */
export function personOpens(s: Pick<Services, 'db' | 'chats'>, personId: string, conversationId: string): void {
  if (!membership(s.db, personId, conversationId) || !s.chats.get(conversationId)) {
    throw new WorkforceError('forbidden', 'Only people in this chat open its notes.', { details: { conversationId } });
  }
}

/** The notes (or their meta) as person `self` sees them. */
export function viewNotes<T extends Pick<ChatNotes, 'updatedBy'>>(self: string, notes: T): T {
  return notes.updatedBy === undefined ? notes : { ...notes, updatedBy: viewId(self, notes.updatedBy) };
}
