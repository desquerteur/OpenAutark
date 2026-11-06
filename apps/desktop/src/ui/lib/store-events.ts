// Event wiring: applies runtime deltas to the store signals and keeps the subscription set
// in sync with the open chat. Called once from main.tsx.
// Owns: event → signal mapping, the `chat:<id>` topic lifecycle, the one start notice (RC1), when a toast is
// seen already (its chat or My day open), the For-you clock's timing (F04); My day's calendar, briefing and
// handed-off events are applied by lib/day-store.ts (wireDay, called here). B-075: a run's streaming answer arrives as
// updates of its row (message.updated: body and live values), like any message – no event of its own; agent.activity
// still feeds `activity` for Team, tasks and the work stop.
// Never: fetches big snapshots on every event (only on reconnect, see store.loadAll).

import { effect } from '@preact/signals';
import type { TaskView } from '../../shared/model/tasks.ts';
import { rpc } from './rpc.ts';
import {
  accounts, activeConversationId, activity, agents, archivedAgents, conversations, loadAll, messages, models, putMessage,
  removeById, route, settings, systemInfo, tasks, todoClock, todos, updateState, upsertById, usage,
} from './store.ts';
import { nextListChange, onForYouList } from '../tasks/todo-time.ts';
import type { Topic } from '../../shared/api/protocol.ts';
import { dismissToastsWhere, pushToast, toastNotification } from './toasts.ts';
import { wirePeople } from './people.ts';
import { wireDay } from './day-store.ts';
import { wireSplits } from '../splits/split-model.ts';

/** A start notice older than this is not news any more (a window opened much later). */
const NOTICE_FRESH_MS = 6 * 60 * 60_000;
const NOTICE_KEY = 'wf.startNotice';

/** The id of the start notice this browser/window already showed (survives reloads). */
function shownNotice(): string | null {
  try { return localStorage.getItem(NOTICE_KEY); } catch { return null; }
}

function rememberNotice(id: string): void {
  try { localStorage.setItem(NOTICE_KEY, id); } catch { /* storage blocked: shown again after a reload */ }
}

/** The person is where a toast's Open leads (shell/StatusLine.tsx): its chat, or My day for a to-do outside a chat. */
function atToastTarget(item: { conversationId?: string; taskId?: string }): boolean {
  const at = route.peek();
  return at.view === 'chat' ? item.conversationId === at.id : at.view === 'day' && !item.conversationId && item.taskId !== undefined;
}

/**
 * On the For-you list – the same rule as the runtime's todos.list (tasks/repo.ts todos): human
 * to-dos and human steps that are open, need the person or are in progress, and those waiting
 * for a ring (snoozed, or a repeating timer until its next time), which the list keeps under
 * "Later" (F04, tasks/todo-time.ts onForYouList); any other wait leaves it.
 */
function isOpenTodo(task: TaskView): boolean {
  return onForYouList(task);
}

/** setTimeout's longest reliable delay is ~24.8 days; the clock re-arms after a day at most. */
const MAX_CLOCK_DELAY = 86_400_000;

/**
 * F04: moves the For-you clock (store.todoClock) whenever the to-dos change and at the next
 * moment a row reads differently by time alone – a timer leaving "Later", a countdown minute,
 * "2 minutes ago" moving on, a due time passing, "Tomorrow" at midnight (tasks/todo-time.ts
 * nextListChange). One timeout to that moment, never an interval.
 */
function wireTodoClock(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    todoClock.value = now;
    const next = nextListChange(todos.peek(), now);
    if (next !== undefined) timer = setTimeout(tick, Math.min(next - now + 25, MAX_CLOCK_DELAY));
  };
  effect(() => {
    void todos.value; // re-read at every change of the list
    tick();
  });
}

export function wireEvents(): void {
  rpc.subscribe(['chats', 'tasks', 'org', 'providers', 'system']);
  rpc.onOpen(() => { void loadAll(); });

  // chats / messages
  rpc.on('conversation.upserted', (chat) => upsertById(conversations, chat));
  rpc.on('conversation.removed', ({ id }) => { removeById(conversations, id); messages.delete(id); });
  rpc.on('message.created', putMessage);
  rpc.on('message.updated', putMessage);
  rpc.on('message.removed', ({ id, conversationId }) => {
    const list = messages.get(conversationId);
    if (list) list.value = list.value.filter((message) => message.id !== id);
  });

  // tasks
  rpc.on('task.upserted', (task) => {
    if (task.status === 'done' || task.status === 'cancelled') {
      removeById(tasks, task.id);
      dismissToastsWhere((toast) => toast.taskId === task.id); // answered elsewhere (phone, an agent): its toast goes
    } else upsertById(tasks, task);
    if (isOpenTodo(task)) upsertById(todos, task);
    else removeById(todos, task.id);
  });
  rpc.on('task.removed', ({ id }) => { removeById(tasks, id); removeById(todos, id); dismissToastsWhere((toast) => toast.taskId === id); });
  wireDay(); // B-041: calendar.upserted/removed, day.briefing, handed-off work, the day clock

  // org
  rpc.on('agent.upserted', (agent) => { upsertById(agents, agent); if (agent.archivedAt !== undefined) upsertById(archivedAgents, agent); else removeById(archivedAgents, agent.id); });
  rpc.on('agent.removed', ({ id }) => { removeById(agents, id); removeById(archivedAgents, id); });
  rpc.on('agent.activity', ({ active }) => { activity.value = active; });
  wirePeople(); // F-52: person.upserted
  wireSplits(); // B-057: split.upserted, and an agent's groups read again when its split runs start or end

  // providers
  rpc.on('account.upserted', (account) => upsertById(accounts, account));
  rpc.on('account.removed', ({ id }) => removeById(accounts, id));
  rpc.on('usage.updated', (list) => { usage.value = list; });
  rpc.on('models.updated', (list) => { models.value = list; });

  // system
  rpc.on('settings.updated', (value) => { settings.value = value; });
  rpc.on('update.state', (state) => { updateState.value = state; });
  rpc.on('notify', (note) => {
    // OS notifications and their sound are main's job; in-window we show a toast for what matters (a to-do, a
    // blocker or an important message stays until Open or Dismiss, see below). The
    // runtime's `toast` flag follows the chat's notification level (C3); older runtimes send none.
    if (!(note.toast ?? (note.kind !== 'info' && note.kind !== 'reply'))) return;
    if (atToastTarget(note) && document.hasFocus()) return; // the person sees it already
    toastNotification(note);
  });

  // RC1: the start notice ("Updated to X · N tasks continued") once per start, also after a reload.
  effect(() => {
    const notice = systemInfo.value?.notice;
    if (!notice || Date.now() - notice.at > NOTICE_FRESH_MS || shownNotice() === notice.id) return;
    rememberNotice(notice.id);
    pushToast({ title: notice.text });
  });

  // Keep exactly the open chat's topic subscribed.
  let current: Topic | null = null;
  effect(() => {
    const id = activeConversationId.value;
    const next: Topic | null = id ? `chat:${id}` : null;
    if (next === current) return;
    if (current) rpc.unsubscribe([current]);
    if (next) rpc.subscribe([next]);
    current = next;
  });

  // A toast goes once the person is where its Open leads, also when the window comes back to that view.
  effect(() => { void route.value; dismissToastsWhere(atToastTarget); });
  window.addEventListener('focus', () => dismissToastsWhere(atToastTarget));

  wireTodoClock();
}
