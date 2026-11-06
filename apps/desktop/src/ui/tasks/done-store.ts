// Recently finished tasks for Work's folded Done and its Done view.
// The store snapshot holds only open tasks, so finished ones are loaded here on demand for a
// time window (globally or per chat) and then kept fresh by task events.
// Owns: the finished-task signal and its loaded windows. Never: polls, or duplicates open
// tasks (a reopened task leaves this list and lives in the store again).

import { signal } from '@preact/signals';
import type { TaskFilter, TaskView } from '../../shared/model/tasks.ts';
import { RpcError, rpc } from '../lib/rpc.ts';
import { finishedAt, isFinished } from './model.ts';

/** Finished (done/cancelled) top-level tasks known to this client. */
export const doneTasks = signal<TaskView[]>([]);

const GLOBAL = '*';
const FALLBACK_LIMIT = 1000;
/** scope ('*' or a conversation id) → earliest finish time already loaded */
const covered = new Map<string, number>();
/** scope → earliest finish time ever asked for (also windows whose request failed) */
const wanted = new Map<string, number>();
/** scope → requests in flight (a request for an earlier `since` also covers later ones) */
const pending = new Map<string, Array<{ since: number; job: Promise<void> }>>();
/** false once the runtime rejected `completedSince` (older runtime): filter locally instead. */
let windowFilter = true;
let wired = false;

function upsert(views: TaskView[]): void {
  if (!views.length) return;
  const byId = new Map(doneTasks.peek().map((task) => [task.id, task]));
  for (const view of views) if (!view.parentId && isFinished(view.status)) byId.set(view.id, view);
  doneTasks.value = [...byId.values()];
}

function remove(id: string): void {
  if (doneTasks.peek().some((task) => task.id === id)) doneTasks.value = doneTasks.peek().filter((task) => task.id !== id);
}

function wire(): void {
  if (wired) return;
  wired = true;
  rpc.on('task.upserted', (view) => {
    if (view.parentId) return;
    if (isFinished(view.status)) upsert([view]);
    else remove(view.id); // reopened
  });
  rpc.on('task.removed', ({ id }) => remove(id));
  // Missed events while offline (or a request lost with the connection): reload every window
  // that was asked for. Requests queued before the first open are in flight and shared.
  rpc.onOpen(() => {
    // The global window first: chat windows inside it share its request instead of their own.
    const scopes = [...wanted.entries()].sort(([a], [b]) => Number(b === GLOBAL) - Number(a === GLOBAL));
    covered.clear();
    for (const [scope, since] of scopes) void ensureDone({ since, conversationId: scope === GLOBAL ? undefined : scope }).catch(() => undefined);
  });
}

async function fetchWindow(since: number, conversationId?: string): Promise<TaskView[]> {
  const base: TaskFilter = { status: ['done', 'cancelled'], ...(conversationId ? { conversationId } : {}) };
  if (windowFilter) {
    try {
      return await rpc.call('tasks.list', { ...base, completedSince: since, limit: FALLBACK_LIMIT });
    } catch (error) {
      const unsupported = error instanceof RpcError && error.code === 'bad_request' && error.data.details?.param === 'params.completedSince';
      if (!unsupported) throw error;
      windowFilter = false; // runtime without the filter: fall back to a bounded list
    }
  }
  const list = await rpc.call('tasks.list', { ...base, limit: FALLBACK_LIMIT });
  return list.filter((task) => finishedAt(task) >= since);
}

/**
 * Makes sure finished tasks since `since` are loaded (for one chat or all chats).
 * Cheap when the window is already covered; concurrent calls share one request.
 */
export function ensureDone(options: { since: number; conversationId?: string }): Promise<void> {
  wire();
  const scope = options.conversationId ?? GLOBAL;
  wanted.set(scope, Math.min(wanted.get(scope) ?? Infinity, options.since));
  const coveredSince = Math.min(covered.get(scope) ?? Infinity, covered.get(GLOBAL) ?? Infinity);
  if (coveredSince <= options.since) return Promise.resolve();
  // Views mounting together ask for nearly the same window: share a request that covers it.
  for (const key of [scope, GLOBAL]) {
    const running = pending.get(key)?.find((entry) => entry.since <= options.since);
    if (running) return running.job;
  }
  const flight = { since: options.since, job: Promise.resolve() };
  flight.job = fetchWindow(options.since, options.conversationId)
    .then((list) => {
      upsert(list);
      covered.set(scope, Math.min(covered.get(scope) ?? Infinity, options.since));
    })
    .finally(() => {
      const rest = (pending.get(scope) ?? []).filter((entry) => entry !== flight);
      if (rest.length) pending.set(scope, rest); else pending.delete(scope);
    });
  pending.set(scope, [...(pending.get(scope) ?? []), flight]);
  return flight.job;
}
