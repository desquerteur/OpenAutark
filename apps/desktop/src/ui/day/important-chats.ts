// My day › "Chats that matter", pure: the 3–5 chats where something real happens now, ranked from what the window already
// holds (store.conversations, the person's open to-dos) – no runtime method, no message bodies beyond the chat list's own
// preview. The signals, their order, which to-dos wait on the person and which chats may rank at all are the one rule the
// morning briefing uses too (shared/model/chat-rank.ts): waits > important unread > unread (not muted) > an agent working >
// the person wrote there in the last 24 h, newer activity first within a signal. The chats the morning briefing picked come
// first, in its order, while they still have a live signal – with the live reason (the briefing's reasons are counts from
// the morning and go stale during the day). At most 5 rows; beyond the first 3 only strong ones (picked, waiting, unread).
// Owns: these rows and reasons (unit-tested in test/unit/day-ui/important-chats.test.ts). Never: imports the store, rpc or
// the DOM – callers pass data and the time in.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { CHAT_SIGNAL_SCORE, chatSignal, compareRanked, rankable, waitingByChat, type ChatSignal, type RankedChatInput } from '../../shared/model/chat-rank.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

/** Always up to this many rows (any signal) … */
const CHATS_MIN = 3;
/** … and up to this many when the rest are strong. */
export const CHATS_MAX = 5;

/** What it reads of the person's open to-dos (store.todos). */
export type WaitingTodo = Pick<TaskView, 'id' | 'title' | 'conversationId' | 'createdBy' | 'createdAt' | 'assigneeKind' | 'status' | 'waitingOn' | 'widget' | 'dueAt'>;

export interface ImportantChat<C, T> {
  chat: C;
  signal: ChatSignal;
  /** The one-line reason ("Waits for you: …", "Mara is working"); undefined: show the chat's last message. */
  reason?: string;
  /** The oldest to-do waiting on the person there (signal 'waits'). */
  todo?: T;
  /** The morning briefing picked it. */
  picked: boolean;
}

export interface ImportantChatsInput<T> {
  /** The person's open to-dos (store.todos). */
  todos: readonly T[];
  /** The chats today's briefing picked, in its order (Briefing.chats). */
  briefing?: ReadonlyArray<{ conversationId: string }>;
  now: number;
  /** The end of today in the day's zone (lib/day-store.ts dayRange): a to-do due later waits under "Later", not on the person now. */
  dayEnd?: number;
  /** An agent's (or person's) display name. */
  nameOf: (id: string) => string;
  /** Who works in a chat, in the chat header's live line order (chat/live-text.ts workingIds); default the summary's list. */
  workingOf?: (chat: Pick<ConversationSummary, 'id' | 'working'>) => readonly string[];
}

/** The chat's strongest live signal and its reason, or undefined when nothing happens there. */
function signalOf<C extends RankedChatInput, T extends WaitingTodo>(chat: C, waiting: readonly T[] | undefined, input: ImportantChatsInput<T>): Omit<ImportantChat<C, T>, 'picked'> | undefined {
  const signal = chatSignal(chat, waiting?.length ?? 0, input.now);
  if (signal === 'waits' && waiting?.length) {
    const reason = waiting.length === 1 ? `Waits for you: ${waiting[0].title}` : `${waiting.length} things wait for you`;
    return { chat, signal, reason, todo: waiting[0] };
  }
  if (signal === 'working') {
    const working = (input.workingOf?.(chat) ?? chat.working).filter((id) => id !== HUMAN_ID);
    const name = input.nameOf(working[0]);
    return { chat, signal, reason: working.length === 1 ? `${name} is working` : `${name} and ${working.length - 1} more are working` };
  }
  return signal ? { chat, signal } : undefined;
}

const strong = (row: { signal: ChatSignal; picked: boolean }): boolean => row.picked || CHAT_SIGNAL_SCORE[row.signal] >= CHAT_SIGNAL_SCORE.unread;

/** The chats that matter, best first (see the header). */
export function importantChats<C extends RankedChatInput, T extends WaitingTodo>(chats: readonly C[], input: ImportantChatsInput<T>): Array<ImportantChat<C, T>> {
  const waiting = waitingByChat(input.todos, input.now, input.dayEnd);
  const live = new Map<string, Omit<ImportantChat<C, T>, 'picked'>>();
  for (const chat of chats) {
    if (!rankable(chat)) continue;
    const entry = signalOf(chat, waiting.get(chat.id), input);
    if (entry) live.set(chat.id, entry);
  }
  const picked: Array<ImportantChat<C, T>> = [];
  for (const { conversationId } of input.briefing ?? []) {
    const entry = live.get(conversationId);
    if (!entry) continue; // gone, hidden, or nothing happens there any more
    picked.push({ ...entry, picked: true });
    live.delete(conversationId);
  }
  const rest = [...live.values()].sort(compareRanked).map((entry): ImportantChat<C, T> => ({ ...entry, picked: false }));
  return [...picked, ...rest].filter((row, index) => index < CHATS_MIN || strong(row)).slice(0, CHATS_MAX);
}
