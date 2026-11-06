// What can be done with a whole chat – the right-click menu of a chat row and of the chat header's title
// (lib/context-menu.tsx): Open, Pin/Unpin, Mark read, Mute/Unmute, Rename, Change image, Export, Leave
// (a person's device), Archive/Unarchive, Delete. Entries this connection may not call are left out. B-078: Put under…
// (a second menu at the same spot lists the chats of its list section it can go under) and Top level for a sub-chat.
// Owns: these entries and their handlers. Never: renders a menu itself.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { askText, confirm, type MenuItem, type MenuSection } from '../lib/ui.tsx';
import { uploadFile } from '../lib/files.ts';
import { navigate } from '../lib/router.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { isPersonSession } from '../lib/people.ts';
import { activeConversationId, conversations, messages, removeById } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { openPath } from '../blocks/host.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { archiveNote, listSection } from './archive.ts';
import { openContextMenu } from '../lib/context-menu.tsx';
import { orderChats } from './list-order.ts';
import { leaveChat, leaveShown, type LeaveEnv } from './leave.ts';

type Patch = { title?: string; pinned?: boolean; settings?: Partial<ConversationSummary['settings']> };

async function update(chat: ConversationSummary, patch: Patch, failTitle = 'Could not save'): Promise<void> {
  try { await rpc.call('chats.update', { id: chat.id, ...patch }); } catch (error) { toastError(error, failTitle); }
}

/** Leaves the open chat for Home when it is the one that went away. */
function away(id: string): void {
  if (activeConversationId.peek() === id) navigate({ view: 'home' });
}

async function rename(chat: ConversationSummary): Promise<void> {
  const title = await askText({ title: 'Rename chat', label: 'Chat name', value: chatTitle(chat) });
  if (title && title !== chat.title) await update(chat, { title }, 'Could not rename');
}

function changeImage(chat: ConversationSummary): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const ref = await uploadFile(file);
      await update(chat, { settings: { image: ref.fileId } }, 'Could not change the image');
    } catch (error) { toastError(error, 'Could not change the image'); }
  };
  input.click();
}

/** Writes this chat's folder (chats.export) and opens it where this connection may; its path in a notice either way. */
async function exportChat(chat: ConversationSummary): Promise<void> {
  try {
    const result = await rpc.call('chats.export', { conversationIds: [chat.id] });
    pushToast({ title: 'Chat exported', body: result.dir }, 10_000);
    if (can('files.openPath')) await openPath(result.dir).catch(() => undefined);
  } catch (error) { toastError(error, 'Could not export'); }
}

async function archive(chat: ConversationSummary): Promise<void> {
  if (!await confirm({ title: 'Archive chat?', body: archiveNote(chat.openTasks), confirmLabel: 'Archive' })) return;
  try { await rpc.call('chats.archive', { id: chat.id }); away(chat.id); } catch (error) { toastError(error, 'Could not archive'); }
}

async function remove(chat: ConversationSummary): Promise<void> {
  if (!await confirm({ title: 'Delete chat?', body: 'Its messages and tasks are deleted for good.', confirmLabel: 'Delete', danger: true })) return;
  try { await rpc.call('chats.delete', { id: chat.id }); away(chat.id); } catch (error) { toastError(error, 'Could not delete'); }
}

/** Where the last right-click or press was – the spot "Put under…" opens its list of chats at. */
let spot = { x: 0, y: 0 };
if (typeof document !== 'undefined') {
  const keep = (event: MouseEvent) => { spot = { x: event.clientX, y: event.clientY }; };
  document.addEventListener('contextmenu', keep, true);
  document.addEventListener('pointerdown', keep, true);
}

/** B-078: the chats `chat` can go under – every top chat of its list section, not threads, not itself, without a parent. */
export function parentChoices(chat: ConversationSummary, all: readonly ConversationSummary[]): ConversationSummary[] {
  const section = listSection(chat);
  if (!section || chat.settings.anchorId || all.some((other) => other.settings.parentId === chat.id && !other.settings.anchorId)) return [];
  return orderChats(all.filter((other) => other.id !== chat.id && !other.settings.parentId && !other.settings.anchorId && listSection(other) === section), chatTitle);
}

