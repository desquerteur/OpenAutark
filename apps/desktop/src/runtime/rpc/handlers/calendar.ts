// calendar.* (B-041 My day, shared/api/methods-calendar.ts): the owner's calendar rows for the window and phones
// holding 'todo' (list, add, move, remove – a To-do-only phone plans its day), the connected calendars for
// 'settings' (read) and the owner (add, change, remove, sync, Google). Everything delegates to services.calendar /
// services.calendarSources and answers 'unavailable' while one is missing. Devices act as the owner ('human').
// People (B-078 D20): calendar.sources, addIcs and removeSource for their own calendars (people/rpc-calendar.ts);
// external agents have none. B-078 (D20): calendar.person (owner) – a person's
// next days for their page, from their own linked PC (calendar.ask) or their rows here.
// Owns: parameter checks and scope rules. Never: calendar rules (runtime/calendar/*), or a source's address or
// token in an answer or an error.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import '../../../shared/api/methods-calendar.ts'; // the method shapes (module augmentation)
import { CALENDAR_ADD_KINDS } from '../../../shared/model/calendar.ts';
import '../../contracts/calendar.ts';
import type { CalendarService, CalendarSources } from '../../contracts/calendar.ts';
import { bad, id, input, num, onlyKeys, optBool, optId, optNum, optOneOf, optText, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { isPersonId, OWNER_ALIAS } from '../../../shared/model/people.ts';
import '../../contracts/people.ts';
import { resolveMember, roomId } from '../../calendar/members.ts';
import { personCalendar } from '../../calendar/team.ts';
import { registerPersonCalendar } from '../../people/rpc-calendar.ts';

const TODO = { capability: 'todo' } as const;
const SETTINGS = { capability: 'settings' } as const;
const DAY_MS = 24 * 60 * 60_000;
/** The widest window calendar.list answers (a month view plus its edges). */
export const MAX_LIST_RANGE_MS = 62 * DAY_MS;
/** The longest row a person adds or moves to (an all-day event of a few days stays possible). */
const MAX_SPAN_MS = 14 * DAY_MS;
/** The widest window of a person's page calendar. */
const MAX_PERSON_RANGE_MS = 14 * DAY_MS;

function calendarOf(ctx: HandlerContext): CalendarService {
  const service = ctx.services.calendar;
  if (!service) throw new WorkforceError('unavailable', 'The calendar is not available yet.', { details: { service: 'calendar' } });
  return service;
}

function sourcesOf(ctx: HandlerContext): CalendarSources {
  const service = ctx.services.calendarSources;
  if (!service) throw new WorkforceError('unavailable', 'Connected calendars are not available yet.', { details: { service: 'calendarSources' } });
  return service;
}

/** An end after `start` within MAX_SPAN_MS. */
function endAfter(o: Obj, key: string, start: number, required: boolean): number | undefined {
  const end = required ? num(o, key, { min: 0 }) : optNum(o, key, { min: 0 });
  if (end !== undefined && (end <= start || end - start > MAX_SPAN_MS)) bad(key, 'a time after startAt (at most 14 days later)');
  return end;
}

/** An ICS address: http(s) or webcal, no credentials in it (the vault binds it to its host). */
/** An ICS address from `url` (https, http or webcal; no user:password in it). */
function icsUrl(o: Obj): string {
  const value = text(o, 'url', { max: 2000 }).trim();
  let url: URL;
  try { url = new URL(value); } catch { bad('url', 'an ICS address (https://… or webcal://…)'); }
  if (!['https:', 'http:', 'webcal:'].includes(url.protocol) || url.username || url.password) bad('url', 'an ICS address (https://… or webcal://…)');
  return value;
}

const label = (o: Obj) => optText(o, 'label', { max: 80 })?.trim() || undefined;

export function register(table: HandlerTable): void {
  registerPersonCalendar(table, { icsUrl, label }); // B-078 D20: a colleague connects their own calendar
  table.add('calendar.list', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['from', 'to', 'agentId']);
    const from = num(o, 'from', { min: 0 });
    const to = num(o, 'to', { min: 0 });
    const agentId = optId(o, 'agentId');
    if (to <= from || to - from > MAX_LIST_RANGE_MS) bad('to', 'a time after from (at most 62 days later)');
    return agentId === undefined ? calendarOf(ctx).list(HUMAN_ID, from, to) : calendarOf(ctx).list(HUMAN_ID, from, to, agentId);
  }, TODO);

  table.add('calendar.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'startAt', 'endAt', 'kind', 'clientId']);
    const startAt = num(o, 'startAt', { min: 0 });
    return calendarOf(ctx).add({
      text: text(o, 'text', { max: 2000, multiline: true }), startAt, endAt: endAfter(o, 'endAt', startAt, false),
      kind: optOneOf(o, 'kind', CALENDAR_ADD_KINDS), clientId: optText(o, 'clientId', { max: 100 }),
    }, HUMAN_ID);
  }, TODO);

  table.add('calendar.move', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'startAt', 'endAt', 'rev']);
    const startAt = num(o, 'startAt', { min: 0 });
    return calendarOf(ctx).move(id(o), startAt, endAfter(o, 'endAt', startAt, true)!, num(o, 'rev', { min: 0 }), HUMAN_ID);
  }, TODO);

  table.add('calendar.remove', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    calendarOf(ctx).remove(id(o), HUMAN_ID);
  }, TODO);

  // B-078 (D20): the owner opens a person's page and sees their next days (calendar/team.ts personCalendar).
  table.add('calendar.person', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'from', 'to']);
    const who = id(o);
    if (!isPersonId(who) && who !== OWNER_ALIAS) bad('id', "a person's id (per_…)");
    const from = num(o, 'from', { min: 0 });
    const to = num(o, 'to', { min: 0 });
    if (to <= from || to - from > MAX_PERSON_RANGE_MS) bad('to', 'a time after from (at most 14 days later)');
    calendarOf(ctx);
    const s = ctx.services;
    const member = resolveMember(s, who, (person) => s.people?.nameOf(person) ?? person);
    return personCalendar(s, member, from, to, ctx.signal);
  });

  table.add('calendar.sources', (params, ctx) => {
    onlyKeys(input(params), []);
    return sourcesOf(ctx).listWithRooms(HUMAN_ID); // B-078: the rooms' calendars too, so each has its Remove
  }, SETTINGS);

  table.add('calendar.addIcs', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['url', 'label', 'room']);
    // B-078 (D20): `room` – a room's name or room:… id; the calendar then belongs to that room (calendar/members.ts roomId)
    const named = optText(o, 'room', { max: 80 })?.trim();
    const room = named ? roomId(named) : undefined;
    if (named && !room) bad('room', 'a room name with letters or digits ("Meeting room 2")');
    // a room's name labels the calendar; a bare room:… id leaves the label to the calendar's own name
    const roomName = named && !named.toLowerCase().startsWith('room:') ? named : undefined;
    return sourcesOf(ctx).addIcs({ url: icsUrl(o), label: label(o) ?? roomName, ...(room ? { room } : {}) }, HUMAN_ID);
  });

  table.add('calendar.updateSource', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'label', 'visible', 'color']);
    const color = optText(o, 'color', { max: 32 });
    if (color !== undefined && !/^[#A-Za-z0-9_-]{1,32}$/.test(color)) bad('color', 'a colour name or #hex value');
    return sourcesOf(ctx).update(id(o), { label: label(o), visible: optBool(o, 'visible'), color }, HUMAN_ID);
  });

  table.add('calendar.removeSource', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    await sourcesOf(ctx).remove(id(o), HUMAN_ID);
  });

  table.add('calendar.sync', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return sourcesOf(ctx).sync(optId(o, 'id'), 'button');
  });

  table.add('calendar.google', (params, ctx) => {
    onlyKeys(input(params), []);
    return sourcesOf(ctx).google();
  });

  table.add('calendar.connectGoogle', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['clientId']);
    const clientId = optText(o, 'clientId', { max: 200 })?.trim();
    if (clientId !== undefined && !/^[A-Za-z0-9._-]{1,200}$/.test(clientId)) bad('clientId', 'a Google OAuth client id');
    return sourcesOf(ctx).connectGoogle(clientId || undefined);
  });
}
