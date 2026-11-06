// Inbound side of a Telegram bridge: one Telegram message → one chat message by an external
// member, created through the chat service's public API (setMembers + send).
// Member/author id: 'ext:tg:<sender id>:<name> (Telegram)' – the 'ext:' prefix makes the chat
// service store an 'external' member, and the last segment is the label every renderer shows
// (agents see "<name> (Telegram) (external contact)").
// The text is untrusted: authorKind 'external', never 'human', so it never counts as the owner's
// instruction, consent or approval and never becomes a to-do for the owner.
// C9: the owner's Telegram account (owner-link.ts decides who that is) posts as the human instead – a plain 'text' message with
// meta.via 'bridge' (never an 'answer', a reply to an ask or an approval; fromBridgeOwner) and
// without the sender id: clients see the owner's name only (shared/model/bridges.ts BridgeOwner).
// Owns: sender identity and display names, the body for non-text messages, the dedupe key.
// Never: posts as the human for anyone but the linked owner account, puts the owner's Telegram
// user id into a message, re-adds a contact the owner removed, or downloads media.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { TgChat, TgMessage } from './telegram-api.ts';

export const EXTERNAL_PREFIX = 'ext:tg:';

/** Non-text Telegram content, shown as a short marker (media is not downloaded). */
const MEDIA: Array<[string, string]> = [
  ['photo', 'photo'], ['video', 'video'], ['animation', 'GIF'], ['voice', 'voice message'], ['video_note', 'video message'],
  ['audio', 'audio'], ['document', 'file'], ['sticker', 'sticker'], ['location', 'location'], ['contact', 'contact'], ['poll', 'poll'],
];

export interface Sender {
  key: string; // Telegram user id, or 'c<chat id>' for posts in the name of a chat/channel
  name: string;
}

/** Does a Telegram chat match the linked id ("123", "-100…" or "@channel")? */
export function matchesChat(externalChatId: string, chat: TgChat): boolean {
  if (externalChatId.startsWith('@')) return Boolean(chat.username) && chat.username!.toLowerCase() === externalChatId.slice(1).toLowerCase();
  return String(chat.id) === externalChatId;
}

/** One line, no ':' (ids are split on it), at most 40 characters. */
export function displayName(raw: string | undefined): string {
  const clean = (raw ?? '').replace(/[\u0000-\u001f\u007f:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  return clean || 'Telegram user';
}

/** Who wrote it; undefined for bots (no bot-to-bot loops). */
export function senderOf(message: TgMessage): Sender | undefined {
  const chat = message.sender_chat ?? (message.from ? undefined : message.chat);
  if (chat) return { key: `c${chat.id}`, name: displayName(chat.title ?? chat.username) };
  const from = message.from;
  if (!from || from.is_bot) return undefined;
  return { key: String(from.id), name: displayName([from.first_name, from.last_name].filter(Boolean).join(' ') || from.username) };
}

/** Text or caption, with a marker for media; '' for nothing to show (and the /start handshake). */
export function bodyOf(message: TgMessage): string {
  const text = (message.text ?? message.caption ?? '').trim();
  if (/^\/start(?:@\w+)?(?:\s|$)/.test(text)) return '';
  const media = MEDIA.find(([key]) => message[key] !== undefined)?.[1];
  if (media) return text ? `[${media}] ${text}` : `[${media}]`;
  return text;
}

/** Adds the Telegram message to the linked chat; undefined when nothing was added. */
export function ingest(s: RuntimeServices, bridge: { id: string; conversationId: string }, message: TgMessage): Message | undefined {
  const sender = senderOf(message);
  if (!sender) return undefined;
  const body = bodyOf(message);
  if (!body) return undefined;
  const authorId = memberFor(s, bridge.conversationId, sender);
  if (!authorId) return undefined;
  return s.chats.send({
    conversationId: bridge.conversationId,
    body,
    authorId,
    authorKind: 'external',
    meta: { via: 'bridge', bridge: { ...bridgeMeta(bridge.id, message), senderId: sender.key } },
    // Redelivered updates (cursor not yet stored before a crash) map to the same message.
    clientId: dedupeKey(bridge.id, message),
  });
}

/** Is the sender the owner's linked Telegram account? (A user, never a bot or a chat/channel.) */
export function isOwnerSender(message: TgMessage, ownerUserId: string | undefined): boolean {
  if (!ownerUserId || message.sender_chat || !message.from || message.from.is_bot) return false;
  return String(message.from.id) === ownerUserId;
}

/** C9: the linked owner's message, posted as the human – a plain text message, never an answer. */
export function ingestOwner(s: RuntimeServices, bridge: { id: string; conversationId: string }, message: TgMessage): Message | undefined {
  const sender = senderOf(message);
  const body = bodyOf(message);
  if (!sender || !body) return undefined;
  return s.chats.send({
    conversationId: bridge.conversationId,
    body,
    authorId: HUMAN_ID,
    authorKind: 'human',
    kind: 'text',
    meta: { via: 'bridge', bridge: { ...bridgeMeta(bridge.id, message), owner: true } }, // no senderId: it stays in the runtime
    clientId: dedupeKey(bridge.id, message),
  });
}

function bridgeMeta(id: string, message: TgMessage): Record<string, unknown> {
  return { id, kind: 'telegram', chatId: String(message.chat.id), messageId: message.message_id };
}

function dedupeKey(bridgeId: string, message: TgMessage): string {
  return `tg:${bridgeId}:${message.chat.id}:${message.message_id}`;
}

/** The sender's member id in the chat (joins on the first message); undefined when removed. */
function memberFor(s: RuntimeServices, conversationId: string, sender: Sender): string | undefined {
  const prefix = `${EXTERNAL_PREFIX}${sender.key}:`;
  const active = s.chats.members(conversationId).find((member) => member.memberId.startsWith(prefix));
  if (active) return active.memberId; // keeps the first name seen, so a rename is not a new member
  const removed = s.db.get(
    'SELECT 1 AS hit FROM members WHERE conversation_id = ? AND substr(member_id, 1, ?) = ? AND left_at IS NOT NULL LIMIT 1',
    [conversationId, prefix.length, prefix],
  );
  if (removed) return undefined; // the owner removed this contact: their messages stay out
  const memberId = `${prefix}${sender.name} (Telegram)`;
  s.chats.setMembers(conversationId, { add: [memberId] }, SYSTEM_ID);
  return memberId;
}
