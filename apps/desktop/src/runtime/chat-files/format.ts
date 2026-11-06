// The chat folder format (B-050 K8, 'workforce-chat' v1): one folder per chat named
// `<slug>-<id8>` – the slug follows the chat's title (an unnamed 1:1: the other member's name), the
// last 8 characters of the chat id keep the folder findable across renames – holding chat.json (who and what the chat is) and
// messages/YYYY-MM.jsonl (one JSON line per finished message whose createdAt falls in that UTC month,
// ordered by seq; each line starts with its id). Written by the mirror (<data>/chats, mirror.ts) and by
// chats.export (export.ts).
// Owns: names, shapes and the message → line / chat → chat.json mapping (bodies through the vault's
// redaction). Never: file access (write.ts) or database writes.

import { HUMAN_ID } from '../../shared/ids.ts';
import { messageLevel, type Attachment, type Conversation, type Member, type MemberKind, type Message, type MessageKind, type MessageLevel, type ModelTag } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { chatTitleFor, type NameOf } from './names.ts';

export const CHAT_FORMAT = 'workforce-chat';
export const CHAT_FORMAT_VERSION = 1;
export const CHAT_JSON = 'chat.json';
export const MESSAGES_DIR = 'messages';
/** Next to the chat folders of an export: the attached files, named by their sha256. */
export const FILES_DIR = 'files';
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

export interface ChatFileMember {
  id: string;
  kind: MemberKind;
  name: string;
  role: Member['role'];
  joinedAt: number;
  leftAt?: number;
}

export interface ChatFile {
  format: typeof CHAT_FORMAT;
  v: number;
  id: string;
  /** The stored title ('' for an unnamed 1:1); `displayTitle` is what the owner sees. */
  title: string;
  titleNamed: boolean;
  displayTitle: string;
  createdBy: string;
  createdAt: number;
  archivedAt?: number;
  /** B-078: parentId – the chat it sits under, anchorId – the message a thread answers. */
  settings: { direct?: true; hiddenFromList?: true; parentId?: string; anchorId?: string };
  /** Every member, those who left too (`leftAt`). */
  members: ChatFileMember[];
  origin: { deviceId?: string };
}

export interface MessageLine {
  id: string;
  seq: number;
  author: { id: string; kind: Message['authorKind']; name: string };
  kind: MessageKind;
  level: MessageLevel;
  body: string;
  attachments: Attachment[];
  mentions?: string[];
  replyTo?: string;
  taskId?: string;
  /** Absent = 'final'. */
  state?: 'failed' | 'stopped';
  /** importNote: the status line an import posted on its PC ("Imported N messages …"); another import skips it. */
  meta?: { model?: string; modelHint?: ModelTag; status?: { type: string; text: string }; imported?: true; importNote?: true };
  createdAt: number;
  editedAt?: number;
}

/** 'YYYY-MM' of a time (UTC). */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** [start, end) of a 'YYYY-MM' month in ms (UTC). */
export function monthBounds(month: string): [number, number] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return [Date.UTC(year, index, 1), Date.UTC(year, index + 1, 1)];
}

export function isMonthFile(name: string): boolean {
  return MONTH_FILE.test(name);
}

/** The last 8 letters/digits of a chat id (the stable part of its folder name). */
export function idSuffix(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'chat';
}

/** A file-name-safe slug of a title: ASCII letters and digits joined by '-', at most 40 characters. */
export function slugOf(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'chat';
}

export function folderName(title: string, id: string): string {
  return `${slugOf(title)}-${idSuffix(id)}`;
}

/** The folder of a chat: its stored title, else what the owner sees (an unnamed 1:1). */
export function chatFolderName(file: Pick<ChatFile, 'id' | 'title' | 'displayTitle'>): string {
  return folderName(file.title.trim() || file.displayTitle, file.id);
}

