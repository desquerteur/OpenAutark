// Editing and deleting a message (C6, split from chat/service.ts). The person edits only their own
// text messages – an agent's, a contact's or a system line never, so the person's words never
// stand under another author –; an agent or a colleague (F-52) only their own. Each change the person
// or (B-050 K3) a colleague makes to their own text in a chat with agents – and (B-050 K10) an
// agent's change of its own posted message (never its run's still-streaming placeholder) in a chat with other
// agents – gets a quiet notice line at the end of the log (a 'note' status line whose details name `edited`
// or `deleted`, the `seq`, who changed it as `by` and, for a deleted message, its time `at` –
// shared/model/message-changes.ts): agents may hold the old text in their sessions, and
// context/render.ts turns the notice into "· CEO edited #12; it now reads: …" (the text as it is when
// rendered, the newest notice per message only) or "· CEO deleted their message from 11:05 (#12)".
// The person's views hide notices – the message itself shows "edited", a deleted one of the person
// leaves its tombstone.
// A deleted text message of the person or a colleague leaves a quiet tombstone line at its place (same seq and time,
// details.tombstone = the deleted id); the message is deleted with everything it held
// (chat/lifecycle.ts removeMessage).
// B-050 K4: demoteMessage stores a braked important line as normal (the brake is chat/delivery.ts's).
// Owns: those rules and the notice and tombstone rows.
// Never: keeps the old text anywhere, wakes anyone or notifies the person.

import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Message, StatusLine } from '../../shared/model/chat.ts';
import { personalText } from '../../shared/model/message-changes.ts';
import { removeMessage, type ChatCore } from './lifecycle.ts';

export function editMessage(core: ChatCore, message: Message, body: string, by: string): Message {
  if (by === HUMAN_ID ? !personalText(message) || message.authorId !== HUMAN_ID : by !== message.authorId) { // F-52: never a colleague's words
    const text = by === HUMAN_ID ? 'Only your own messages can be edited.' : 'Only the author can edit this message.';
    throw new WorkforceError('forbidden', text, { details: { messageId: message.id } });
  }
  if (message.state === 'streaming') throw new WorkforceError('conflict', 'This message is still being written.', { details: { messageId: message.id } });
  if (body === message.body) return message;
  message.body = body;
  message.editedAt = core.s.clock.now();
  core.msgs.update(message);
  core.s.bus.emit('message.updated', message);
  core.emitConversation(message.conversationId);
  if (personalText(message) || message.authorKind === 'agent') notice(core, message, { edited: message.id }, by); // B-050 K3: every author alike
  return message;
}

export function deleteMessage(core: ChatCore, message: Message, by: string): void {
  removeMessage(core, message, by);
  if (personalText(message) && (by === HUMAN_ID || by === message.authorId)) { // K3: a colleague's own line like the owner's
    tombstone(core, message);
    notice(core, message, { deleted: message.id, at: message.createdAt }, by);
  } else if (by === message.authorId && message.authorKind === 'agent' && message.kind === 'text' && message.state !== 'streaming') {
    // K10: other agents may hold its text. Never for a run's own placeholder that is still streaming (an internal
    // or empty answer, a held one, an interrupted turn – agents/turn-finish.ts, turn-guard.ts): it was never posted
    // as a line, so a notice would only tell colleagues about a message they never got (B-050 live test, 28.10.).
    notice(core, message, { deleted: message.id, at: message.createdAt }, by);
  }
}

function tombstone(core: ChatCore, message: Message): void {
  const stone = systemLine(core, message.conversationId, { type: 'note', text: 'Message deleted', details: { tombstone: message.id } }, message.createdAt);
  stone.seq = message.seq;
  core.msgs.insert(stone); // the deleted row freed its seq
  core.s.bus.emit('message.created', stone);
  core.emitConversation(message.conversationId);
}

/**
 * One notice per change, only when an agent other than `by` is a member: render.ts shows agents only
 * the newest per message, so repeated edits never read twice. Its seq is quiet (ConversationRepo.nextSeq):
 * a line only agents read leaves the chat's place in the person's list and its updatedAt alone.
 */
function notice(core: ChatCore, message: Message, change: { edited: string } | { deleted: string; at: number }, by: string): void {
  if (!core.convs.members(message.conversationId).some((member) => member.kind === 'agent' && member.memberId !== by)) return;
  const text = `Message #${message.seq} was ${'edited' in change ? 'edited' : 'deleted'}`;
  const line = systemLine(core, message.conversationId, { type: 'note', text, details: { ...change, seq: message.seq, by } }, core.s.clock.now());
  core.s.db.tx(() => {
    line.seq = core.convs.nextSeq(line.conversationId, line.createdAt, { quiet: true });
    core.msgs.insert(line);
  });
  core.s.bus.emit('message.created', line);
  core.emitConversation(line.conversationId);
}

/** B-050 K4: an important line past the important brake (chat/delivery.ts) is stored as normal – its badge and its push agree. */
export function demoteMessage(core: ChatCore, message: Message): void {
  if (message.priority !== 'important') return;
  message.priority = 'normal';
  core.msgs.update(message);
  core.s.bus.emit('message.updated', message);
  core.emitConversation(message.conversationId);
}

/** A quiet status row from the system; the caller sets its seq. */
function systemLine(core: ChatCore, conversationId: string, status: StatusLine, createdAt: number): Message {
  return {
    id: newId('msg', core.s.clock.now()), conversationId, seq: 0, authorId: SYSTEM_ID, authorKind: 'system',
    kind: 'status', body: status.text, attachments: [], mentions: [], priority: 'normal', state: 'final', silent: true, meta: { status },
    createdAt,
  };
}
