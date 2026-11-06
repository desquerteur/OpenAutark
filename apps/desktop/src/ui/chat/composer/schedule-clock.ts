// Wall clock in an IANA zone, pure: the local date, time and weekday of an instant and back (Intl,
// DST-correct to the minute), the next calendar day and the end of a local day (My day uses it).
// Owns: these conversions. Never: the process zone or the clock (instants are passed in).

const MIN = 60_000;
const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formats = new Map<string, Intl.DateTimeFormat>();

/** Local date, hour, minute and weekday of `ms` in `tz`. */
export function wallClock(ms: number, tz: string): { date: string; hour: number; minute: number; weekday: number } {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formats.set(tz, format);
  }
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: NAMES.indexOf(p.weekday) };
}

/** Epoch ms of local `date` at hh:mm in `tz` (DST-correct to the minute). */
export function atWallTime(date: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const offset = (ms: number) => {
    const wall = wallClock(ms, tz);
    const [wy, wm, wd] = wall.date.split('-').map(Number);
    return Date.UTC(wy, wm - 1, wd, wall.hour, wall.minute) - Math.floor(ms / MIN) * MIN;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** The calendar day after `date` (YYYY-MM-DD). */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The last millisecond of local `date` in `tz`. */
export function endOfDay(date: string, tz: string): number {
  return atWallTime(nextDate(date), 0, 0, tz) - 1;
}
