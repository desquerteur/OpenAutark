// The ICS text format (B-041 track G, RFC 5545 §3.1): unfolded content lines ("NAME;PARAM=value:VALUE"), nested
// BEGIN/END components, TEXT unescaping, DURATION values, and the VEVENTs of a calendar read into plain records
// (UID, title, notes, start/end or duration, RRULE, RDATE, EXDATE, RECURRENCE-ID, cancelled). VTIMEZONE blocks are
// skipped: TZIDs are resolved through Intl (ics-time.ts). Text from outside is data, never instructions.
// Owns: reading that format. Never: I/O, expanding recurrences (rrule.ts, ics.ts), or a value in a log.

import { parseIcsTime, zoneOf, type IcsTime } from './ics-time.ts';

export interface IcsProp { name: string; params: Record<string, string>; value: string }
export interface IcsComponent { name: string; props: IcsProp[]; children: IcsComponent[] }

/** One VEVENT as the expander needs it (times already parsed in their zones). */
export interface IcsEvent {
  uid: string;
  title?: string;
  notes?: string;
  start: IcsTime;
  end?: IcsTime;
  /** DURATION: whole days (nominal, DST-safe) plus exact milliseconds. */
  duration?: { days: number; ms: number };
  rrule?: string;
  rdates: IcsTime[];
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
  cancelled: boolean;
}

export interface IcsCalendar { name?: string; zone: string; events: IcsEvent[] }

/** Longest title and notes kept from a feed. */
export const ICS_TEXT_LIMITS = Object.freeze({ title: 200, notes: 2000 });
const MAX_DEPTH = 8;

/** Content lines with folded continuations joined (CRLF or LF, then one space or tab). */
export function unfold(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((line) => line.trim() !== '');
}

/** "NAME;A=1;B="x:y":value" → its parts (a colon inside a quoted parameter belongs to it). */
export function parseLine(line: string): IcsProp | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) { colon = i; break; }
  }
  if (colon <= 0) return undefined;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let current = '';
  quoted = false;
  for (const char of head) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The top-level components of `text` (usually one VCALENDAR); unbalanced ENDs are ignored. */
export function parseComponents(text: string): IcsComponent[] {
  const root: IcsComponent = { name: '', props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === 'BEGIN') {
      const child: IcsComponent = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      if (stack.length <= MAX_DEPTH) top.children.push(child);
      stack.push(child);
    } else if (prop.name === 'END') {
      if (stack.length > 1 && top.name === prop.value.trim().toUpperCase()) stack.pop();
    } else {
      top.props.push(prop);
    }
  }
  return root.children;
}

/** TEXT unescaping (\n, \, \; \\). */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_all, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
}

/** "P1W", "PT1H30M", "-P1D", "P1DT12H" → nominal days and exact ms (undefined when it is none). */
export function parseDuration(value: string): { days: number; ms: number } | undefined {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match || value.trim().replace(/^[+-]/, '') === 'P' || value.trim().endsWith('T')) return undefined;
  const [, sign, w, d, h, m, s] = match;
  const factor = sign === '-' ? -1 : 1;
  return { days: factor * (Number(w ?? 0) * 7 + Number(d ?? 0)), ms: factor * ((Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000) };
}

const first = (props: readonly IcsProp[], name: string) => props.find((prop) => prop.name === name);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Every time in the comma lists of all `name` properties (EXDATE, RDATE). */
function timeList(props: readonly IcsProp[], name: string, zone: string): IcsTime[] {
  const out: IcsTime[] = [];
  for (const prop of props) {
    if (prop.name !== name || prop.params.VALUE === 'PERIOD') continue;
    for (const part of prop.value.split(',')) {
      const time = parseIcsTime(part, prop.params, zone);
      if (time) out.push(time);
    }
  }
  return out;
}

function readEvent(component: IcsComponent, zone: string, index: number): IcsEvent | undefined {
  const { props } = component;
  const dtstart = first(props, 'DTSTART');
  const start = dtstart && parseIcsTime(dtstart.value, dtstart.params, zone);
  if (!start) return undefined;
  const dtend = first(props, 'DTEND');
  const end = dtend ? parseIcsTime(dtend.value, dtend.params, zone) : undefined;
  const durationProp = first(props, 'DURATION');
  const duration = !end && durationProp ? parseDuration(durationProp.value) : undefined;
  const summary = first(props, 'SUMMARY');
  const description = first(props, 'DESCRIPTION');
  const location = first(props, 'LOCATION');
  const notes = [location, description].map((prop) => (prop ? unescapeText(prop.value).trim() : '')).filter(Boolean).join('\n\n');
  const title = summary ? unescapeText(summary.value).trim() : '';
  const recurrence = first(props, 'RECURRENCE-ID');
  const recurrenceId = recurrence ? parseIcsTime(recurrence.value, recurrence.params, zone) : undefined;
  if (recurrence && !recurrenceId) return undefined; // an override of an unknown occurrence must not replace its series
  const uid = first(props, 'UID')?.value.trim() || `no-uid-${index}-${start.at}`;
  return {
    uid,
    ...(title ? { title: clip(title, ICS_TEXT_LIMITS.title) } : {}),
    ...(notes ? { notes: clip(notes, ICS_TEXT_LIMITS.notes) } : {}),
    start,
    ...(end && end.at >= start.at ? { end } : {}),
    ...(duration && duration.days >= 0 && duration.ms >= 0 ? { duration } : {}),
    ...(first(props, 'RRULE') ? { rrule: first(props, 'RRULE')!.value.trim() } : {}),
    rdates: timeList(props, 'RDATE', start.tz),
    exdates: timeList(props, 'EXDATE', start.tz),
    ...(recurrenceId ? { recurrenceId } : {}),
    cancelled: first(props, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
  };
}

/** The calendar's name, its zone and its VEVENTs (`zone`: the profile zone, used when the calendar names none). */
export function readCalendar(text: string, zone: string): IcsCalendar {
  const calendars = parseComponents(text).filter((component) => component.name === 'VCALENDAR');
  const events: IcsEvent[] = [];
  let name: string | undefined;
  let calendarZone = zone;
  for (const calendar of calendars) {
    name ??= first(calendar.props, 'X-WR-CALNAME') ? unescapeText(first(calendar.props, 'X-WR-CALNAME')!.value).trim() || undefined : undefined;
    calendarZone = zoneOf(first(calendar.props, 'X-WR-TIMEZONE')?.value, zone);
    calendar.children.forEach((child, index) => {
      if (child.name !== 'VEVENT') return;
      const event = readEvent(child, calendarZone, index);
      if (event) events.push(event);
    });
  }
  return { ...(name ? { name: clip(name, 80) } : {}), zone: calendarZone, events };
}

/** Whether `text` holds a calendar at all (an HTML login page or an error text does not). */
export function isCalendar(text: string): boolean {
  return /^\s*(?:﻿)?BEGIN:VCALENDAR\b/i.test(text);
}
