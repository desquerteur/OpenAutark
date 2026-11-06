// "Chats that matter" (B-041 §6.4) – one pure ranking for the morning briefing (runtime/day/briefing-chats.ts).
// One signal per chat, the strongest wins:
//   waits     – someone else (an agent, the host, a colleague) waits on the person there: an open to-do they
//               raised that needs the person now (todo-later.ts needsYou – never a "Later" one or a timer that
//               has not rung);
//   important – important messages unread (ConversationSummary.importantUnread);
//   unread    – unread messages, unless the chat is muted;
//   working   – an agent is working there right now;
//   recent    – the person wrote there in the last 24 h.
// Newer activity first within a signal (the last message's time). Only chats the person reads in the main list
// rank: never app chats (To-do, Inbox, Customize), hidden or agent-only rooms, archived chats, or chats the owner is
// no active member of.
// Owns: these rules. Never: message text, a clock, the store or the database – callers pass data and the time in.

import { HUMAN_ID } from '../ids.ts';
import { chatSection } from '../text/chat-sections.ts';
import type { ConversationSettings, ConversationSummary, Member } from './chat.ts';
import { isPersonId } from './people.ts';
import type { Task } from './tasks.ts';
import { needsYou } from './todo-later.ts';

const DAY_MS = 24 * 60 * 60_000;

export type ChatSignal = 'waits' | 'important' | 'unread' | 'working' | 'recent';
export const CHAT_SIGNAL_SCORE: Readonly<Record<ChatSignal, number>> = { waits: 5, important: 4, unread: 3, working: 2, recent: 1 };

/** What the ranking reads of a chat. */
export type RankedChatInput = Pick<ConversationSummary, 'id' | 'members' | 'settings' | 'unread' | 'lastPreview' | 'working' | 'lastMessageAt' | 'updatedAt' | 'archivedAt'>
  & { importantUnread?: number };

/** What it reads of the person's open to-dos. */
export type WaitingTodo = Pick<Task, 'id' | 'conversationId' | 'createdBy' | 'createdAt' | 'assigneeKind' | 'status' | 'waitingOn' | 'widget' | 'dueAt'>;

/** The people's own chat: the owner is not an active member, and people hold it now or held it so (settings.peopleChat). */
export function peoplesOwnChat(members: ReadonlyArray<Pick<Member, 'memberId' | 'leftAt'>>, settings?: Pick<ConversationSettings, 'peopleChat'>): boolean {
  const active = members.filter((member) => member.leftAt === undefined || member.leftAt === null);
  if (active.some((member) => member.memberId === HUMAN_ID)) return false;
  return settings?.peopleChat === true || active.some((member) => isPersonId(member.memberId));
}

/** May the chat rank at all (see the header)? */
export function rankable(chat: Pick<ConversationSummary, 'members' | 'settings' | 'archivedAt'>): boolean {
  return chat.archivedAt === undefined && chatSection(chat) === 'main' && !peoplesOwnChat(chat.members, chat.settings);
}

/** An open to-do someone else raised that waits on the person now. */
export function waitsOnPerson(todo: WaitingTodo, now: number, dayEnd?: number): boolean {
  return todo.assigneeKind === 'human' && todo.createdBy !== HUMAN_ID && needsYou(todo, now, dayEnd);
}

/** The to-dos waiting on the person now, per chat, oldest first. */
export function waitingByChat<T extends WaitingTodo>(todos: readonly T[], now: number, dayEnd?: number): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const todo of todos) {
    if (!todo.conversationId || !waitsOnPerson(todo, now, dayEnd)) continue;
    const list = out.get(todo.conversationId);
    if (list) list.push(todo); else out.set(todo.conversationId, [todo]);
  }
  for (const list of out.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

/** The chat's strongest live signal (`waits`: to-dos waiting on the person there), or undefined when nothing happens there. */
export function chatSignal(chat: RankedChatInput, waits: number, now: number): ChatSignal | undefined {
  if (waits > 0) return 'waits';
  if ((chat.importantUnread ?? 0) > 0) return 'important';
  if (chat.unread > 0 && chat.settings.notifications !== 'off') return 'unread';
  if (chat.working.some((id) => id !== HUMAN_ID)) return 'working';
  const preview = chat.lastPreview;
  return preview && preview.authorId === HUMAN_ID && now - preview.at <= DAY_MS ? 'recent' : undefined;
}

/** When something last happened in the chat. */
export function activityAt(chat: Pick<ConversationSummary, 'lastPreview' | 'lastMessageAt' | 'updatedAt'>): number {
  return chat.lastPreview?.at ?? chat.lastMessageAt ?? chat.updatedAt;
}

/** Best first: the stronger signal, then newer activity, then the id (stable). */
export function compareRanked(a: { signal: ChatSignal; chat: RankedChatInput }, b: { signal: ChatSignal; chat: RankedChatInput }): number {
  return CHAT_SIGNAL_SCORE[b.signal] - CHAT_SIGNAL_SCORE[a.signal] || activityAt(b.chat) - activityAt(a.chat) || a.chat.id.localeCompare(b.chat.id);
}
