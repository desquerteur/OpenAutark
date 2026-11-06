// RPC contract part: the media library – stored files of all chats, their descriptions, what
// still uses a file and deleting it. Handlers: runtime/rpc/handlers/media.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method shapes. Never: behaviour.

import type { MediaFilter, MediaInfo } from '../model/media.ts';
import type { MediaUses } from '../model/media-uses.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- media library (added by R4 contracts)
    /** Media of all chats or one chat, newest first; `text` searches name, description and tags. */
    'media.list': { params: MediaFilter | void; result: MediaInfo[] };
    /** Sets the description/tags of a stored file (by the human). Owner scope. */
    'media.describe': { params: { fileId: string; description?: string; tags?: string[] }; result: MediaInfo };
    /** MM6: what still uses a stored file (messages, drafts, tasks, avatars …; busy = an agent works with it). Owner scope. */
    'media.uses': { params: { fileId: string }; result: MediaUses };
    /** MM6: deletes a stored file for good with the listed messages that show it; 'conflict' (details.uses) while anything else uses it. Owner scope. */
    'media.delete': { params: { fileId: string; messageIds?: string[] }; result: { ok: true } };
  }
}

export {};
