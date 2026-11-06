// The calendar's pure rules (B-041 track A1, the My day concept §4.2, contract §5.6): what a
// to-do's check-off does to its block (ticked before the block → the block goes and the time is free; during →
// it ends now, 'cut'; after → 'done'; cancelled → it goes; reopened → planned again while it has not ended (a cut
// block gets back the end its estimate gave it), else it goes, so the to-do is unplanned and the planner places it; handed
// to the team → a block that has not started goes), which rows an agent or the planner must never be placed over
// (timed events and the person's own blocks), the busy spans the planner plans around (every timed row), and the
// free gaps of a day, and (B-078) the gaps several members share, each inside their own working hours.
// Owns: these rules. Never: I/O, the clock (callers pass `now`), or a model call.

import { DEFAULT_ESTIMATE_MIN, type CalendarEvent, type CalendarSetBy } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';

export interface Span { startAt: number; endAt: number }

const MIN = 60_000;

/** What a task change does to its block. */
export type BlockChange =
  | { action: 'none' }
  | { action: 'remove' }
  | { action: 'cut'; endAt: number }
  | { action: 'done' }
  | { action: 'planned'; endAt: number };

const NONE: BlockChange = { action: 'none' };

/** The block's change after its task became `task` (see the header); `now` when the task gives no finish time. */
export function blockChange(
  block: Pick<CalendarEvent, 'startAt' | 'endAt' | 'state'>, task: Pick<Task, 'status' | 'completedAt' | 'assigneeKind' | 'estimateMin'>, now: number,
): BlockChange {
  if (task.status === 'cancelled') return { action: 'remove' };
  if (task.status === 'done') {
    if (block.state !== 'planned') return NONE;
    const at = task.completedAt ?? now;
    if (at <= block.startAt) return { action: 'remove' };
    if (at < block.endAt) return { action: 'cut', endAt: at };
    return { action: 'done' };
  }
  if (block.state !== 'planned') { // reopened: a cut block ended at the tick – its end was the estimate's
    const endAt = block.state === 'cut' ? Math.max(block.endAt, block.startAt + (task.estimateMin ?? DEFAULT_ESTIMATE_MIN) * MIN) : block.endAt;
    return endAt > now ? { action: 'planned', endAt } : { action: 'remove' };
  }
  if (task.assigneeKind !== 'human' && block.startAt > now) return { action: 'remove' }; // handed to the team before its time
  return NONE;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

/** A row nothing may be placed over by an agent or the planner: a timed event, or a block the person set (not `taskId`'s own). */
export function isFixed(row: Pick<CalendarEvent, 'kind' | 'allDay' | 'setBy' | 'taskId'>, taskId?: string): boolean {
  if (row.allDay) return false;
  if (row.kind === 'event') return true;
  return row.setBy === 'person' && (taskId === undefined || row.taskId !== taskId);
}

/** The fixed rows `span` would cover. */
export function conflicts<T extends Pick<CalendarEvent, 'kind' | 'allDay' | 'setBy' | 'taskId' | 'startAt' | 'endAt'>>(rows: readonly T[], span: Span, taskId?: string): T[] {
  return rows.filter((row) => isFixed(row, taskId) && overlaps(row, span));
}

/**
 * The planner's busy spans: every timed row – events of the shown calendars and every to-do block, the planner's own
 * too (it leaves out the blocks of the to-dos it is placing again; they come with its candidates). All-day rows are
 * no busy time. Sorted by start.
 */
export function busySpans(rows: readonly Pick<CalendarEvent, 'allDay' | 'startAt' | 'endAt'>[]): Span[] {
  return rows
    .filter((row) => !row.allDay)
    .map((row) => ({ startAt: row.startAt, endAt: row.endAt }))
    .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
}

/** Free gaps of at least `minutes` inside [from, to) around `busy` (each kept `bufferMin` apart from it), by start. */
export function freeGaps(busy: readonly Span[], from: number, to: number, minutes: number, bufferMin = 0): Span[] {
  const buffer = Math.max(0, bufferMin) * MIN;
  const spans = busy.map((span) => ({ startAt: span.startAt - buffer, endAt: span.endAt + buffer })).sort((a, b) => a.startAt - b.startAt);
  const out: Span[] = [];
  let cursor = from;
  for (const span of spans) {
    if (span.endAt <= cursor) continue;
    if (span.startAt >= to) break;
    if (span.startAt - cursor >= minutes * MIN) out.push({ startAt: cursor, endAt: span.startAt });
    cursor = Math.max(cursor, span.endAt);
  }
  if (to - cursor >= minutes * MIN) out.push({ startAt: cursor, endAt: to });
  return out;
}

/** One member's side of a common slot: their busy spans and the window they are there (UTC epoch ms; B-078 D20). */
export interface MemberWindow { busy: readonly Span[]; from: number; to: number; bufferMin?: number }

/**
 * Gaps of at least `minutes` that every member has free (each within their own window, with their own buffer) –
 * the intersection of freeGaps per member, by start. No members: none.
 */
export function commonGaps(members: readonly MemberWindow[], minutes: number): Span[] {
  if (!members.length) return [];
  let common: Span[] | undefined;
  for (const member of members) {
    const gaps = freeGaps(member.busy, member.from, member.to, minutes, member.bufferMin ?? 0);
    if (!common) { common = gaps; continue; }
    const next: Span[] = [];
    for (const a of common) {
      for (const b of gaps) {
        const startAt = Math.max(a.startAt, b.startAt);
        const endAt = Math.min(a.endAt, b.endAt);
        if (endAt - startAt >= minutes * MIN) next.push({ startAt, endAt });
      }
    }
    common = next.sort((a, b) => a.startAt - b.startAt);
    if (!common.length) return [];
  }
  return common ?? [];
}

/** Who placed a row made by `by`: a person ('person', pinned) or an agent. */
export function setByOf(by: string): CalendarSetBy {
  return isHumanActor(by) ? 'person' : 'agent';
}

/** Whose calendar `by` writes: a person's own, else the owner's (agents act on the owner's day in this build). */
export function ownerOf(by: string): string {
  return isPersonId(by) ? by : HUMAN_ID;
}

/** Whose block a task gets: the person it is assigned to (undefined for work that is no to-do). */
export function blockOwner(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): string | undefined {
  if (task.assigneeKind !== 'human') return undefined;
  return isPersonId(task.assigneeId) ? task.assigneeId! : HUMAN_ID;
}
