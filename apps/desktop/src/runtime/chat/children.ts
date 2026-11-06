// Sub-chats and threads (B-078, owner 06.11.: "Chats, die unter der Überordnung von anderen Chats sind" and threads
// "wie bei Discord"). A sub-chat is a chat placed under another one (settings.parentId) – one level: its parent is
// a chat that exists, is not app-owned and is no sub-chat itself, and a chat with sub-chats of its own stays on top.
// A thread is a sub-chat that answers one message of its parent (settings.anchorId): one per message, made with the
// parent's members (the one who opens it among them), named after the message; it lives in the chat's side panel,
// never in the list. Both are settings keys only – no migration, nothing inherited after creation.
// A thread whose message is deleted stays as a plain sub-chat (keepThreadOf); a deleted chat takes its threads along and
// puts its sub-chats back on top (chat/service.ts remove).
// Owns: checking and writing parentId, finding and making a thread, listing a chat's children.
// Never: changes the members of an existing chat, moves a thread off a message that still exists, or nests deeper than one level.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { Conversation, Message } from '../../shared/model/chat.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import type { RuntimeServices } from '../contracts.ts';

type ChildDeps = Pick<RuntimeServices, 'db' | 'chats'>;

/** The ids of the chats directly under `parentId` (threads too). */
export function childrenOf(s: Pick<RuntimeServices, 'db'>, parentId: string): string[] {
  return s.db.all<{ id: string }>(`SELECT id FROM conversations WHERE json_extract(settings, '$.parentId') = ? ORDER BY created_at`, [parentId]).map((row) => row.id);
}

/** The thread on message `anchorId`, when there is one. */
export function threadOf(s: Pick<RuntimeServices, 'db'>, anchorId: string): string | undefined {
  return s.db.get<{ id: string }>(`SELECT id FROM conversations WHERE json_extract(settings, '$.anchorId') = ? ORDER BY created_at LIMIT 1`, [anchorId])?.id;
}

const isActive = (s: ChildDeps, chatId: string, memberId: string) =>
  s.chats.members(chatId).some((member) => member.memberId === memberId && member.leftAt === undefined);

function chatOf(s: ChildDeps, chatId: string): Conversation {
  const chat = s.chats.get(chatId);
  if (!chat) throw new WorkforceError('not_found', `Chat ${chatId} not found.`, { details: { conversationId: chatId } });
  return chat;
}

/** An agent acts only in chats it is a member of; the owner (and the system) in every chat. */
function checkMember(s: ChildDeps, chatId: string, by: string): void {
  if (by === HUMAN_ID || by === SYSTEM_ID || isActive(s, chatId, by)) return;
  throw new WorkforceError('forbidden', `I am not a member of chat ${chatId}.`, { details: { conversationId: chatId } });
}

/** Why `parentId` cannot hold `child` (see the header); undefined when it can. Wording in the voice of the one who tried. */
export function parentRefusal(s: ChildDeps, child: Conversation, parentId: string): string | undefined {
  if (parentId === child.id) return 'A chat sits under another chat, not under itself.';
  const parent = s.chats.get(parentId);
  if (!parent) return `Chat ${parentId} not found.`;
  if (parent.settings.system || child.settings.system) return 'This chat belongs to the app and stays where it is.';
  if (parent.settings.parentId) return 'That chat is itself a sub-chat; I put this one under its top chat instead (one level).';
  if (!child.settings.anchorId && childrenOf(s, child.id).some((id) => !s.chats.get(id)?.settings.anchorId)) {
    return 'This chat has sub-chats of its own, so it stays on top (one level).';
  }
  return undefined;
}

/**
 * Places `chatId` under `parentId` (null: back on top). The owner or a member of both chats does it; a thread stays
 * on its message. Returns the updated chat.
 */
export function setParent(s: ChildDeps, chatId: string, parentId: string | null, by: string): Conversation {
  const child = chatOf(s, chatId);
  checkMember(s, chatId, by);
  if (child.settings.anchorId) throw new WorkforceError('conflict', 'A thread stays on its message.', { details: { conversationId: chatId } });
  if (parentId === null) return child.settings.parentId ? s.chats.update(chatId, { settings: { parentId: undefined } }, by) : child;
  const why = parentRefusal(s, child, parentId);
  if (why) throw new WorkforceError(why.endsWith('not found.') ? 'not_found' : 'conflict', why, { details: { conversationId: chatId, parentId } });
  checkMember(s, parentId, by);
  if (child.settings.parentId === parentId) return child;
  return s.chats.update(chatId, { settings: { parentId } }, by);
}

/**
 * After message `message` was deleted: its thread stays reachable as a plain sub-chat – under the message's chat, or
 * beside it when that chat is itself a sub-chat (one level). No thread: nothing happens.
 */
export function keepThreadOf(s: ChildDeps, message: Pick<Message, 'id' | 'conversationId'>): void {
  const threadId = threadOf(s, message.id);
  if (!threadId) return;
  const parentOfChat = s.chats.get(message.conversationId)?.settings.parentId;
  s.chats.update(threadId, { settings: { anchorId: undefined, ...(parentOfChat ? { parentId: parentOfChat } : {}) } }, SYSTEM_ID);
}

/**
 * The thread on message `messageId` (found, or made now: the parent's members, its lead the one who opens it when that
 * is an agent, named after the message). A message in a thread gets no thread of its own – the thread itself answers it.
 */
export function openThread(s: ChildDeps, messageId: string, by: string, title?: string): Conversation {
  const message = s.chats.message(messageId);
  if (!message) throw new WorkforceError('not_found', 'Message not found.', { details: { messageId } });
  const parent = chatOf(s, message.conversationId);
  checkMember(s, parent.id, by);
  if (parent.settings.anchorId) return parent; // already a thread: I answer in it
  if (parent.settings.system) throw new WorkforceError('conflict', 'This chat belongs to the app and has no threads.', { details: { conversationId: parent.id } });
  const found = threadOf(s, messageId);
  if (found) return chatOf(s, found);
  const members = s.chats.members(parent.id).filter((member) => member.leftAt === undefined);
  const agents = members.filter((member) => member.kind === 'agent').map((member) => member.memberId);
  const name = title?.trim() || previewText(message.body, message.attachments ?? [], 60) || 'Thread';
  return s.chats.create({
    title: name,
    agentIds: agents,
    humans: members.some((member) => member.memberId === HUMAN_ID),
    people: members.filter((member) => isPersonId(member.memberId)).map((member) => member.memberId),
    createdBy: by,
    ...(parent.spaceId ? { spaceId: parent.spaceId } : {}),
    ...(agents.includes(by) ? { lead: by } : {}),
    settings: { parentId: parent.id, anchorId: messageId, ...(parent.settings.hiddenFromList ? { hiddenFromList: true } : {}) },
  });
}
