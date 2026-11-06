// What a person's device may call about calendars (B-078 D20, owner 06.11.: "bei den Mitarbeitern, die sollen einfach
// ihren eigenen Kalender connecten"): a colleague who joined by phone or browser connects their own ICS calendar, so
// the head of staff's free/busy for them (calendar.find_free who, calendar/members.ts) sees their real appointments.
//  * calendar.sources lists only their own calendars (owner = their person id);
//  * calendar.addIcs adds one for them (no room: rooms are the owner's to connect);
//  * calendar.removeSource removes only one of their own.
// The link sits in the PC's vault like the owner's (the app's own secret, never shown). Every call first checks that
// the person's access still holds (rpc-base.ts caller).
// Owns: these variants. Never: the owner's or a room's calendars, Google sign-ins, or a source's address in an answer.

import { WorkforceError } from '../../shared/errors.ts';
import type { CalendarSources } from '../contracts/calendar.ts';
import '../contracts/calendar.ts';
import { id, input, onlyKeys, type Obj } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { caller } from './rpc-base.ts';

/** The owner's parameter checks (rpc/handlers/calendar.ts), passed in so both read a link alike. */
export interface CalendarParams { icsUrl(o: Obj): string; label(o: Obj): string | undefined }

function sourcesOf(ctx: HandlerContext): CalendarSources {
  const service = ctx.services.calendarSources;
  if (!service) throw new WorkforceError('unavailable', 'Connected calendars are not available yet.', { details: { service: 'calendarSources' } });
  return service;
}

export function registerPersonCalendar(table: HandlerTable, params: CalendarParams): void {
  table.addPerson('calendar.sources', (raw, ctx) => {
    onlyKeys(input(raw), []);
    return sourcesOf(ctx).list(caller(ctx).id);
  });
  table.addPerson('calendar.addIcs', (raw, ctx) => {
    const person = caller(ctx);
    const o = input(raw);
    onlyKeys(o, ['url', 'label']);
    return sourcesOf(ctx).addIcs({ url: params.icsUrl(o), label: params.label(o) }, person.id);
  });
  table.addPerson('calendar.removeSource', async (raw, ctx) => {
    const person = caller(ctx);
    const o = input(raw);
    onlyKeys(o, ['id']);
    const sourceId = id(o);
    const sources = sourcesOf(ctx);
    if (!sources.list(person.id).some((source) => source.id === sourceId)) throw new WorkforceError('not_found', 'Calendar not found.', { details: { id: sourceId } });
    await sources.remove(sourceId, person.id);
  });
}
