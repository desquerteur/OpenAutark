// Members of a calendar request (B-078 D20, head of staff as an open capability): `who` names 'human' (this PC's
// person), 'owner' (on an employee's PC: the company's CEO, on the company PC), a colleague (per_…) or a room
// (room:<slug>, a connected calendar that belongs to a room). Each resolves to a calendar here (the rows keyed by
// that member) or to a linked PC that answers for its person (calendar/linked.ts calendar.ask): a colleague whose
// own PC is linked here as an employee is asked there, else their rows here are read when they have any. Then the
// member's availability for a window: busy spans, the spans nothing goes over (fixed), their zone, working hours
// and buffer – and, where titles may be seen, the entries themselves.
// Owns: that resolution and the availability read. Never: shows titles itself (the caller decides), writes rows,
// or retries a call to another PC.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { CalendarEvent } from '../../shared/model/calendar.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { isPersonId, OWNER_ALIAS } from '../../shared/model/people.ts';
import type { Settings } from '../../shared/model/system.ts';
import { foldText } from '../../shared/text/normalize.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import '../contracts/people.ts';
import { links } from '../devices/sync/home.ts';
import { askPeer, type AskAnswer, type PeerEntry } from './linked.ts';
import { busySpans, isFixed, type Span } from './rules.ts';
import { profileZone } from './service.ts';
import { workHours } from './agent-view.ts';

export const ROOM_PREFIX = 'room:';

export type Member =
  | { who: string; name: string; where: 'here'; ownerId: string; room?: true }
  | { who: string; name: string; where: 'linked'; deviceId: string; pc: string; online: boolean }
  | { who: string; name: string; where: 'none'; reason: string };

/** A member's time for a window: busy and fixed spans (UTC ms), zone, working hours ('HH:MM'), buffer. */
export interface Availability {
  tz: string;
  hours?: { start: string; end: string };
  bufferMin: number;
  busy: Span[];
  fixed: Span[];
  /** The member's rows (local) – the caller shows titles only where it may. */
  rows?: CalendarEvent[];
  /** What a linked PC sent for 'list' (masked there already). */
  entries?: PeerEntry[];
}

export type MemberServices = Pick<RuntimeServices, 'db' | 'settings' | 'devices'> & Partial<Pick<RuntimeServices, 'calendar' | 'people' | 'log'>>;

