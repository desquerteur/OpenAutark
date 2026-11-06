// Deleting a stored file on the person's request (MM6, `media.uses` / `media.delete`): the uses
// first (files/references.ts), then – only when nothing but the confirmed messages keeps it –
// those messages (each through ChatService.removeMessage, as the person) and the file itself
// (blob, files row, media row; Blobs.remove). Sensitive recordings go for good, cached text
// such as a transcript included.
// media.uses names what the confirmation must show: each message's chat and one line of it,
// and the other files only those messages hold (removing a message frees its files, so the
// clean-up removes them too). Messages that only name the file's id in their text (a link in
// an agent's report) are counted as mentions; they never block the deletion and are never
// deleted – their link simply stops working.
// Refused with 'conflict' (details.uses: MediaUses) while an agent works with the file, while
// anything besides the confirmed messages uses it (another message, a draft, a task, an
// avatar …), or while the same bytes are being stored. Never deletes a message the request did
// not name or that does not attach or show the file.
// Owns: those checks, their order and the confirmation details. Never: decides what counts as
// a use, or deletes anything for an agent (owner RPC only).

import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { usesText, type MediaUseMessage, type MediaUses } from '../../shared/model/media-uses.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import { messageFileIds } from '../chat/reclaim.ts';
import type { RuntimeServices } from '../contracts.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { FILE_ID, fileUses } from '../files/references.ts';
import { FileRepo } from '../store/files.ts';
import { ROOT_SETTINGS } from '../root/layout.ts';

export type DeleteServices = Pick<RuntimeServices, 'db' | 'chats' | 'files'> & Partial<Pick<RuntimeServices, 'paths'>>;

/** Other files checked / named per confirmation (each check is a handful of indexed lookups). */
const ALONGSIDE_CHECKS = 50;
const ALONGSIDE_MAX = 20;
const PREVIEW_CHARS = 60;

/** <data>/settings.json (a setting naming the file keeps it). */
const settingsFile = (s: DeleteServices): string | undefined => (s.paths ? path.join(s.paths.data, ROOT_SETTINGS) : undefined);

function requireFile(s: DeleteServices, fileId: string): void {
  if (!FILE_ID.test(fileId) || !new FileRepo(s.db).get(fileId)) throw new WorkforceError('not_found', 'This file does not exist.', { details: { fileId } });
}

function conflict(message: string, uses: MediaUses): never {
  throw new WorkforceError('conflict', message, { details: { uses } });
}

/** Nothing but the listed messages keeps this other file (the clean-up would remove it with them). */
function onlyIn(s: DeleteServices, fileId: string, listed: ReadonlySet<string>): boolean {
  const uses = fileUses(s.db, fileId, settingsFile(s));
  return !uses.moreMessages && !uses.mentions && !uses.other.length && uses.messages.every((message) => listed.has(message.id));
}

/** What still uses a stored file (media.uses), with what the confirmation names (see the header). */
export function usesOf(s: DeleteServices, fileId: string): MediaUses {
  requireFile(s, fileId);
  const uses = fileUses(s.db, fileId, settingsFile(s));
  if (!uses.messages.length) return uses;
  const listed = new Set(uses.messages.map((message) => message.id));
  const files = new FileRepo(s.db);
  const checked = new Set<string>([fileId]);
  const alongside: NonNullable<MediaUses['alongside']> = [];
  uses.messages = uses.messages.map((ref): MediaUseMessage => {
    const entry: MediaUseMessage = { ...ref };
    const chat = s.chats.get(ref.conversationId)?.title;
    if (chat) entry.chat = chat;
    const message = s.chats.message(ref.id);
    if (!message) return entry;
    const preview = previewText(message.body, message.attachments, PREVIEW_CHARS);
    if (preview) entry.preview = preview;
    for (const id of messageFileIds(message)) {
      if (checked.has(id) || checked.size > ALONGSIDE_CHECKS || alongside.length >= ALONGSIDE_MAX) continue;
      checked.add(id);
      const file = files.get(id);
      if (file && onlyIn(s, id, listed)) alongside.push({ fileId: id, name: file.name });
    }
    return entry;
  });
  if (alongside.length) uses.alongside = alongside;
  return uses;
}

/** Deletes the file and the confirmed messages that show it (see the header). */
export async function deleteFile(s: DeleteServices, fileId: string, messageIds: readonly string[] = []): Promise<void> {
  requireFile(s, fileId);
  const store = reclaimerOf(s.files);
  if (!store) throw new WorkforceError('unavailable', 'Files cannot be deleted here.');
  const uses = fileUses(s.db, fileId, settingsFile(s));
  if (uses.busy) conflict('An agent is working with this file right now. Try again when it is done.', uses);
  if (uses.other.length) conflict(`This file is still used by ${usesText({ messages: [], other: uses.other })}. Remove it there first.`, uses);
  const confirmed = new Set(messageIds);
  const unconfirmed = uses.messages.filter((message) => !confirmed.has(message.id));
  if (uses.moreMessages || unconfirmed.length) {
    conflict(`This file is still in ${usesText({ messages: uses.messages, moreMessages: uses.moreMessages, other: [] })}.`, uses);
  }
  for (const message of uses.messages) s.chats.removeMessage(message.id, HUMAN_ID);
  const left = fileUses(s.db, fileId, settingsFile(s));
  if (left.busy || left.other.length || left.messages.length) conflict(`This file is still used by ${usesText(left) || 'an agent'}.`, left);
  if (!(await store.remove(fileId))) {
    throw new WorkforceError('conflict', 'The file is being stored right now. Try again in a moment.', { details: { uses: left } });
  }
}
