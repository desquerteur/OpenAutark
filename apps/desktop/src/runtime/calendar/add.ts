// calendar.add (B-041 – a clicked free slot, then typed or dictated): the marked range is the time, the first line the
// title (more lines are its notes). It is a to-do unless the caller says 'event' (kind 'auto' = to-do – no guessing from
// words). An event is a local row with its title. A to-do is the person's own to-do – made like the To-do list's own
// input (tasks/todo-draft.ts quickDraft, chat-free, origin todo-list "Calendar") with the range as its estimate – plus
// its block the person set. With My day's "Only me" switch (settings.day.aiHelps off) the to-do is private. An agent's
// event may not cover a timed event or a block the person set. Resent with the same clientId it answers what the first
// one made.
// Owns: that flow. Never: a model call, a to-do made for the person by an agent here (agents use the calendar tools),
// or task text on the block.

import { WorkforceError } from '../../shared/errors.ts';
import { DEFAULT_ESTIMATE_MIN, type CalendarAddInput, type CalendarEvent } from '../../shared/model/calendar.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { quickDraft } from '../tasks/todo-draft.ts';
import type { CalendarServiceImpl } from './service.ts';
import { ownerOf, setByOf } from './rules.ts';

const MIN = 60_000;
/** An event's length when neither the range nor the text gives one. */
export const DEFAULT_EVENT_MIN = 60;
/** Client ids of events the service remembers (a resend answers the same row; to-dos dedupe by their task's client id). */
const RECENT_MAX = 100;

/** What a slot click says. */
export interface Slot { kind: 'event' | 'todo'; title: string; startAt: number; endAt?: number }

/** The slot's kind, title and span (pure). */
export function readSlot(input: CalendarAddInput): Slot {
  const line = input.text.trim().split(/\r?\n/)[0].trim(); // the first line names it; more lines are its notes
  if (!line) throw new WorkforceError('bad_request', 'Type what goes into the calendar.');
  const slot: Slot = { kind: input.kind === 'event' ? 'event' : 'todo', title: excerpt(line, 120), startAt: input.startAt };
  if (input.endAt !== undefined) slot.endAt = input.endAt;
  return slot;
}

/** calendar.add (see the header). */
export function addFromSlot(calendar: CalendarServiceImpl, input: CalendarAddInput, by: string): { event: CalendarEvent; task?: TaskView } {
  const s = calendar.s;
  const slot = readSlot(input);
  const ownerId = ownerOf(by);
  const setBy = setByOf(by);
  const text = input.text.trim();
  const notes = text.includes('\n') ? { notes: text } : {}; // several lines: the whole text stays with it
  if (slot.kind === 'event') {
    const sent = input.clientId ? calendar.recentEvents.get(`${by}:${input.clientId}`) : undefined;
    const before = sent ? calendar.repo.get(sent) : undefined;
    if (before) return { event: before };
    const endAt = slot.endAt ?? slot.startAt + DEFAULT_EVENT_MIN * MIN;
    if (setBy === 'agent') calendar.refuseFixed(ownerId, { startAt: slot.startAt, endAt });
    const event = calendar.insert({ ...calendar.fresh(ownerId, 'event', setBy, by, slot.startAt, endAt), title: slot.title, ...notes });
    if (input.clientId) remember(calendar.recentEvents, `${by}:${input.clientId}`, event.id);
    return { event };
  }
  if (!isHumanActor(by)) throw new WorkforceError('bad_request', 'An agent puts a to-do into the calendar with calendar.place_task.');
  const estimate = slot.endAt !== undefined
    ? { minutes: Math.max(1, Math.round((slot.endAt - slot.startAt) / MIN)), source: 'said' as const }
    : { minutes: DEFAULT_ESTIMATE_MIN, source: 'default' as const };
  const only = onlyMe(s);
  const task = s.tasks.create({
    origin: { source: ORIGINS.todoList.source, label: 'Calendar' }, ...quickDraft(s, slot.title), ...notes,
    assigneeKind: 'human', createdBy: by, clientId: input.clientId, estimateMin: estimate.minutes, estimateSource: estimate.source,
    ...(only ? { private: true } : {}),
  });
  const existing = calendar.repo.byTask(task.id);
  const event = existing ?? calendar.upsertBlock(task.id, slot.startAt, slot.endAt ?? slot.startAt + estimate.minutes * MIN, 'person', by);
  return { event, task: s.tasks.get(task.id) ?? task };
}

/** My day's switch says "Only me" (settings.day.aiHelps off; unreadable settings: the default "AI helps"). */
function onlyMe(s: CalendarServiceImpl['s']): boolean {
  try { return !daySettingsOf(s.settings.get()).aiHelps; } catch { return false; }
}

function remember(recent: Map<string, string>, key: string, id: string): void {
  recent.delete(key);
  recent.set(key, id);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
}