/** chat.json of a chat (members with their names; this PC as the origin). */
export function chatFile(s: Pick<RuntimeServices, 'chats' | 'db'> & Partial<Pick<RuntimeServices, 'devices'>>, chat: Conversation, nameOf: NameOf): ChatFile {
  const members = s.chats.members(chat.id);
  const all = [...members, ...leftMembers(s.db, chat.id)];
  let deviceId: string | undefined;
  try { deviceId = s.devices?.self().id; } catch { deviceId = undefined; }
  const file: ChatFile = {
    format: CHAT_FORMAT, v: CHAT_FORMAT_VERSION, id: chat.id, title: chat.title, titleNamed: chat.titleNamed,
    displayTitle: chatTitleFor(chat, members, HUMAN_ID, nameOf), createdBy: chat.createdBy, createdAt: chat.createdAt,
    settings: {
      ...(chat.settings.direct ? { direct: true as const } : {}),
      ...(chat.settings.hiddenFromList ? { hiddenFromList: true as const } : {}),
      ...(chat.settings.parentId ? { parentId: chat.settings.parentId } : {}),
      ...(chat.settings.anchorId ? { anchorId: chat.settings.anchorId } : {}),
    },
    members: all.map((member) => ({
      id: member.memberId, kind: member.kind, name: nameOf(member.memberId), role: member.role, joinedAt: member.joinedAt,
      ...(member.leftAt !== undefined ? { leftAt: member.leftAt } : {}),
    })),
    origin: deviceId ? { deviceId } : {},
  };
  if (chat.archivedAt !== undefined) file.archivedAt = chat.archivedAt;
  return file;
}

/** The members who left (ChatService.members lists the active ones only). */
function leftMembers(db: Db, chatId: string): Member[] {
  return db.all<{ member_id: string; kind: string; role: string; joined_at: number; left_at: number }>(
    'SELECT member_id, kind, role, joined_at, left_at FROM members WHERE conversation_id = ? AND left_at IS NOT NULL ORDER BY joined_at, member_id', [chatId],
  ).map((row): Member => ({
    conversationId: chatId, memberId: row.member_id, kind: row.kind as MemberKind, role: row.role as Member['role'],
    readSeq: 0, joinedAt: Number(row.joined_at), leftAt: Number(row.left_at),
  }));
}

export function chatFileText(file: ChatFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** One message as its line (the id first, so a line is found by `{"id":"…",`). */
export function messageLine(message: Message, nameOf: NameOf, redact: (text: string) => string): MessageLine {
  const line: MessageLine = {
    id: message.id, seq: message.seq,
    author: { id: message.authorId, kind: message.authorKind, name: nameOf(message.authorId) },
    kind: message.kind, level: messageLevel(message), body: redact(message.body), attachments: message.attachments,
    createdAt: message.createdAt,
  };
  if (message.mentions.length) line.mentions = message.mentions;
  if (message.replyTo) line.replyTo = message.replyTo;
  if (message.taskId) line.taskId = message.taskId;
  if (message.state === 'failed' || message.state === 'stopped') line.state = message.state;
  const meta: NonNullable<MessageLine['meta']> = {};
  if (typeof message.meta.model === 'string') meta.model = message.meta.model;
  if (message.meta.modelHint) meta.modelHint = message.meta.modelHint;
  if (message.meta.status) meta.status = { type: message.meta.status.type, text: redact(message.meta.status.text) };
  if (message.meta.imported === true) meta.imported = true;
  if (isImportNote(message)) meta.importNote = true;
  if (Object.keys(meta).length) line.meta = meta;
  if (message.editedAt !== undefined) line.editedAt = message.editedAt;
  return line;
}

/** The status line an earlier chats.import posted (a note with details.imported). */
export function isImportNote(message: Pick<Message, 'kind' | 'authorKind' | 'meta'>): boolean {
  return message.kind === 'status' && message.authorKind === 'system' && message.meta.status?.type === 'note' && typeof message.meta.status.details?.imported === 'number';
}

/** The text that finds a message's line in a shard. */
export function lineNeedle(messageId: string): string {
  return `{"id":${JSON.stringify(messageId)},`;
}
