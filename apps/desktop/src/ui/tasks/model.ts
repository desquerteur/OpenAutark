// Pure helpers behind the task and to-do views: status labels, progress text, steps and the
// "leaving" merge for answered items. Work's list – its groups, views and counts –, the owner rules and the board
// order live in tasks/work-model.ts (B-041); the person's to-do helpers (widget icons, "Show as…", due state and
// due-date inputs) in tasks/todo-model.ts, the calm My day order and its time rules (ringing, "Later", the badge
// count, ring times – F04) in tasks/todo-time.ts; all three are re-exported here.
// Owns: these rules (unit-tested in test/unit/ui/tasks-model.test.ts and tasks-later.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in, so tests run in Node.

import type { Task, TaskStatus, TaskView } from '../../shared/model/tasks.ts';

export * from './todo-model.ts';
export * from './todo-time.ts';
export * from './work-model.ts';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open', working: 'Working', waiting: 'Waiting', needs_you: 'Needs you', blocked: 'Stuck', done: 'Done', cancelled: 'Cancelled',
};

// ------------------------------------------------------------------ progress, steps

export function progressLabel(progress: { done: number; total: number }): string {
  return progress.total ? `${progress.done} of ${progress.total}` : '';
}

export function progressShort(progress: { done: number; total: number }): string {
  return progress.total ? `${progress.done}/${progress.total}` : '';
}

export function progressPercent(progress: { done: number; total: number }): number {
  return progress.total ? Math.round((Math.min(progress.done, progress.total) / progress.total) * 100) : 0;
}

/** A human may tick steps that are theirs (T14); agents' steps show their state only. */
export function canToggleStep(step: Pick<Task, 'assigneeKind' | 'status'>): boolean {
  return step.assigneeKind === 'human' && step.status !== 'cancelled';
}

/** Steps in checklist order. */
export function orderedSteps<T extends Pick<Task, 'sort' | 'createdAt'>>(steps: T[]): T[] {
  return steps.slice().sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

/** Replaces one step inside its parent view and recomputes the progress. */
export function withStep(parent: TaskView, step: Task): TaskView {
  const known = parent.steps.some((entry) => entry.id === step.id);
  const steps = known ? parent.steps.map((entry) => (entry.id === step.id ? step : entry)) : [...parent.steps, step];
  return { ...parent, steps, progress: { done: steps.filter((entry) => entry.status === 'done').length, total: steps.length } };
}

export function withoutStep(parent: TaskView, stepId: string): TaskView {
  const steps = parent.steps.filter((entry) => entry.id !== stepId);
  return { ...parent, steps, progress: { done: steps.filter((entry) => entry.status === 'done').length, total: steps.length } };
}

// ------------------------------------------------------------------ leaving animation

export interface Leaving<T> { item: T; index: number }

/**
 * Items present in `previous` but gone from `next`, with their former index. With `known` (the
 * full source list), items that only left the visible slice – pushed past a limit or filtered
 * out – are not "removed": only items gone from the source animate away as answered.
 */
export function removedItems<T extends { id: string }>(previous: T[], next: T[], known?: ReadonlyArray<{ id: string }>): Array<Leaving<T>> {
  const ids = new Set(next.map((item) => item.id));
  if (known) for (const item of known) ids.add(item.id);
  const out: Array<Leaving<T>> = [];
  previous.forEach((item, index) => { if (!ids.has(item.id)) out.push({ item, index }); });
  return out;
}

/** Current items plus the leaving ones re-inserted at their former place (for the exit animation). */
export function withLeaving<T extends { id: string }>(current: T[], leaving: Array<Leaving<T>>): Array<{ item: T; leaving: boolean }> {
  const out = current.map((item) => ({ item, leaving: false }));
  const present = new Set(current.map((item) => item.id));
  for (const entry of leaving.slice().sort((a, b) => a.index - b.index)) {
    if (present.has(entry.item.id)) continue;
    out.splice(Math.min(entry.index, out.length), 0, { item: entry.item, leaving: true });
  }
  return out;
}
