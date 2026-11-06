// The static "waiting on … since" line of a task bubble (T2): who or what the work waits on and
// since when – "Paused by you since …" for work the person stopped (T06, shared isPaused) – and
// whether the task detail offers Resume.
// B-078: also the detail's one sentence of state (stateLine).
// Owns: that text and the Resume rule (unit-tested in test/unit/ui/task-waiting.test.ts).
// Never: imports the store, rpc or the DOM – agent names come in from the caller.

import type { TaskView } from '../../shared/model/tasks.ts';
import { isPaused } from '../../shared/model/task-pause.ts';
import { listTime, plainPreview, time } from '../lib/format.ts';

type Waiting = Pick<TaskView, 'status' | 'waitingOn'>;

export function waitingLine(task: Waiting, agentName: (id: string) => string): string | null {
  if (isPaused(task)) return `Paused by you since ${time(task.waitingOn!.since)}`;
  if (task.status === 'needs_you') return task.waitingOn ? `Waiting on you since ${time(task.waitingOn.since)}` : 'Needs you';
  if ((task.status === 'waiting' || task.status === 'blocked') && task.waitingOn) {
    const who = task.waitingOn.kind === 'agent' && task.waitingOn.id ? agentName(task.waitingOn.id) : task.waitingOn.kind === 'human' ? 'you' : '';
    const prefix = task.status === 'blocked' ? 'Stuck' : who ? `Waiting on ${who}` : 'Waiting';
    return `${prefix} since ${time(task.waitingOn.since)} · ${plainPreview(task.waitingOn.reason, 90)}`;
  }
  return null;
}

/** "10:14" today, else the list's day with the time ("Mon 10:14", "12.10 10:14"), so an older finish never reads as today's. */
function doneAt(ms: number, now: number): string {
  const day = listTime(ms, now);
  const clock = time(ms);
  return day === clock ? clock : `${day} ${clock}`;
}

type Stated = Waiting & Pick<TaskView, 'assigneeKind' | 'assigneeId' | 'running' | 'completedAt' | 'updatedAt'>;

/**
 * B-078: the task detail's one sentence of state – "Mara is on it" only while a turn really runs, "Waiting on you
 * since 10:14", "Done 10:14" (an earlier day: "Done Mon 10:14"), "No owner yet"; an owner's open work between turns is "Mara has it".
 */
export function stateLine(task: Stated, agentName: (id: string) => string, now = Date.now()): string {
  if (task.status === 'done') return `Done ${doneAt(task.completedAt ?? task.updatedAt, now)}`;
  if (task.status === 'cancelled') return 'Cancelled';
  const waiting = waitingLine(task, agentName);
  if (waiting) return waiting;
  const owner = task.assigneeKind === 'agent' && task.assigneeId ? agentName(task.assigneeId) : '';
  if (task.assigneeKind === 'team') return task.running ? 'The team is deciding who does it' : 'No owner yet';
  if (task.assigneeKind === 'human') return task.assigneeId && task.assigneeId !== 'human' ? `${agentName(task.assigneeId)} has it` : 'Yours';
  if (task.running) return `${owner || 'An agent'} is on it`;
  return owner ? `${owner} has it` : 'Open';
}

/**
 * Resume in the task detail: only for work the person paused – there tasks.setStatus 'working'
 * ends the pause and wakes the owner (other open work would really be set to working).
 */
export function canResume(task: Waiting): boolean {
  return isPaused(task);
}
