// Shared task fixture for the Work rule tests (src/ui/tasks/work-model.ts): a top-level task view,
// open and owned by the agent Mara unless the patch says otherwise, created a little earlier each call.
// Owns: the factory and the fixed clock. Never: assertions.

import type { TaskView } from '../../../src/shared/model/tasks.ts';

export const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MARA = 'ag_mara';
export const TOM = 'ag_tom';
export const ANNA = 'per_anna'; // F-52: a colleague

let seq = 0;

export function task(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: `task_${seq}`, conversationId: 'ch_a', title: `Task ${seq}`, notes: '', status: 'open', assigneeKind: 'agent', assigneeId: MARA,
    createdBy: 'human', priority: 0, ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - seq * 1000, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Launch', running: false,
    ...patch,
  };
}

/** The person's own to-do (on My day): human, no assignee id. */
export function todo(patch: Partial<TaskView> = {}): TaskView {
  return task({ assigneeKind: 'human', assigneeId: undefined, conversationId: 'ch_todo', ...patch });
}

/** Unassigned work (team, nobody yet). */
export function unowned(patch: Partial<TaskView> = {}): TaskView {
  return task({ assigneeKind: 'team', assigneeId: undefined, conversationId: 'ch_inbox', ...patch });
}

export const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((entry) => entry.id);