/** How many of the most active parents come first in "Put under"; every other one follows A–Z (the menu scrolls). */
export const RECENT_PARENTS = 8;

async function setParent(chat: ConversationSummary, parentId: string | null): Promise<void> {
  try {
    await rpc.call('chats.update', { id: chat.id, settings: { parentId } as unknown as Partial<ConversationSummary['settings']> }); // null: back on top
  } catch (error) { toastError(error, 'Could not move the chat'); }
}

/** Put under…: a second menu at the same spot with the chats it can go under. */
function putUnder(chat: ConversationSummary): void {
  const choices = parentChoices(chat, conversations.peek());
  const { x, y } = spot;
  const item = (parent: ConversationSummary) => ({ label: chatTitle(parent), onSelect: () => void setParent(chat, parent.id) });
  const rest = choices.slice(RECENT_PARENTS).sort((a, b) => chatTitle(a).localeCompare(chatTitle(b)));
  setTimeout(() => openContextMenu(x, y, [
    { title: 'Put under', items: choices.slice(0, RECENT_PARENTS).map(item) },
    { title: 'All chats', items: rest.map(item) }, // an empty section is left out (context-menu.tsx)
  ]), 0);
}

/** A person leaving from her own app: the chat leaves her lists at once. */
const leaveEnv: LeaveEnv = {
  confirm,
  leave: (params) => rpc.call('chats.members', params),
  left: (id) => { removeById(conversations, id); messages.delete(id); away(id); },
  failed: (error) => toastError(error, 'Could not leave the chat'),
};

/** The chat's menu; `open` adds "Open" first (the chat row). */
export function chatMenu(chat: ConversationSummary, options: { open?: boolean } = {}): MenuSection[] {
  const editable = can('chats.update');
  const muted = chat.settings.notifications === 'off';
  const archived = chat.archivedAt !== undefined;
  const first: MenuItem[] = [
    ...(options.open ? [{ label: 'Open', onSelect: () => navigate({ view: 'chat', id: chat.id }) }] : []),
    ...(editable ? [{ label: chat.pinned ? 'Unpin' : 'Pin', onSelect: () => void update(chat, { pinned: !chat.pinned }) }] : []),
    ...(chat.unread > 0 ? [{ label: 'Mark read', onSelect: () => void rpc.call('chats.markRead', { id: chat.id, seq: chat.lastSeq }).catch((error: unknown) => toastError(error)) }] : []),
    ...(editable ? [{ label: muted ? 'Unmute' : 'Mute', onSelect: () => void update(chat, { settings: { notifications: muted ? 'default' : 'off' } }) }] : []),
  ];
  const edit: MenuItem[] = editable ? [
    ...(chat.settings.direct ? [] : [{ label: 'Rename…', onSelect: () => void rename(chat) }]), // the default 1:1 is named after the other member
    ...(chat.settings.direct ? [] : [{ label: 'Change image…', onSelect: () => changeImage(chat) }]),
    ...(chat.settings.parentId && !chat.settings.anchorId ? [{ label: 'Top level', onSelect: () => void setParent(chat, null) }]
      : parentChoices(chat, conversations.peek()).length ? [{ label: 'Put under…', onSelect: () => putUnder(chat) }] : []),
  ] : [];
  const last: MenuItem[] = [
    ...(can('chats.export') ? [{ label: 'Export', onSelect: () => void exportChat(chat) }] : []),
    ...(leaveShown(chat, isPersonSession(), can('chats.members')) ? [{ label: 'Leave', danger: true, onSelect: () => void leaveChat(chat.id, leaveEnv) }] : []),
    ...(can(archived ? 'chats.unarchive' : 'chats.archive')
      ? [{ label: archived ? 'Unarchive' : 'Archive', onSelect: () => void (archived ? rpc.call('chats.unarchive', { id: chat.id }).catch((error: unknown) => toastError(error, 'Could not unarchive')) : archive(chat)) }]
      : []),
    ...(can('chats.delete') ? [{ label: 'Delete', danger: true, onSelect: () => void remove(chat) }] : []),
  ];
  return [{ items: first }, { items: edit }, { items: last }];
}
