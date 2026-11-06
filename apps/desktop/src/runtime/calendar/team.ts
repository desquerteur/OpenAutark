// The calendar across members (B-078 D20, the agent tools' `who`, tools/builtin/calendar.ts): busy times of several
// members, the free time they share on a day (each inside their own working hours, in their own zone – rules.ts
// commonGaps over UTC spans) and one appointment booked into each member's calendar. A booking first looks at every
// member (nothing goes over an appointment or a block the person set; an unreachable member stops it before anything
// is written), then writes here for members here (a room's booking lives in Autark only – a room calendar is read
// from its ICS address) and asks each member's own PC to add it there (calendar/linked.ts, never retried). And the
// owner's read of a person's calendar for their page (calendar.person).
// Owns: these flows. Never: shows titles of others (busy only), or retries a write on another PC.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { CalendarEvent, PersonCalendar, PersonCalendarEntry } from '../../shared/model/calendar.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { spanText } from './agent-view.ts';
import { askPeer } from './linked.ts';
import { availability, memberWindow, type Member, type MemberServices } from './members.ts';
import { commonGaps, overlaps, type MemberWindow, type Span } from './rules.ts';
import { CalendarServiceImpl } from './service.ts';
import { zonedTime } from './when.ts';

const HOUR = 60 * 60_000;
/** How far another zone's working day can reach beyond this PC's day. */
const ZONE_REACH = 14 * HOUR;

export interface BusyLine { start: string; end: string; when: string }
export type MemberBusy = { who: string; name: string; tz?: string; busy?: BusyLine[]; unreachable?: string };

const lines = (spans: readonly Span[], tz: string): BusyLine[] =>
  spans.map((span) => ({ start: new Date(span.startAt).toISOString(), end: new Date(span.endAt).toISOString(), when: spanText(span.startAt, span.endAt, tz) }));
const why = (error: unknown) => (error instanceof WorkforceError ? error.message : 'not reachable right now');

/** Busy times of each member in [from, to) – shown in `tz` (this PC's zone); an unreachable member says why. */
export async function membersBusy(s: MemberServices, members: readonly Member[], from: number, to: number, tz: string, signal?: AbortSignal): Promise<MemberBusy[]> {
  return Promise.all(members.map(async (member): Promise<MemberBusy> => {
    try {
      const available = await availability(s, member, from, to, 'busy', signal);
      return { who: member.who, name: member.name, ...(available.tz !== tz ? { tz: available.tz } : {}), busy: lines(available.busy, tz) };
    } catch (error) { return { who: member.who, name: member.name, unreachable: why(error) }; }
  }));
}

/** Free time of at least `minutes` all reachable members share on `date` (from `now` on); the unreachable ones listed. */
export async function freeTogether(s: MemberServices, members: readonly Member[], date: string, minutes: number, now: number, tz: string, signal?: AbortSignal):
  Promise<{ free: Span[]; unreachable: Array<{ who: string; name: string; why: string }> }> {
  const from = zonedTime(date, 0, tz) - ZONE_REACH;
  const to = zonedTime(date, 24 * 60, tz) + ZONE_REACH;
  const windows: MemberWindow[] = [];
  const unreachable: Array<{ who: string; name: string; why: string }> = [];
  await Promise.all(members.map(async (member) => {
    try {
      const available = await availability(s, member, from, to, 'busy', signal);
      const window = memberWindow(available, date, tz);
      windows.push({ busy: available.busy, from: Math.max(now, window.from), to: window.to, bufferMin: available.bufferMin });
    } catch (error) { unreachable.push({ who: member.who, name: member.name, why: why(error) }); }
  }));
  return { free: windows.length ? commonGaps(windows, minutes) : [], unreachable };
}

export type Booked = { who: string; name: string; eventId?: string; error?: string; note?: string };

/**
 * One appointment `title` at [startAt, endAt) for every member (see the header). Refused (conflict / unavailable,
 * nothing written) when a member is busy with something fixed then or cannot be reached.
 */
