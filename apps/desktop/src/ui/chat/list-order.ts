// The chat list's order (ChatList.tsx, each section): pinned first, then by the last message (a chat
// without one by its creation), newest first. B-050 K1, Nachtrag Runde 4: the owner's default 1:1 with every
// agent exists from the hire on (runtime/chat/direct.ts keepOwnerDirects), so one that is still empty waits
// below every chat with a line – newest first, then by name – instead of pushing real conversations down
// (the start-up backfill makes many at once; agents may hire sub-agents). It moves up with its first line.
// The other lists of chats by activity – an agent page's Chats and Team chats (ui/team/model.ts) and the
// New task chat picker (ui/tasks/CreateTask.tsx) – use the same rule without the pins (`byActivity`).
// B-078: nestChats puts sub-chats under their parent (one level) and leaves threads out.
// Owns: that order and nesting. Never: reads the store, decides sections (archive.ts) or names chats (lib/chat-face.tsx).

import type { ConversationSummary } from '../../shared/model/chat.ts';

type Active = Pick<ConversationSummary, 'settings' | 'lastMessageAt' | 'createdAt'>;
type Ordered = Active & Pick<ConversationSummary, 'pinned'>;

/** A default 1:1 nobody has written in yet. */
export function emptyDirect(chat: Pick<ConversationSummary, 'settings' | 'lastMessageAt'>): boolean {
  return chat.settings.direct === true && chat.lastMessageAt === undefined;
}

/** Sort comparator: chats with a line by their last one (else their creation), newest first; empty default 1:1s after them. */
export function byActivity(a: Active, b: Active): number {
  return Number(emptyDirect(a)) - Number(emptyDirect(b))
    || (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt);
}

/** The list in its order; `nameOf` (the name the row shows) settles chats made at the same moment. */
export function orderChats<C extends Ordered>(list: readonly C[], nameOf: (chat: C) => string = () => ''): C[] {
  return list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || byActivity(a, b)
    || nameOf(a).localeCompare(nameOf(b)));
}

/** B-078: one top row of a list section and the sub-chats listed under it (in the section's order). */
export interface ChatNode<C> { chat: C; children: C[] }

type Placed = { id: string; settings: { parentId?: string; anchorId?: string } };

/**
 * B-078: a section's ordered chats as a one-level tree – threads (settings.anchorId) are never rows; a sub-chat goes
 * under its parent when that parent is a top row of the same list, else it stays a top row itself (a parent elsewhere,
 * filtered out by a search, or an older deeper chain), so no chat ever drops out of the list.
 */
export function nestChats<C extends Placed>(ordered: readonly C[]): ChatNode<C>[] {
  const rows = ordered.filter((chat) => !chat.settings.anchorId);
  const ids = new Set(rows.map((chat) => chat.id));
  const under = (chat: C) => chat.settings.parentId !== undefined && chat.settings.parentId !== chat.id && ids.has(chat.settings.parentId);
  const tops = new Set(rows.filter((chat) => !under(chat)).map((chat) => chat.id));
  const nodes = new Map<string, ChatNode<C>>();
  const out: ChatNode<C>[] = [];
  for (const chat of rows) {
    if (under(chat) && tops.has(chat.settings.parentId!)) continue;
    const node = { chat, children: [] as C[] };
    nodes.set(chat.id, node);
    out.push(node);
  }
  for (const chat of rows) if (under(chat) && tops.has(chat.settings.parentId!)) nodes.get(chat.settings.parentId!)!.children.push(chat);
  return out;
}
