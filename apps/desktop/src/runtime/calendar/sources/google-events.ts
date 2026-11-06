// Google Calendar events ↔ My day's rows (B-041 track G): an event of the person's calendar becomes a read-only
// occurrence (all-day dates in the profile zone, timed ones by their RFC 3339 instant; cancelled ones, ones the
// person declined and the app's own mirrors are none – they would show twice), and a local row (a to-do block or an
// event made in the app) becomes the body of its mirror in the "Workforce" calendar: the to-do's title (an
// "Only me" to-do shows as "Busy" – no private text leaves the PC), "✓ " once done, and
// extendedProperties.private {eventId, taskId, pcId} to know it again. Its Google id is derived from the PC and the
// row id (base32hex-safe hex), so no mapping table is needed and a retry never makes a second copy.
// Owns: these pure mappings. Never: I/O, or task text beyond the title of the to-do a block belongs to.

import { createHash } from 'node:crypto';
import type { CalendarEvent } from '../../../shared/model/calendar.ts';
import type { SourceOccurrence } from './apply.ts';
import { ICS_TEXT_LIMITS } from './ics-parse.ts';
import { addDays, localWall, wallToUtc } from './ics-time.ts';

export interface GoogleTime { date?: string; dateTime?: string; timeZone?: string }
export interface GoogleEvent {
  id: string;
  status?: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  recurringEventId?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}
export interface GoogleEventBody {
  summary: string;
  start: GoogleTime;
  end: GoogleTime;
  extendedProperties: { private: Record<string, string> };
  transparency?: 'opaque' | 'transparent';
}

/** The summary of the app's own calendar in Google. */
export const WORKFORCE_CALENDAR = 'Autark';
const DONE_MARK = '✓ ';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Google's HTML descriptions as plain text (line breaks kept, tags and the common entities gone). */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** The app's Google event id for a local row on this PC (lower-case hex is valid base32hex). */
export function mirrorId(pcId: string, rowId: string): string {
  return createHash('sha256').update(`${pcId}:${rowId}`).digest('hex').slice(0, 40);
}

/** Whether the event is one of the app's own mirrors (made by this PC or another one). */
export function isMirror(event: GoogleEvent): boolean {
  return Boolean(event.extendedProperties?.private?.pcId && event.extendedProperties.private.eventId);
}

function instant(time: GoogleTime | undefined, zone: string): { at: number; date?: string } | undefined {
  if (time?.date && /^\d{4}-\d{2}-\d{2}$/.test(time.date)) return { at: wallToUtc(time.date, 0, zone), date: time.date };
  const at = time?.dateTime ? Date.parse(time.dateTime) : NaN;
  return Number.isFinite(at) ? { at } : undefined;
}

/** The occurrence a Google event is in My day (undefined: cancelled, declined, a mirror of the app, or no readable time). */
export function occurrenceOf(event: GoogleEvent, zone: string): SourceOccurrence | undefined {
  if (!event.id || event.status === 'cancelled' || isMirror(event)) return undefined;
  if (event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined')) return undefined;
  const start = instant(event.start, zone);
  const end = instant(event.end, zone);
  if (!start) return undefined;
  const allDay = start.date !== undefined;
  const endAt = end && end.at >= start.at ? end.at : allDay ? wallToUtc(addDays(start.date!, 1), 0, zone) : start.at;
  const notes = [event.location?.trim(), event.description ? plainText(event.description) : ''].filter(Boolean).join('\n\n');
  const title = event.summary?.trim();
  return {
    externalId: event.id, startAt: start.at, endAt,
    ...(title ? { title: clip(title, ICS_TEXT_LIMITS.title) } : {}), ...(notes ? { notes: clip(notes, ICS_TEXT_LIMITS.notes) } : {}),
    ...(allDay ? { allDay: true } : event.start?.timeZone ? { tz: event.start.timeZone } : {}), ...(event.etag ? { etag: event.etag } : {}),
  };
}

/** Whether a local row is mirrored to Google: the app's own rows of the owner (to-do blocks and events), not mirrored ones. */
export function mirrored(row: Pick<CalendarEvent, 'sourceId' | 'readOnly'>): boolean {
  return row.sourceId === 'local' && !row.readOnly;
}

/**
 * The mirror's body: `title` is the to-do's title for a block (undefined: it was removed; `privateTodo`: "Only me"),
 * the row's own title for an event.
 */
export function mirrorBody(row: CalendarEvent, input: { title?: string; privateTodo?: boolean; pcId: string; zone: string }): GoogleEventBody {
  const base = row.kind === 'todo' ? (input.privateTodo ? 'Busy' : input.title?.trim() || 'To-do') : row.title?.trim() || 'Busy';
  const summary = clip(`${row.state === 'planned' ? '' : DONE_MARK}${base}`, 200);
  const tz = row.tz || input.zone;
  const start: GoogleTime = row.allDay ? { date: localWall(row.startAt, input.zone).date } : { dateTime: new Date(row.startAt).toISOString(), timeZone: tz };
  const endDate = row.allDay ? localWall(row.endAt, input.zone).date : undefined;
  const end: GoogleTime = row.allDay ? { date: endDate! > start.date! ? endDate! : addDays(start.date!, 1) } : { dateTime: new Date(Math.max(row.endAt, row.startAt)).toISOString(), timeZone: tz };
  const props: Record<string, string> = { eventId: row.id, pcId: input.pcId };
  if (row.taskId) props.taskId = row.taskId;
  return { summary, start, end, extendedProperties: { private: props }, transparency: 'opaque' };
}

/** Whether the remote event already shows what `body` says (same title and times). */
export function sameMirror(remote: GoogleEvent, body: GoogleEventBody): boolean {
  if (remote.status === 'cancelled' || (remote.summary ?? '') !== body.summary) return false;
  const same = (a: GoogleTime | undefined, b: GoogleTime) => (b.date ? a?.date === b.date : Boolean(a?.dateTime) && Date.parse(a!.dateTime!) === Date.parse(b.dateTime!));
  return same(remote.start, body.start) && same(remote.end, body.end);
}
