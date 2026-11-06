// RPC contract part: a chat's shared notes (shared/model/notes.ts; handlers runtime/rpc/handlers/notes.ts) – the
// owner's window and phones ('chat' tier) and person variants for people in their own chats. Last write wins.
// Merged into Methods by module augmentation. Owns: these method shapes. Never: behaviour.

import type { ChatNotes, NotesMeta } from '../model/notes.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** The chat's notes now (version 0 and empty text when nobody wrote any yet). */
    'notes.get': { params: { conversationId: string }; result: ChatNotes };
    /** The same without the text – whether the chat has notes (version > 0) and who changed them last. */
    'notes.meta': { params: { conversationId: string }; result: NotesMeta };
    /** Replaces the text (last write wins); `baseVersion` (the version the editor loaded) is accepted and not needed. */
    'notes.save': { params: { conversationId: string; text: string; baseVersion?: number }; result: ChatNotes };
  }
}

export {};
