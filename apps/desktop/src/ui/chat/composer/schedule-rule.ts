// A schedule's rule in a few English words, pure: "every Monday at 09:00", "every 2 hours", "every weekday at 09:00 until
// 30 Nov", "tomorrow at 09:30". The composer's preview line says "Sends <rule>, next: …", the Chat details list
// shows the same words (capitalised). A simple cron rule ("0 9 * * 1") is read back as weekdays and a time; any other
// stays a cron rule. Days and dates are written the same way for everyone (the UI's words are English).
// Owns: that wording. Never: RPC, DOM or the clock (`now` is passed in) – the form → spec step is schedule-form.ts.

import type { ScheduleSpec } from '../../../shared/model/tasks.ts';
import { nextDate, wallClock } from './schedule-clock.ts';
import { splitEvery } from './schedule-form.ts';

const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Monday first, the way a week reads. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const two = (value: number): string => String(value).padStart(2, '0');

export interface RuleOptions {
  /** The zone the rule's clock times and dates are read in (default: the spec's, else UTC). */
  tz?: string;
  now?: number;
}

/** "Tue 3 Nov" (with the year when it is not the current one). */
function dayText(date: string, thisYear: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${SHORT[weekday]} ${day} ${MONTH[month - 1]}${String(year) === thisYear ? '' : ` ${year}`}`;
}

/** "Tue 3 Nov 14:00" – the time only when it is not the day's start (or, for an end, its last minute). */
function pointText(ms: number, tz: string, now: number, edge: 'start' | 'end'): string {
  const { date, hour, minute } = wallClock(ms, tz);
  const day = dayText(date, wallClock(now, tz).date.slice(0, 4));
  const whole = edge === 'start' ? hour === 0 && minute === 0 : hour === 23 && minute === 59;
  return whole ? day : `${day} ${two(hour)}:${two(minute)}`;
}

/** The weekdays as words: "every Monday" before a time ("at 09:00"), "on Mondays" after an interval ('' = every day). */
function weekdaysText(days: number[] | undefined, after: 'time' | 'interval'): string {
  const sorted = WEEK_ORDER.filter((day) => days?.includes(day));
  const time = after === 'time';
  if (!days || sorted.length === 0 || sorted.length === 7) return time ? 'every day' : '';
  if (sorted.join() === '1,2,3,4,5') return time ? 'every weekday' : 'on weekdays';
  if (sorted.join() === '6,0') return time ? 'every weekend' : 'on weekends';
  if (sorted.length === 1) return time ? `every ${LONG[sorted[0]]}` : `on ${LONG[sorted[0]]}s`;
  return `on ${sorted.map((day) => SHORT[day]).join(', ')}`;
}

/** "m h * * dow" with numbers → the time and weekdays; undefined for any other cron rule. */
function simpleCron(cron: string): { times: string[]; days?: number[] } | undefined {
  const field = cron.trim().split(/\s+/);
  if (field.length !== 5) return undefined;
  const [minute, hour, dom, month, dow] = field;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || Number(minute) > 59 || Number(hour) > 23 || dom !== '*' || month !== '*') return undefined;
  const times = [`${two(Number(hour))}:${two(Number(minute))}`];
  if (dow === '*') return { times };
  const range = /^([0-7])-([0-7])$/.exec(dow);
  let days: number[] | undefined;
  if (range && Number(range[1]) <= Number(range[2])) days = Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index);
  else if (/^[0-7](,[0-7])*$/.test(dow)) days = dow.split(',').map(Number);
  if (!days) return undefined;
  return { times, days: [...new Set(days.map((day) => day % 7))].sort((a, b) => a - b) };
}

/** "Every 2 hours" words for an interval. */
function everyText(ms: number): string {
  const { n, unit } = splitEvery(ms);
  const one = unit.slice(0, -1);
  return n === 1 ? `every ${one}` : `every ${n} ${unit}`;
}

/** The rule in lower case words (the first letter is the caller's: "Sends …" / capital for a list). */
export function ruleWords(spec: ScheduleSpec, options: RuleOptions = {}): string {
  const tz = options.tz || spec.tz || 'UTC';
  const now = options.now ?? Date.now();
  if (!repeats(spec)) {
    if (spec.at === undefined) return 'never';
    const { date, hour, minute } = wallClock(spec.at, tz);
    const today = wallClock(now, tz).date;
    const when = date === today ? 'today' : date === nextDate(today) ? 'tomorrow' : `on ${dayText(date, today.slice(0, 4))}`;
    return `${when} at ${two(hour)}:${two(minute)}`;
  }
  let words: string;
  const cron = spec.cron !== undefined ? simpleCron(spec.cron) : undefined;
  if (spec.everyMs !== undefined) {
    words = everyText(spec.everyMs);
    words = [words, weekdaysText(spec.days, 'interval')].filter(Boolean).join(' ');
  } else if (spec.times || cron) {
    const days = spec.times ? spec.days : cron?.days;
    words = `${weekdaysText(days, 'time')} at ${(spec.times ?? cron!.times).join(', ')}`;
  } else {
    words = `on the cron rule ${spec.cron}`;
  }
  if (spec.window) words += ` between ${spec.window.from}–${spec.window.to}`;
  // For an interval `at` is the grid's anchor (the next run says when), for the others "not before".
  if (spec.at !== undefined && spec.everyMs === undefined && spec.at > now) words += ` from ${pointText(spec.at, tz, now, 'start')}`;
  if (spec.until !== undefined) words += ` until ${pointText(spec.until, tz, now, 'end')}`;
  if (spec.maxRuns !== undefined) words += `, ${spec.maxRuns} runs in all`;
  if (spec.except?.length) words += `, skipping ${spec.except.length} date${spec.except.length === 1 ? '' : 's'}`;
  return words;
}

/** The list's line: capital first letter. */
export function ruleLine(spec: ScheduleSpec, options: RuleOptions = {}): string {
  const words = ruleWords(spec, options);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Is this a rule that repeats (the list shows its words; a one-off only has its next run)? */
export function repeats(spec: ScheduleSpec | null): boolean {
  return !!spec && (spec.cron !== undefined || spec.everyMs !== undefined || spec.times !== undefined);
}
