// ICS date and time values (B-041 track G, RFC 5545 §3.3.4/§3.3.5): a DATE (all day, read in the profile zone), a
// DATE-TIME in UTC ("…Z"), with a TZID, or floating (the calendar's X-WR-TIMEZONE, else the profile zone). A TZID is
// an IANA name, a vendor prefix around one ("/mozilla.org/…/Europe/Vienna"), or a common Windows/Outlook zone name;
// anything else falls back to the calendar's zone. Wall time ↔ instant goes through Intl, so DST days are exact.
// Owns: these conversions and the small date arithmetic of the recurrence rules. Never: I/O or the clock.

import { localParts } from '../../schedules/spec.ts';

const MIN = 60_000;

/** One parsed value: the local wall time in `tz` (date + seconds after midnight) and its instant. */
export interface IcsTime {
  allDay: boolean;
  date: string; // 'YYYY-MM-DD' in `tz`
  seconds: number; // after local midnight (0 for a date)
  tz: string; // 'UTC' for "…Z" values; the calendar's zone for dates and floating times
  at: number; // epoch ms
}

/** Windows and Outlook zone names seen in exported calendars → the IANA zone with the same rules. */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'w. europe standard time': 'Europe/Berlin', 'central europe standard time': 'Europe/Budapest', 'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris', 'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau', 'fle standard time': 'Europe/Kiev', 'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow', 'turkey standard time': 'Europe/Istanbul', 'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata', 'china standard time': 'Asia/Shanghai', 'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney', 'utc': 'UTC', 'coordinated universal time': 'UTC',
};
/** City names in Outlook's "(UTC+01:00) Amsterdam, Berlin, …" labels → their IANA zone. */
const CITY_ZONES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:berlin|vienna|wien|amsterdam|bern|rome?|stockholm)\b/i, 'Europe/Berlin'], [/\b(?:brussels|paris|madrid|copenhagen)\b/i, 'Europe/Paris'],
  [/\b(?:london|dublin|lisbon)\b/i, 'Europe/London'], [/\b(?:prague|budapest|belgrade)\b/i, 'Europe/Budapest'], [/\beastern time\b/i, 'America/New_York'],
  [/\bcentral time\b/i, 'America/Chicago'], [/\bmountain time\b/i, 'America/Denver'], [/\bpacific time\b/i, 'America/Los_Angeles'],
];

const known = new Map<string, boolean>();

/** Whether Intl knows the zone `tz`. */
export function isZone(tz: string | undefined): boolean {
  if (!tz) return false;
  let ok = known.get(tz);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); ok = true; } catch { ok = false; }
    known.set(tz, ok);
  }
  return ok;
}

/** The IANA zone a TZID names (see the header), else `fallback`. */
export function zoneOf(tzid: string | undefined, fallback: string): string {
  const raw = tzid?.trim().replace(/^"|"$/g, '');
  if (!raw) return fallback;
  if (isZone(raw)) return raw;
  const tail = /([A-Z][A-Za-z]+(?:\/[A-Za-z_+-]+){1,2})$/.exec(raw)?.[1];
  if (tail && isZone(tail)) return tail;
  const windows = WINDOWS_ZONES[raw.toLowerCase()];
  if (windows) return windows;
  return CITY_ZONES.find(([pattern]) => pattern.test(raw))?.[1] ?? fallback;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** 'YYYY-MM-DD' of a UTC calendar day. */
export function dateOf(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function splitDate(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = splitDate(date);
  return dateOf(y, m, d + days);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whole days from `a` to `b` (calendar dates). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = splitDate(a);
  const [by, bm, bd] = splitDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The local wall time of `at` in `tz`. */
export function localWall(at: number, tz: string): { date: string; seconds: number } {
  const parts = localParts(at, tz);
  return { date: parts.date, seconds: parts.minutes * 60 + Math.floor((((at % MIN) + MIN) % MIN) / 1000) };
}

/** The instant of the wall time `seconds` after local midnight of `date` in `tz` (a time a DST change skips moves on by the gap). */
export function wallToUtc(date: string, seconds: number, tz: string): number {
  const [y, m, d] = splitDate(date);
  const wall = Date.UTC(y, m - 1, d) + seconds * 1000;
  if (tz === 'UTC') return wall;
  const offset = (ms: number) => {
    const local = localParts(ms, tz);
    const [ly, lm, ld] = splitDate(local.date);
    return Date.UTC(ly, lm - 1, ld) + local.minutes * MIN - Math.floor(ms / MIN) * MIN;
  };
  return wall - offset(wall - offset(wall));
}

/**
 * A DATE or DATE-TIME value with its TZID / VALUE parameters. `zone` is the calendar's zone (X-WR-TIMEZONE or the
 * profile zone) for dates, floating times and unknown TZIDs. Undefined when the value is not one.
 */
export function parseIcsTime(value: string, params: Readonly<Record<string, string>>, zone: string): IcsTime | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return undefined;
  const [, ys, ms, ds, hh, mm, ss, z] = match;
  const date = dateOf(Number(ys), Number(ms), Number(ds));
  if (date !== `${ys}-${ms}-${ds}`) return undefined; // 2026-02-30 and the like
  if (hh === undefined || params.VALUE === 'DATE') return { allDay: true, date, seconds: 0, tz: zone, at: wallToUtc(date, 0, zone) };
  const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss ?? 0);
  if (seconds >= 86_400) return undefined;
  const tz = z ? 'UTC' : zoneOf(params.TZID, zone);
  return { allDay: false, date, seconds, tz, at: wallToUtc(date, seconds, tz) };
}

/** The same wall time on another local date (recurrences keep the time of day in their zone). */
export function onDate(start: IcsTime, date: string): IcsTime {
  return { ...start, date, at: wallToUtc(date, start.seconds, start.tz) };
}

/** The stable key of an occurrence for EXDATE / RECURRENCE-ID matching and external ids ("20261029T080000Z" or "20261029"). */
export function occurrenceKey(time: Pick<IcsTime, 'allDay' | 'date' | 'at'>): string {
  if (time.allDay) return time.date.replace(/-/g, '');
  return new Date(time.at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