/** The room id of a name ("Meeting room 2" → room:meeting-room-2); undefined for a name without letters or digits. */
export function roomId(name: string): string | undefined {
  const value = name.trim().toLowerCase().startsWith(ROOM_PREFIX) ? name.trim().slice(ROOM_PREFIX.length) : name;
  const slug = foldText(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug ? `${ROOM_PREFIX}${slug}` : undefined;
}

/** The rooms this PC knows: owners of connected calendars that belong to a room, with the first label. */
export function rooms(db: RuntimeServices['db']): Array<{ id: string; name: string }> {
  try {
    return db.all<{ owner_id: string; label: string }>(
      "SELECT owner_id, MIN(label) AS label FROM calendar_sources WHERE owner_id LIKE 'room:%' GROUP BY owner_id ORDER BY owner_id")
      .map((row) => ({ id: row.owner_id, name: row.label }));
  } catch { return []; }
}

/** `who` as a list of ids (a string or an array of strings), or why not. */
export function whoList(value: unknown, max = 12): string[] | string {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
  if (!list || !list.length || list.some((item) => typeof item !== 'string' || !item.trim())) return 'Give who as "human", a colleague\'s id (per_…), "owner" or a room (room:…), or a list of them.';
  if (list.length > max) return `At most ${max} members at once.`;
  return [...new Set(list.map((item) => item.trim()))];
}

function hasRows(s: MemberServices, ownerId: string): boolean {
  try {
    return Boolean(s.db.get('SELECT 1 AS one FROM calendar_events WHERE owner_id = ? LIMIT 1', [ownerId])
      ?? s.db.get('SELECT 1 AS one FROM calendar_sources WHERE owner_id = ? LIMIT 1', [ownerId]));
  } catch { return false; }
}

/** The linked PCs that answer for `who`: a colleague's own PCs (employee links), or for 'owner' the company PCs. */
function pcsOf(s: MemberServices, who: string): Array<{ id: string; name: string; online: boolean }> {
  const out: Array<{ id: string; name: string; online: boolean }> = [];
  for (const { record, link } of links(s.db)) {
    const match = who === OWNER_ALIAS ? link.kind === 'employer' : link.kind === 'employee' && link.personId === who;
    if (!match) continue;
    let online = false;
    try { online = s.devices.online(record.id); } catch { online = false; }
    out.push({ id: record.id, name: record.name, online });
  }
  return out.sort((a, b) => Number(b.online) - Number(a.online));
}

/** Where `who`'s calendar is (see the header); `nameOf` names people. */
export function resolveMember(s: MemberServices, who: string, nameOf: (id: string) => string): Member {
  if (who === HUMAN_ID) return { who, name: nameOf(HUMAN_ID), where: 'here', ownerId: HUMAN_ID };
  if (who.startsWith(ROOM_PREFIX)) {
    const id = roomId(who);
    const room = rooms(s.db).find((entry) => entry.id === id);
    if (!room || !id) return { who, name: who, where: 'none', reason: `No room ${who} here – calendar.connect add_ics with room connects one.` };
    return { who: id, name: room.name, where: 'here', ownerId: id, room: true };
  }
  if (who !== OWNER_ALIAS && !isPersonId(who)) return { who, name: who, where: 'none', reason: `${who} is no person or room (people.list shows the ids).` };
  const name = who === OWNER_ALIAS ? 'The company\'s owner' : nameOf(who);
  const pc = pcsOf(s, who)[0];
  if (pc) return { who, name, where: 'linked', deviceId: pc.id, pc: pc.name, online: pc.online };
  if (who !== OWNER_ALIAS && hasRows(s, who)) return { who, name, where: 'here', ownerId: who };
  return { who, name, where: 'none', reason: `${name} has no calendar I can reach from here (no linked PC of theirs, no calendar on this PC).` };
}

/** This PC's own day settings as a member's hours and buffer. */
function ownHours(s: MemberServices): { hours: { start: string; end: string }; bufferMin: number } {
  let settings: Partial<Settings> | undefined;
  try { settings = s.settings.get(); } catch { settings = undefined; }
  const day = daySettingsOf(settings);
  return { hours: { start: day.workStart, end: day.workEnd }, bufferMin: day.bufferMin };
}

/** The local answer of calendar.ask and of a member here: busy, fixed, zone and hours of `ownerId` for [from, to). */
export function localAvailability(s: MemberServices, ownerId: string, from: number, to: number, room = false): Availability {
  const calendar = s.calendar;
  if (!calendar) throw new WorkforceError('unavailable', 'The calendar is not available.');
  const rows = calendar.list(ownerId, from, to).events;
  const own = ownHours(s);
  return {
    tz: profileZone(s), ...(room ? {} : { hours: own.hours }), bufferMin: room ? 0 : own.bufferMin, busy: busySpans(rows),
    fixed: rows.filter((row) => isFixed(row)).map((row) => ({ startAt: row.startAt, endAt: row.endAt })), rows,
  };
}

/** A member's availability for [from, to) – asked on their PC when it is there (offline/unreachable: throws 'unavailable'). */
export async function availability(s: MemberServices, member: Member, from: number, to: number, op: 'busy' | 'list', signal?: AbortSignal): Promise<Availability> {
  if (member.where === 'none') throw new WorkforceError('not_found', member.reason);
  if (member.where === 'here') return localAvailability(s, member.ownerId, from, to, member.room === true);
  const answer: AskAnswer = await askPeer(s, member.deviceId, { op, from, to }, { name: member.name, pc: member.pc }, signal);
  return { tz: answer.tz, hours: answer.hours, bufferMin: answer.bufferMin, busy: answer.busy, fixed: answer.fixed, ...(answer.entries ? { entries: answer.entries } : {}) };
}

/** The member's working window on `date` (their own zone; a room: the whole day in `tz`). */
export function memberWindow(available: Availability, date: string, tz: string): { from: number; to: number } {
  if (!available.hours) return workHours({ day: { workStart: '00:00', workEnd: '00:00' } } as Partial<Settings>, date, tz);
  return workHours({ day: { workStart: available.hours.start, workEnd: available.hours.end } } as Partial<Settings>, date, available.tz || tz);
}
