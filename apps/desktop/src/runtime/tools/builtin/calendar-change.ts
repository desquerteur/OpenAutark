// Moving and removing an entry of the person's calendar (B-050 K10, next to calendar.add in calendar.ts and on its
// rules): only from a turn nobody but the owner reads (F-52), and only an entry that is the agent's to change – an
// appointment this agent put in (setBy 'agent', its id as createdBy), or the time block of one of the person's own
// to-dos the agent may plan (calendar.ts plannable: readable, not "Only me", no card the app opened). Never an entry
// the person set or moved (setBy 'person'), nor one from a connected calendar (changed there). A move keeps the
// length unless endAt is given and never lands over the person's appointments or blocks they set; a removed block
// leaves its to-do unplanned. Each change leaves a status line in the agent's chat, like calendar.add.
// Owns: these two tool definitions and that ownership rule. Never: changes a row itself (runtime/calendar/service.ts).

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { LOCAL_SOURCE_ID, type CalendarEvent } from '../../../shared/model/calendar.ts';
import type { TaskView } from '../../../shared/model/tasks.ts';
import { spanText } from '../../calendar/agent-view.ts';
import { CalendarRepo } from '../../calendar/repo.ts';
import { conflicts } from '../../calendar/rules.ts';
import { profileZone } from '../../calendar/service.ts';
import { announce, calendarFor, isOutput, plannable, refused, TIME, toolTime } from './calendar.ts';
import { clip, defineTool, internal } from './util.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ENTRY = { type: 'string', minLength: 1, maxLength: 100, description: 'The entry\'s id from calendar.list.' };

/** The person's entry `id` when this agent may change it (with its to-do for a block), else why not. */
function ownEntry(ctx: ToolContext, id: string): { row: CalendarEvent; task?: TaskView } | string {
  const row = new CalendarRepo(ctx.services.db).get(id);
  if (!row || row.ownerId !== HUMAN_ID) return `Calendar entry ${id} not found.`;
  if (row.readOnly || row.sourceId !== LOCAL_SOURCE_ID) return 'This entry comes from a connected calendar; it is changed there.';
  if (row.setBy === 'person') return 'The person set this entry; only they change it.';
  if (row.kind === 'event') return row.setBy === 'agent' && row.createdBy === ctx.agent.id ? { row } : 'Only an appointment I put in is mine to change.';
  const task = row.taskId ? plannable(ctx, row.taskId) : `Calendar entry ${id} not found.`;
  return typeof task === 'string' ? task : { row, task };
}

const moveEntry = defineTool<{ eventId: string; startAt: string; endAt?: string }>({
  name: 'calendar.move',
  description: 'Move an appointment I put into the person\'s calendar, or the time block of one of their to-dos (same length unless endAt is given). Not over their appointments or blocks they set; an entry the person set stays.',
  inputSchema: { type: 'object', properties: { eventId: ENTRY, startAt: TIME, endAt: TIME }, required: ['eventId', 'startAt'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Move calendar entry ${args.eventId}`, args.eventId),
  async run(args, ctx) {
    const calendar = calendarFor(ctx);
    if (isOutput(calendar)) return calendar;
    const entry = ownEntry(ctx, args.eventId);
    if (typeof entry === 'string') return failure(entry);
    const { row, task } = entry;
    const now = ctx.services.clock.now();
    const tz = profileZone(ctx.services);
    const startAt = toolTime(args.startAt, now, tz);
    if (startAt === undefined || startAt < now - MIN) return failure('Give startAt as a time from now on.');
    const endAt = args.endAt === undefined ? startAt + (row.endAt - row.startAt) : toolTime(args.endAt, now, tz);
    if (endAt === undefined || endAt <= startAt || endAt - startAt > 14 * DAY) return failure('endAt must come after startAt (at most 14 days later).');
    try {
      let moved: CalendarEvent;
      if (task) moved = calendar.upsertBlock(task.id, startAt, endAt, 'agent', ctx.agent.id);
      else {
        const hit = conflicts(calendar.list(HUMAN_ID, startAt, endAt).events.filter((other) => other.id !== row.id), { startAt, endAt })[0];
        if (hit) return failure(`That time is taken (${spanText(hit.startAt, hit.endAt, tz)}). Use calendar.find_free.`);
        moved = calendar.move(row.id, startAt, endAt, row.rev, ctx.agent.id);
      }
      const title = clip(task?.title ?? row.title ?? '', 60);
      announce(ctx, `Moved in the person's calendar: ${title} · ${spanText(moved.startAt, moved.endAt, tz)}`, { eventId: moved.id, ...(task ? { taskId: task.id } : {}) });
      return json({ ok: true, eventId: moved.id, when: spanText(moved.startAt, moved.endAt, tz) });
    } catch (error) { return refused(error); }
  },
});

const removeEntry = defineTool<{ eventId: string }>({
  name: 'calendar.remove',
  description: 'Remove an appointment I put into the person\'s calendar, or the time block of one of their to-dos (the to-do stays, unplanned). An entry the person set stays.',
  inputSchema: { type: 'object', properties: { eventId: ENTRY }, required: ['eventId'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Remove calendar entry ${args.eventId}`, args.eventId),
  async run(args, ctx) {
    const calendar = calendarFor(ctx);
    if (isOutput(calendar)) return calendar;
    const entry = ownEntry(ctx, args.eventId);
    if (typeof entry === 'string') return failure(entry);
    const { row, task } = entry;
    const tz = profileZone(ctx.services);
    try {
      calendar.remove(row.id, ctx.agent.id);
    } catch (error) { return refused(error); }
    const title = clip(task?.title ?? row.title ?? '', 60);
    announce(ctx, `Removed from the person's calendar: ${title} · ${spanText(row.startAt, row.endAt, tz)}`, { eventId: row.id, ...(task ? { taskId: task.id } : {}) });
    return json({ ok: true, eventId: row.id, ...(task ? { taskId: task.id, note: 'The to-do stays, without a time.' } : {}) });
  },
});

export const calendarChangeTools: ToolDef[] = [moveEntry, removeEntry];
