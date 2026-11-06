// Catch-up after time away: which messages are new for the person and where the one "New messages" divider
// goes – derived from the chat's log and the person's read cursor captured before markRead moved it.
// New: after the captured cursor, not silent, not written by the person (the runtime's unread rule). No
// catch-up in agent-only rooms or app-owned chats, when nothing was unread, or once the person wrote since.
// Owns: these rules. Never: reads stores, renders, scrolls or calls the runtime.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';

/** Where a catch-up starts: the person's read cursor just before markRead. */
export interface CatchUpStart { seq: number }

export interface CatchUp {
  /** The divider goes before this message: the first new one loaded. */
  dividerBefore: string;
  count: number;
}

/** The start for a chat summary taken before markRead, or null when there is nothing to catch up on. */
export function captureStart(chat: Pick<ConversationSummary, 'settings' | 'members' | 'unread'>): CatchUpStart | null {
  if (!(chat.unread > 0) || chatSection(chat) !== 'main') return null;
  const human = chat.members.find((member) => member.memberId === HUMAN_ID && !member.leftAt);
  return human ? { seq: human.readSeq } : null;
}

/** New for the person after `after`: not silent and not written by the person. */
export function isNew(message: Message, after: number): boolean {
  return message.seq > after && !message.silent && message.authorId !== HUMAN_ID;
}

export function catchUp(messages: readonly Message[], start: CatchUpStart | null | undefined): CatchUp | null {
  if (!start || messages.some((message) => message.seq > start.seq && message.authorId === HUMAN_ID)) return null;
  const fresh = messages.filter((message) => isNew(message, start.seq));
  return fresh.length ? { dividerBefore: fresh[0].id, count: fresh.length } : null;
}
