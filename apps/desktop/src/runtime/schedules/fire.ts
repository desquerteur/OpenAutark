// What a due schedule does, per kind:
//  * message  → a normal chat post by the owner (as if typed then), meta.via 'schedule';
//  * reminder → wakes the owning agent with its own first-person note (no chat post);
//  * routine  → creates a tracked task from payload.taskTemplate (title, notes, mode and – T11 –
//               checklist steps; payload.priority 'important' → High) and wakes an agent owner;
//               the person's "Post as task" routines post a team task (the lead picks it up);
//               the stored template is bounded first (post.ts boundedTemplate: no malformed or
//               oversized steps/title from an agent's raw `task` can break or flood a run);
//  * timer    → notifies the human (kind 'todo') and marks the linked human to-do 'needs_you' –
//               never for a to-do that is already done or cancelled (F03: the schedule ends).
// B-044: also the one quiet "Scheduled" chat line when a post or routine is created (announceCreated).
// B-054: a routine without a chat creates a chat-free task; only a routine whose chat was set and is gone ends
// (ScheduleGone). Reminder and routine wakes – and routine tasks – carry the origin schedule:<id>.
// B-059 (overlap, Temporal-style skip): an agent's routine whose previous occurrence task is still unfinished
// (any state but done/cancelled, isRoutineOccurrence) creates no second copy and wakes nobody – that task gets one
// ledger fact "Skipped the HH:MM run – the previous one is still open" (the newest replaces an older one).
// Owns: those effects. Never: computes times or touches the schedules table.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Schedule, Task, TaskView } from '../../shared/model/tasks.ts';
import { cleanOrigin, scheduleSource, type Origin } from '../../shared/model/origin.ts';
import { boundedTemplate } from './post.ts';
import { clockText, validZone } from '../context/time.ts';

const SKIPPED = /^Skipped the \d{2}:\d{2} run – /;

/**
 * B-059: is `task` an occurrence task of this routine – top-level, the routine's origin and its template's title?
 * (Work the agent creates during a routine's run carries the same origin but its own title.)
 */
export function isRoutineOccurrence(schedule: Schedule, task: Pick<Task, 'parentId' | 'origin' | 'title'>): boolean {
  return schedule.kind === 'routine' && !task.parentId && task.origin?.source === scheduleSource(schedule.id)
    && task.title === boundedTemplate(schedule.payload.taskTemplate, schedule.title).title;
}

/** B-059: the agent's still unfinished task of an earlier occurrence of this routine, if any. */
function openOccurrence(schedule: Schedule, s: FireDeps): TaskView | undefined {
  try { return s.tasks.openFor(schedule.ownerId).find((task) => isRoutineOccurrence(schedule, task)); } catch { return undefined; }
}

/** B-059: the one skip note on the open occurrence (a failed note never fails the fire). */
function noteSkip(task: TaskView, schedule: Schedule, occurrence: number, s: FireDeps): void {
  const fact = `Skipped the ${clockText(occurrence, validZone(schedule.spec.tz))} run – the previous one is still open`;
  const facts = [...(task.ledger.facts ?? []).filter((line) => !SKIPPED.test(line)), fact].slice(-20);
  try { s.tasks.update(task.id, { ledger: { ...task.ledger, facts } }, SYSTEM_ID); } catch { /* the skip stands without its note */ }
}

/** B-054: why a schedule's wake or task exists – 'Reminder' or 'Routine "<title>"'. */
export function scheduleOrigin(schedule: Pick<Schedule, 'id' | 'kind' | 'title'>): Origin {
  const label = schedule.kind === 'routine' ? `Routine "${schedule.title}"` : schedule.kind === 'reminder' ? 'Reminder' : 'Schedule';
  return cleanOrigin({ source: scheduleSource(schedule.id), label })!;
}

export type FireDeps = Pick<RuntimeServices, 'chats' | 'tasks' | 'wakes'> & Partial<Pick<RuntimeServices, 'notifications'>>;

/** Thrown when a schedule can never fire again (its chat or owner is gone). */
export class ScheduleGone extends Error {}

