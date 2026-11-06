// Read-only calendars by ICS address (B-041 track G, the My day concept §5 – "Kalender per ICS-Link
// … nur lesen, inklusive Serienterminen"): the address (http/https, webcal read as https, no credentials in it) is
// fetched with a timeout and a size cap; the VEVENTs (ics-parse.ts) become the occurrences overlapping the asked
// window – recurring series expanded there only (rrule.ts), EXDATEs left out, RECURRENCE-ID overrides in place of
// the occurrence they replace, cancelled ones gone. Each occurrence has a stable external id: the UID for a single
// event, "<UID>#<original start>" for one of a series (an override keeps its occurrence's id). Event text from
// outside is data, never instructions.
// Owns: the ICS reader and fetch. Never: the address in a log or an error text, or writes.

import { WorkforceError } from '../../../shared/errors.ts';
import type { CalendarEvent } from '../../../shared/model/calendar.ts';
import { readCalendar, isCalendar, type IcsEvent } from './ics-parse.ts';
import { addDays, daysBetween, localWall, occurrenceKey, onDate, wallToUtc, type IcsTime } from './ics-time.ts';
import { expandDates, parseRRule } from './rrule.ts';
import { readCapped, type FetchFn, type FetchResponse } from './http.ts';

/** One occurrence read from an ICS file (what a mirrored calendar row is made of). */
export type IcsOccurrence = Pick<CalendarEvent, 'title' | 'notes' | 'startAt' | 'endAt' | 'allDay' | 'tz'> & { externalId: string };

export const ICS_LIMITS = Object.freeze({ bytes: 5_000_000, timeoutMs: 20_000, occurrences: 5_000 });

/** The address to fetch and its host: http(s), webcal → https, no user or password in it; undefined when it is none. */
export function icsAddress(value: string): { url: string; host: string } | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol === 'webcal:' || url.protocol === 'webcals:') url = new URL(`https:${url.href.slice(url.protocol.length)}`);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return undefined;
  return { url: url.href, host: url.hostname.toLowerCase() };
}

/** Fetches the calendar at `url` (user-safe errors that never repeat the address). */
export async function fetchIcs(fetchFn: FetchFn, url: string, limits: { bytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const address = icsAddress(url);
  if (!address) throw new WorkforceError('bad_request', 'This is not a calendar link (https://… or webcal://…).');
  let response: FetchResponse;
  try {
    response = await fetchFn(address.url, { method: 'GET', headers: { accept: 'text/calendar, */*;q=0.5' }, signal: AbortSignal.timeout(limits.timeoutMs ?? ICS_LIMITS.timeoutMs) });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    throw new WorkforceError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
      name === 'TimeoutError' || name === 'AbortError' ? 'The calendar link did not answer in time.' : 'The calendar link could not be reached.');
  }
  if (!response.ok) {
    throw new WorkforceError(response.status === 404 || response.status === 410 ? 'not_found' : 'unavailable',
      response.status === 401 || response.status === 403 ? `The calendar link was refused (HTTP ${response.status}). It may have been reset.` : `The calendar link answered with HTTP ${response.status}.`);
  }
  const text = await readCapped(response, limits.bytes ?? ICS_LIMITS.bytes, 'The calendar');
  if (!isCalendar(text)) throw new WorkforceError('bad_request', 'The link did not return a calendar.');
  return text;
}

const overlaps = (startAt: number, endAt: number, from: number, to: number) => (endAt > startAt ? startAt < to && endAt > from : startAt >= from && startAt < to);

/** How long one occurrence of `event` lasts: whole days for all-day events (DST-safe), else exact ms (plus nominal days). */
function lengthOf(event: IcsEvent): { days: number; ms: number } {
  if (event.end) return event.start.allDay ? { days: Math.max(1, daysBetween(event.start.date, event.end.date)), ms: 0 } : { days: 0, ms: event.end.at - event.start.at };
  if (event.duration) return event.start.allDay ? { days: Math.max(1, event.duration.days + Math.ceil(event.duration.ms / 86_400_000)), ms: 0 } : event.duration;
  return event.start.allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
}