export async function bookTogether(s: MemberServices, members: readonly Member[], title: string, span: Span, agentId: string, tz: string, signal?: AbortSignal): Promise<Booked[]> {
  const problems: string[] = [];
  await Promise.all(members.map(async (member) => {
    try {
      const available = await availability(s, member, span.startAt, span.endAt, 'busy', signal);
      const hit = available.fixed.find((fixed) => overlaps(fixed, span));
      if (hit) problems.push(`${member.name} is busy then (${spanText(hit.startAt, hit.endAt, tz)})`);
    } catch (error) { problems.push(`${member.name}: ${why(error)}`); }
  }));
  if (problems.length) throw new WorkforceError('conflict', `${problems.join('; ')}. Nothing was booked – calendar.find_free with who finds a time that fits everyone.`);
  const out: Booked[] = [];
  for (const member of members) {
    try {
      if (member.where === 'linked') {
        const answer = await askPeer(s, member.deviceId, { op: 'add', title, startAt: span.startAt, endAt: span.endAt }, { name: member.name, pc: member.pc }, signal);
        out.push({ who: member.who, name: member.name, ...(answer.event ? { eventId: answer.event.id } : {}), note: `in their calendar on ${member.pc}` });
      } else if (member.where === 'here') {
        const event = await writeHere(s, member.ownerId, title, span, agentId);
        out.push({ who: member.who, name: member.name, eventId: event.id, ...(member.room ? { note: 'booked in Autark; the room\'s own calendar is read-only from here' } : {}) });
      }
    } catch (error) { out.push({ who: member.who, name: member.name, error: why(error) }); }
  }
  return out;
}

/**
 * calendar.person (the owner opens a person's page – "the CEO sees the employees' calendars"): the entries of
 * [from, to) from the person's own PC (masked there) or this PC's rows of theirs (an "Only me" to-do as "Busy");
 * busy spans as "Busy" where only those come back; unreachable: why.
 */
export async function personCalendar(s: MemberServices & Partial<Pick<RuntimeServices, 'tasks'>>, member: Member, from: number, to: number, signal?: AbortSignal): Promise<PersonCalendar> {
  if (member.where === 'none') return { reachable: false, note: `No calendar of ${member.name} is reachable from this PC – their own PC is not linked here.`, entries: [] };
  try {
    const available = await availability(s, member, from, to, 'list', signal);
    const busy = (): PersonCalendarEntry[] => available.busy.map((span) => ({ title: 'Busy', startAt: span.startAt, endAt: span.endAt, kind: 'event' }));
    let entries: PersonCalendarEntry[];
    if (available.entries) entries = available.entries;
    else if (available.rows) {
      entries = available.rows.map((row) => {
        let title = row.title ?? '';
        if (row.kind === 'todo') {
          let task;
          try { task = row.taskId ? s.tasks?.get(row.taskId) : undefined; } catch { task = undefined; }
          title = task && !task.private ? task.title : 'Busy';
        }
        return { title: title || 'Busy', startAt: row.startAt, endAt: row.endAt, kind: row.kind === 'todo' ? 'to-do' : 'event', ...(row.allDay ? { allDay: true as const } : {}) };
      });
    } else entries = busy();
    return { reachable: true, tz: available.tz, entries: entries.sort((a, b) => a.startAt - b.startAt).slice(0, 200) };
  } catch (error) { return { reachable: false, note: why(error), entries: [] }; }
}

/** An agent's appointment in `ownerId`'s calendar on this PC (never over their fixed rows). */
async function writeHere(s: MemberServices, ownerId: string, title: string, span: Span, agentId: string): Promise<CalendarEvent> {
  const calendar = s.calendar;
  if (!calendar) throw new WorkforceError('unavailable', 'The calendar is not available.');
  if (calendar instanceof CalendarServiceImpl) {
    calendar.refuseFixed(ownerId, span);
    return calendar.insert({ ...calendar.fresh(ownerId, 'event', 'agent', agentId, span.startAt, span.endAt), title });
  }
  if (ownerId !== HUMAN_ID) throw new WorkforceError('unavailable', 'This calendar takes appointments for the person only.');
  return (await calendar.add({ text: title, startAt: span.startAt, endAt: span.endAt, kind: 'event' }, agentId)).event;
}