export function fireSchedule(schedule: Schedule, occurrence: number, s: FireDeps): void {
  const ownerKind = schedule.ownerId === HUMAN_ID ? 'human' : 'agent';
  switch (schedule.kind) {
    case 'message': {
      if (!schedule.conversationId || !s.chats.get(schedule.conversationId)) throw new ScheduleGone('chat removed');
      s.chats.send({
        conversationId: schedule.conversationId,
        body: schedule.payload.body ?? schedule.title,
        mentions: schedule.payload.mentions,
        priority: schedule.payload.priority,
        silent: schedule.payload.silent === true,
        authorId: schedule.ownerId,
        authorKind: ownerKind,
        taskId: schedule.taskId,
        meta: { via: 'schedule', scheduleId: schedule.id, plannedAt: occurrence, ...(schedule.payload.ultra === true && ownerKind === 'human' ? { ultra: true as const } : {}) }, // B-057: a person's suggestion only
      });
      return;
    }
    case 'reminder': {
      if (ownerKind !== 'agent') throw new ScheduleGone('reminders belong to agents');
      s.wakes.wake({
        agentId: schedule.ownerId, reason: 'schedule', conversationId: schedule.conversationId, taskId: schedule.taskId,
        note: schedule.payload.note ?? schedule.title, coalesceKey: `sch:${schedule.id}`, origin: scheduleOrigin(schedule),
      });
      return;
    }
    case 'routine': {
      // B-054: a routine needs no chat; one whose chat was set and is gone ends.
      if (schedule.conversationId && !s.chats.get(schedule.conversationId)) throw new ScheduleGone('chat removed');
      const template = boundedTemplate(schedule.payload.taskTemplate, schedule.title);
      const origin = scheduleOrigin(schedule);
      const open = ownerKind === 'agent' ? openOccurrence(schedule, s) : undefined;
      if (open) { noteSkip(open, schedule, occurrence, s); return; } // B-059: the last run is still open – no second copy
      const task = s.tasks.create({
        ...(schedule.conversationId ? { conversationId: schedule.conversationId } : {}), origin,
        title: template.title, notes: template.notes, mode: template.mode, steps: template.steps,
        priority: schedule.payload.priority === 'important' ? 1 : undefined,
        createdBy: schedule.ownerId,
        assigneeKind: ownerKind === 'agent' ? 'agent' : 'team',
        assigneeId: ownerKind === 'agent' ? schedule.ownerId : undefined,
      });
      if (ownerKind === 'agent') {
        s.wakes.wake({
          agentId: schedule.ownerId, reason: 'schedule', conversationId: schedule.conversationId, taskId: task.id,
          note: schedule.payload.note, coalesceKey: `sch:${schedule.id}`, origin,
        });
      }
      return;
    }
    case 'timer': {
      const linked = schedule.taskId ? s.tasks.get(schedule.taskId) : undefined;
      if (schedule.taskId && (!linked || linked.status === 'done' || linked.status === 'cancelled')) throw new ScheduleGone('to-do finished');
      s.notifications?.notify({
        kind: 'todo', title: schedule.title, body: schedule.payload.note && schedule.payload.note !== schedule.title ? schedule.payload.note : '',
        conversationId: schedule.conversationId, taskId: schedule.taskId,
      });
      if (schedule.taskId) {
        const task = s.tasks.get(schedule.taskId);
        if (task && (task.status === 'open' || task.status === 'waiting')) s.tasks.setStatus(task.id, 'needs_you', SYSTEM_ID, 'Timer');
      }
      return;
    }
  }
}

/**
 * B-044: the one quiet chat line when a post or routine is scheduled – the person's and the agents'
 * alike (reminders and timers stay private). The UI shows it as "Scheduled · <when>" (details.nextAt),
 * linking to Chat details › Scheduled. A failed line never fails the schedule.
 */
export function announceCreated(schedule: Schedule, s: Pick<RuntimeServices, 'chats'>): void {
  if (!schedule.conversationId || schedule.kind === 'reminder' || schedule.kind === 'timer') return;
  const details = { scheduleId: schedule.id, ...(schedule.nextAt !== undefined ? { nextAt: schedule.nextAt } : {}) };
  s.chats.status(schedule.conversationId, { type: 'schedule_created', text: `Scheduled · ${schedule.title}`, details }, { authorId: schedule.ownerId, taskId: schedule.taskId });
}
