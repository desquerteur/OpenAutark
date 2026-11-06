// Check-off ↔ calendar (B-041 track A1, contract §5.6, the My day concept §4.2 – "dann werden die
// Sachen auch abgehakt … oder eben wieder aus dem Kalender aktiv rausgenommen, wenn ich sie abhake"): a bus listener
// on task.upserted (top-level to-dos and steps alike) applies calendar/rules.ts blockChange to the task's block –
// ticked before the block: removed, the time is free; during: it ends now ('cut'); after: 'done'; cancelled:
// removed; reopened: planned again while it has not ended (a cut block with the end its estimate gave it), else
// removed – the to-do is unplanned and the planner places it again; handed to the team before its time: removed. A removed
// task (task.removed) or chat (conversation.removed) took its blocks along by cascade: the sweep sends them as
// removed. Every change goes through the service, so the UI and the sources' mirror hear it.
// Owns: those listeners. Never: changes a task, or touches a row that is not a task's block.

import type { TaskView } from '../../shared/model/tasks.ts';
import { blockChange } from './rules.ts';
import type { CalendarServiceImpl } from './service.ts';

/** Subscribes the listeners; returns their unsubscribers. */
export function linkTasks(calendar: CalendarServiceImpl): Array<() => void> {
  const { bus } = calendar.s;
  const quietly = (what: string, run: () => void) => {
    try { run(); } catch (error) { calendar.s.log?.warn(`calendar: ${what} failed`, { error: String(error) }); }
  };
  return [
    bus.on('task.upserted', (task) => quietly('check-off', () => followTask(calendar, task))),
    bus.on('task.removed', () => quietly('sweep', () => calendar.sweep())),
    bus.on('conversation.removed', () => quietly('sweep', () => calendar.sweep())),
  ];
}

/** The block of `task` after this change of the task (see the header). */
export function followTask(calendar: CalendarServiceImpl, task: TaskView): void {
  const block = calendar.blockOf(task.id);
  if (!block) return;
  const now = calendar.s.clock.now();
  const change = blockChange(block, task, now);
  const next = { ...block, rev: block.rev + 1, updatedAt: now };
  switch (change.action) {
    case 'none': return;
    case 'remove': calendar.drop(block); return;
    case 'cut': calendar.save({ ...next, endAt: change.endAt, state: 'cut' }, block.rev); return;
    case 'done': calendar.save({ ...next, state: 'done' }, block.rev); return;
    case 'planned': calendar.save({ ...next, endAt: change.endAt, state: 'planned' }, block.rev); return;
  }
}
