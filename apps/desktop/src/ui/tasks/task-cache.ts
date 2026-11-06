// Live TaskView cache for task bubbles and task details: one signal per task id, fed by task
// events (any status – the store keeps only open tasks), the open-task snapshot and an
// on-demand, de-duplicated `tasks.get`. Users are ref-counted, so a reconnect refreshes only
// what is on screen and unused entries can be dropped.
// Owns: the cache and useTask()/putTask(). Never: polls, or keeps a second task list
// (the board and lists read the store; this only serves single-task views).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { TaskView } from '../../shared/model/tasks.ts';
import { RpcError, rpc } from '../lib/rpc.ts';
import { tasks, todos } from '../lib/store.ts';
import { withoutStep, withStep } from './model.ts';

/** undefined = not loaded yet · null = gone (deleted or not found) */
type Value = TaskView | null | undefined;

interface Entry {
  value: Signal<Value>;
  refs: number;
  loading: boolean;
}

const MAX_IDLE = 300;
const entries = new Map<string, Entry>();
let wired = false;

/** Seed from the store without subscribing the caller to every task change (peek). */
function known(id: string): TaskView | undefined {
  return tasks.peek().find((task) => task.id === id) ?? todos.peek().find((task) => task.id === id);
}

function entry(id: string): Entry {
  let found = entries.get(id);
  if (!found) {
    found = { value: signal<Value>(known(id)), refs: 0, loading: false };
    entries.set(id, found);
  }
  return found;
}

function load(id: string, target: Entry): void {
  if (target.loading) return;
  target.loading = true;
  rpc.call('tasks.get', { id })
    .then((view) => { target.value.value = view; })
    .catch((error) => { if (error instanceof RpcError && error.code === 'not_found') target.value.value = null; })
    .finally(() => { target.loading = false; });
}

/** Drops unused entries once the cache grows (oldest first – Map keeps insertion order). */
function prune(): void {
  if (entries.size <= MAX_IDLE) return;
  for (const [id, item] of entries) {
    if (entries.size <= MAX_IDLE) break;
    if (item.refs <= 0) entries.delete(id);
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  rpc.on('task.upserted', (view) => {
    const own = entries.get(view.id);
    if (own) own.value.value = view;
    // A step changed: keep the parent's checklist in step (the runtime re-emits parents only on "done").
    if (view.parentId) {
      const parent = entries.get(view.parentId);
      if (parent?.value.value) parent.value.value = withStep(parent.value.value, view);
    }
  });
  rpc.on('task.removed', ({ id }) => {
    const own = entries.get(id);
    if (own) own.value.value = null;
    for (const item of entries.values()) {
      const view = item.value.value;
      if (view?.steps.some((step) => step.id === id)) item.value.value = withoutStep(view, id);
    }
  });
  // Events may have been missed while disconnected: refresh what is mounted, forget the rest.
  rpc.onOpen(() => {
    for (const [id, item] of entries) {
      if (item.refs > 0) load(id, item);
      else entries.delete(id);
    }
  });
}

/** The live view of one task (loads it when unknown). Re-renders only for this task. */
export function useTask(id: string | undefined): Value {
  wire();
  const target = id ? entry(id) : undefined;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!id || !target) return;
    // Another unmount may have pruned this (then unreferenced) entry between render and effect:
    // put it back, or switch to the entry that replaced it, so task events still reach us.
    const current = entries.get(id);
    if (!current) entries.set(id, target);
    else if (current !== target) { rerender((n) => n + 1); return; }
    target.refs++;
    if (target.value.value === undefined) load(id, target);
    return () => { target.refs--; prune(); };
  }, [id, target]);
  return target ? target.value.value : undefined;
}

/** Puts a fresh view from an RPC result into the cache at once (events follow anyway). */
export function putTask(view: TaskView): void {
  wire();
  entry(view.id).value.value = view;
  if (view.parentId) {
    const parent = entries.get(view.parentId);
    if (parent?.value.value) parent.value.value = withStep(parent.value.value, view);
  }
}

/** Fetches a task once (cached), e.g. to jump to its message. */
export async function fetchTask(id: string): Promise<TaskView | null> {
  wire();
  const target = entry(id);
  if (target.value.value !== undefined) return target.value.value;
  try {
    const view = await rpc.call('tasks.get', { id });
    target.value.value = view;
    return view;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'not_found') target.value.value = null;
    throw error;
  }
}
