// Navigation helpers shared by every task surface: jump to the anchor message of a task in its
// chat (paging older history in, bounded, when the message is not loaded yet), open and close a
// task in Work's detail – the selection is the route's ?task= (B-041: Back closes the detail, a
// sidebar click clears it) – and Work's clock, the time its groups are read at.
// Owns: the selection rules of Work's detail, the jump flow and the Work clock (one re-armable
// timeout to the next moment a group changes by time alone – work-model.ts nextWorkChange; never
// polling). Never: copies tasks – the overview always returns to the original chat and message –
// or opens an anchor chat (the old To-do chat, the old Inbox) as a chat. B-054: a task without a
// chat (made in the To-do area, by a mail run, a routine …) always opens the detail.

import { computed, effect, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { SystemChat } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { back, formatRoute, navigate } from '../lib/router.ts';
import { focusMessage } from '../lib/shell-state.ts';
import { activeConversationId, conversationMap, historyComplete, loadOlder, messagesFor, route, tasks } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { doneTasks } from './done-store.ts';
import { DAY_MS } from './todo-model.ts';
import { nextWorkChange, withTask } from './work-model.ts';

/** The task shown in Work's detail (main area or right drawer): the route's ?task=. */
export const selectedTaskId = computed<string | null>(() => {
  const current = route.value;
  return current.view === 'tasks' ? current.task ?? null : null;
});

/** The detail entry selectTask pushed onto Work's list (a switch of task replaces it): closing it there goes back. */
let pushed: string | null = null;

/**
 * Opens a task in Work's detail. From Work's list it is a new history entry (Back closes the
 * detail); a switch to another task replaces it; from elsewhere Work opens with the task (the view
 * and owner filter kept when Work is already open).
 */
export function selectTask(taskId: string): void {
  const current = route.peek();
  if (current.view !== 'tasks') {
    pushed = null;
    navigate({ view: 'tasks', task: taskId });
    return;
  }
  if (current.task === taskId) return;
  const next = withTask(current, taskId);
  const switched = !!current.task;
  if (switched && pushed !== formatRoute(current)) pushed = null; // not the entry pushed here: it stays as it is
  else pushed = formatRoute(next);
  navigate(next, { replace: switched });
}

/** Closes Work's detail: back to the list it was opened from, else the same view without a selection. */
export function closeTask(): void {
  const current = route.peek();
  if (current.view !== 'tasks' || !current.task) return;
  const here = formatRoute(current);
  const wasPushed = pushed === here;
  pushed = null;
  if (wasPushed) back();
  else navigate(withTask(current), { replace: true });
}

// ------------------------------------------------------------------ the Work clock

/** The time Work's groups (a wait turning stuck) and its folded Done are read at. */
export const workClock = signal(Date.now());

/** setTimeout's longest reliable delay is ~24.8 days; the clock re-arms after a day at most. */
const MAX_CLOCK_DELAY = DAY_MS;
let clockTimer: ReturnType<typeof setTimeout> | undefined;

/** Re-arms the one timeout for the moment `at` (none: no change ahead); it moves the clock to then. */
export function armWorkClock(at: number | undefined): void {
  clearTimeout(clockTimer);
  clockTimer = undefined;
  if (at === undefined) return;
  clockTimer = setTimeout(() => { clockTimer = undefined; workClock.value = Date.now(); }, Math.min(Math.max(0, at - Date.now()), MAX_CLOCK_DELAY));
}

/** The Work clock for a view: re-armed whenever the open or finished tasks change. */
export function useWorkClock(): number {
  const now = workClock.value;
  const open = tasks.value;
  const done = doneTasks.value;
  useEffect(() => armWorkClock(nextWorkChange(open, done, now)), [open, done, now]);
  return now;
}

// ------------------------------------------------------------------ jumping to the chat

const MAX_PAGES = 15;
const LOAD_WAIT_MS = 8000;

/** Resolves on the next change of a signal (or after the timeout). No polling. */
function nextChange<T>(source: Signal<T>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const initial = source.peek();
    let done = false;
    let dispose: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => dispose?.());
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    dispose = effect(() => { if (source.value !== initial) finish(); });
  });
}

/**
 * App-owned anchor chats that held task records before B-054 (the To-do chat, the task center's
 * Inbox): inert rows with old messages only (receipts, approval history); the person never opens
 * them as a chat – also after an event or a lookup put the hidden chat into the store.
 */
const ANCHOR_CHATS: ReadonlySet<SystemChat> = new Set<SystemChat>(['todo', 'inbox']);

/** True when the chat is visible to the human (no chat, hidden agent-only chats, the old To-do chat and Inbox cannot be opened). */
export function canOpenChat(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const chat = conversationMap.value.get(conversationId);
  return chat !== undefined && !(chat.settings.system !== undefined && ANCHOR_CHATS.has(chat.settings.system));
}

/** Opens the chat and scrolls to (and highlights) one message. */
export async function jumpToMessage(conversationId: string, messageId: string): Promise<void> {
  const list = messagesFor(conversationId);
  const wasOpen = activeConversationId.peek() === conversationId;
  focusMessage.value = { conversationId, messageId };
  if (!wasOpen) {
    const loaded = nextChange(list, LOAD_WAIT_MS); // ChatView loads the newest page on open
    navigate({ view: 'chat', id: conversationId });
    await loaded;
  }
  // Older than the loaded page: page back (bounded) – MessageList scrolls once it is there.
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (list.peek().some((message) => message.id === messageId)) return;
      if (historyComplete.has(conversationId) || activeConversationId.peek() !== conversationId) break;
      if (!(await loadOlder(conversationId))) break;
    }
  } catch (error) {
    toastError(error, 'Messages could not be loaded');
  }
  if (!list.peek().some((message) => message.id === messageId) && focusMessage.peek()?.messageId === messageId) focusMessage.value = null;
}

/** "Open in chat" for a task: its anchor message, else just the chat. */
export function openTaskInChat(task: Pick<TaskView, 'conversationId' | 'messageId'>): void {
  const chatId = task.conversationId;
  if (!chatId || !canOpenChat(chatId)) return;
  if (task.messageId) void jumpToMessage(chatId, task.messageId);
  else navigate({ view: 'chat', id: chatId });
}

/** Shows a task in Work's detail (keeps the view and owner filter when already there). */
export function openTaskDetail(taskId: string): void {
  selectTask(taskId);
}

/**
 * Row click on an overview (Home, follow-up chips, a chat's task card): the original message in
 * its chat; tasks without a chat or in chats the human cannot open (agent-only rooms) open the
 * detail.
 */
export function openTask(task: Pick<TaskView, 'id' | 'conversationId' | 'messageId'>): void {
  if (canOpenChat(task.conversationId)) openTaskInChat(task);
  else openTaskDetail(task.id);
}
