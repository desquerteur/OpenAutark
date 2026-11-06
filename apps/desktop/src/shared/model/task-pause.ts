// The person's pause of a task (T06): a human Stop leaves the work 'open', waiting on the human
// with PAUSED_REASON ("Paused by you"). The runtime (tasks/owners.ts pauses and resumes it) and
// the views (task bubble, task detail's Resume) read it through isPaused, so both sides agree.
// Owns: the pause marker. Never: I/O or status changes.

import type { Task } from './tasks.ts';

export const PAUSED_REASON = 'Paused by you';

/** Paused by a human Stop: open and waiting on the human with the pause reason. */
export function isPaused(task: Pick<Task, 'status' | 'waitingOn'>): boolean {
  return task.status === 'open' && task.waitingOn?.kind === 'human' && task.waitingOn.reason === PAUSED_REASON;
}
