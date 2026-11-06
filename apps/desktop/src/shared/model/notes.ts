// Shared chat notes: one Markdown document per chat that belongs to the chat (deleted with it) and that every
// member opens and edits – the owner, people of the organisation in their own chats, the chat's agents through
// the chat.notes.* tools. Last write wins; the version counts the writes.
// Owns: these shapes, the size limit and the notes.updated event. Never: behaviour (runtime/notes/store.ts).

/** The chat's notes now. `version` 0: nobody wrote any yet. */
export interface ChatNotes {
  conversationId: string;
  text: string;
  version: number;
  updatedAt?: number;
  /** 'human' (the caller's own side on a person's device), a person id, the owner alias or an agent id. */
  updatedBy?: string;
}

/** The chat's notes without their text (notes.meta): whether there are any, who changed them last, how long. */
export interface NotesMeta {
  conversationId: string;
  version: number;
  updatedAt?: number;
  updatedBy?: string;
  /** Characters of the current text. */
  size: number;
}

/** Pushed on the chat's topic after every write – ids and numbers only; clients fetch notes.get. */
export interface NotesUpdated {
  conversationId: string;
  version: number;
  updatedAt: number;
}

/** Longest notes text (characters). */
export const NOTES_MAX_CHARS = 30_000;

declare module '../api/events.ts' {
  interface EventMap {
    /** A new version of a chat's notes (topic chat:<id>). */
    'notes.updated': NotesUpdated;
  }
}