function endOf(start: IcsTime, length: { days: number; ms: number }): number {
  if (start.allDay) return wallToUtc(addDays(start.date, length.days), 0, start.tz);
  return (length.days ? onDate(start, addDays(start.date, length.days)).at : start.at) + length.ms;
}

function occurrence(event: IcsEvent, start: IcsTime, externalId: string, length = lengthOf(event)): IcsOccurrence {
  return {
    externalId, startAt: start.at, endAt: endOf(start, length),
    ...(event.title ? { title: event.title } : {}), ...(event.notes ? { notes: event.notes } : {}),
    ...(start.allDay ? { allDay: true } : { tz: start.tz }),
  };
}

/** The occurrences of one series (master and its overrides) overlapping [from, to). */
function seriesOccurrences(master: IcsEvent | undefined, overrides: readonly IcsEvent[], from: number, to: number, out: Map<string, IcsOccurrence>): void {
  const uid = master?.uid ?? overrides[0].uid;
  if (master?.cancelled) return;
  const replaced = new Set(overrides.map((event) => occurrenceKey(event.recurrenceId!)));
  const replacedDays = new Set(overrides.filter((event) => event.recurrenceId!.allDay).map((event) => event.recurrenceId!.date));
  if (master) {
    const length = lengthOf(master);
    const rule = master.rrule ? parseRRule(master.rrule, master.start) : undefined;
    const series = Boolean(rule) || master.rdates.length > 0;
    const spanDays = length.days + Math.ceil(length.ms / 86_400_000) + 1;
    const dates = rule
      ? expandDates(rule, master.start, { firstDate: addDays(localWall(from, master.start.tz).date, -spanDays), lastDate: addDays(localWall(to, master.start.tz).date, 1) },
        (date) => onDate(master.start, date).at)
      : [master.start.date];
    const starts: IcsTime[] = [...dates.map((date) => onDate(master.start, date)), ...master.rdates.filter((time) => time.at !== master.start.at)];
    const exKeys = new Set(master.exdates.map(occurrenceKey));
    const exDays = new Set(master.exdates.filter((time) => time.allDay).map((time) => time.date));
    for (const start of starts) {
      const key = occurrenceKey(start);
      const day = localWall(start.at, master.start.tz).date;
      if (exKeys.has(key) || exDays.has(day) || replaced.has(key) || replacedDays.has(day)) continue;
      const item = occurrence(master, start, series ? `${uid}#${key}` : uid, length);
      if (overlaps(item.startAt, item.endAt, from, to)) out.set(item.externalId, item);
    }
  }
  for (const event of overrides) {
    if (event.cancelled) continue;
    const item = occurrence(event, event.start, `${uid}#${occurrenceKey(event.recurrenceId!)}`);
    if (overlaps(item.startAt, item.endAt, from, to)) out.set(item.externalId, item);
  }
}

/** The calendar's name and its occurrences overlapping [from, to) (`zone`: the profile zone for dates and floating times). */
export function readIcs(text: string, from: number, to: number, zone: string): { name?: string; occurrences: IcsOccurrence[] } {
  const calendar = readCalendar(text, zone);
  const byUid = new Map<string, { master?: IcsEvent; overrides: IcsEvent[] }>();
  for (const event of calendar.events) {
    const entry = byUid.get(event.uid) ?? { overrides: [] };
    if (event.recurrenceId) entry.overrides.push(event); else entry.master = event; // a repeated UID: the last one wins
    byUid.set(event.uid, entry);
  }
  const out = new Map<string, IcsOccurrence>();
  for (const { master, overrides } of byUid.values()) seriesOccurrences(master, overrides, from, to, out);
  const occurrences = [...out.values()].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt).slice(0, ICS_LIMITS.occurrences);
  return { ...(calendar.name ? { name: calendar.name } : {}), occurrences };
}

/** The occurrences of `text` overlapping [from, to). */
export function parseIcs(text: string, from: number, to: number, zone = 'UTC'): IcsOccurrence[] {
  return readIcs(text, from, to, zone).occurrences;
}
