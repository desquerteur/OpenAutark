// The agents' one `when` shape (B-044, schedules.message/remind/routine/update) → a ScheduleSpec,
// mirroring the person's dialog: { once: "<ISO or +2h>" } or { repeat: { every | times | cron,
// days, window, start, until, count, ifMissed } }. A time without a zone ("2026-10-26T09:00") is
// read in the profile time zone (`tz` overrides), relative forms ("+2h", "PT30M", "2d") from now;
// an interval is anchored at its start (default: now + one interval), so every list and preview
// shows the real runs. Also the rule in a few words and zone-offset ISO times for tool results.
// Owns: that translation and wording. Never: stores or fires schedules (the scheduler does).

import type { ScheduleSpec } from '../../shared/model/tasks.ts';
import { parseWhen } from '../tools/builtin/util.ts';
import { MAX_TIMES, isOneOff, localParts, nextDate, nextFire, validateSpec, wallInstant } from './spec.ts';

export interface WhenArgs {
  once?: string;
  repeat?: RepeatArgs;
  tz?: string;
}

export interface RepeatArgs {
  every?: string;
  times?: string[];
  days?: string[];
  window?: { from: string; to: string };
  cron?: string;
  start?: string;
  until?: string;
  count?: number;
  ifMissed?: 'once' | 'all' | 'skip';
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOCK = { type: 'string', description: 'HH:MM' };

/** The tool schema of `when` (one object; exactly one of once / repeat is checked in code). */
export const WHEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Either {"once": …} or {"repeat": {…}}. Times without a zone are in the profile time zone.',
  properties: {
    once: { type: 'string', description: 'One time: ISO datetime ("2026-10-26T09:00") or from now ("+2h", "PT30M", "2d").' },
    repeat: {
      type: 'object', additionalProperties: false,
      description: 'Recurring: give one of every, times or cron.',
      properties: {
        every: { type: 'string', description: 'Interval: "30m", "2h", "1d", "2w".' },
        times: { type: 'array', items: CLOCK, minItems: 1, maxItems: MAX_TIMES, description: 'Clock times each day, e.g. ["09:00", "13:30", "18:00"].' },
        days: { type: 'array', items: { type: 'string', enum: DAY_NAMES }, minItems: 1, maxItems: 7, description: 'Only on these weekdays.' },
        window: { type: 'object', properties: { from: CLOCK, to: CLOCK }, required: ['from', 'to'], additionalProperties: false, description: 'Only between these times.' },
        cron: { type: 'string', description: '5-field cron, e.g. "0 18 * * 1" (local time).' },
        start: { type: 'string', description: 'First run not before (ISO or from now); default now.' },
        until: { type: 'string', description: 'Last day or time (ISO date/datetime or from now).' },
        count: { type: 'integer', minimum: 1, maximum: 10_000, description: 'Runs in total.' },
        ifMissed: { type: 'string', enum: ['once', 'all', 'skip'], description: 'If the PC was off: one late run (default), every missed run, or skip.' },
      },
    },
    tz: { type: 'string', description: 'IANA time zone; default the profile time zone.' },
  },
} as const;

const SHAPE = 'Give when: {"once": "<time>"} or {"repeat": {"every" | "times" | "cron": …}}.';
const ZONELESS = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EVERY = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** A point in time: a zone-less ISO date/datetime in `tz`, else parseWhen (offset ISO, duration, "+2h"). */
export function parsePoint(value: string, now: number, tz?: string): number | undefined {
  const text = value.trim();
  const local = ZONELESS.exec(text);
  if (local) {
    const [, date, h, m, s] = local;
    const minute = h === undefined ? 0 : Number(h) * 60 + Number(m);
    if (Number(h ?? 0) > 23 || Number(m ?? 0) > 59 || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return undefined;
    return wallInstant(date, minute, tz) + Number(s ?? 0) * 1000;
  }
  return parseWhen(text, now);
}

/** "30m", "2 hours", "1d", "2w" → ms (undefined when unreadable). */
export function parseEvery(value: string): number | undefined {
  const match = EVERY.exec(value.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2][0].toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
}

/** "9:00" → "09:00"; undefined when not a clock time. */
function clock(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** Builds and validates a spec from the tool's `when`; returns an error line when unusable. */
export function specFromWhen(when: WhenArgs | undefined, now: number, profileTz?: string): ScheduleSpec | string {
  if (!when || typeof when !== 'object' || (when.once === undefined) === (when.repeat === undefined)) return SHAPE;
  const tz = when.tz || profileTz || undefined;
  if (tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return 'Unknown time zone.'; }
  }
  if (when.once !== undefined) {
    const at = parsePoint(when.once, now, tz);
    if (at === undefined) return `Cannot read the time "${when.once}".`;
    if (at < now - 60_000) return 'That time is in the past.';
    return { at, tz, catchUp: 'once' };
  }
  const repeat = when.repeat!;
  const kinds = [repeat.every, repeat.times, repeat.cron].filter((value) => value !== undefined).length;
  if (kinds !== 1) return kinds ? 'Use only one of "every", "times" and "cron".' : 'A repeat needs "every", "times" or "cron".';
  const spec: ScheduleSpec = { tz };
  const start = repeat.start !== undefined ? parsePoint(repeat.start, now, tz) : undefined;
  if (repeat.start !== undefined && start === undefined) return `Cannot read the start "${repeat.start}".`;
  if (repeat.every !== undefined) {
    const every = parseEvery(repeat.every);
    if (every === undefined) return `Cannot read "every": "${repeat.every}" (use e.g. "30m", "2h", "1d", "2w").`;
    if (every < 60_000) return 'Repeat at most every minute.';
    spec.everyMs = every;
    spec.at = start ?? now + every; // anchored: lists and previews show the real runs
  } else if (repeat.times !== undefined) {
    const times = repeat.times.map(clock);
    if (times.some((time) => time === undefined)) return '"times" must be clock times like "09:00".';
    spec.times = [...new Set(times as string[])].sort();
  } else {
    spec.cron = repeat.cron!.trim();
  }
  if (spec.everyMs === undefined && start !== undefined && start > now) spec.at = start;
  if (repeat.days !== undefined) {
    const days = repeat.days.map((day) => DAY_NAMES.indexOf(day.slice(0, 3).toLowerCase()));
    if (!days.length || days.some((day) => day < 0)) return '"days" must be weekday names like "mon".';
    spec.days = [...new Set(days)].sort((a, b) => a - b);
  }
  if (repeat.window) spec.window = { from: clock(repeat.window.from) ?? repeat.window.from, to: clock(repeat.window.to) ?? repeat.window.to };
  if (repeat.until !== undefined) {
    const text = repeat.until.trim();
    const until = DATE_ONLY.test(text) ? wallInstant(nextDate(text), 0, tz) - 1 : parsePoint(text, now, tz); // a date: its whole local day
    if (until === undefined) return `Cannot read "until": "${repeat.until}".`;
    spec.until = until;
  }
  if (repeat.count !== undefined) spec.maxRuns = repeat.count;
  spec.catchUp = repeat.ifMissed ?? 'once';
  const error = validateSpec(spec);
  if (error) return error;
  if (nextFire(spec, now) === undefined) return 'That schedule never fires.';
  return spec;
}

/** ISO time with the zone's offset ("2026-10-26T09:00+01:00"); UTC without a zone. */
export function isoIn(ms: number, tz?: string): string {
  const local = localParts(ms, tz);
  const [y, mo, d] = local.date.split('-').map(Number);
  const offset = Math.round((Date.UTC(y, mo - 1, d) + local.minutes * 60_000 - Math.floor(ms / 60_000) * 60_000) / 60_000);
  const hh = String(Math.floor(local.minutes / 60)).padStart(2, '0');
  const mm = String(local.minutes % 60).padStart(2, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const zone = offset === 0 ? 'Z' : `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${local.date}T${hh}:${mm}${zone}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function everyText(ms: number): string {
  for (const [unit, size] of [['w', 604_800_000], ['d', 86_400_000], ['h', 3_600_000]] as const) if (ms % size === 0) return `every ${ms / size}${unit}`;
  return `every ${Math.round(ms / 60_000)}m`;
}

/** The rule in a few words: "once 2026-10-26T09:00+01:00", "daily at 09:00, 13:30 on Mon, Tue · until …". */
export function ruleWords(spec: ScheduleSpec): string {
  if (isOneOff(spec)) return `once ${isoIn(spec.at!, spec.tz)}`;
  const base = spec.cron !== undefined ? `cron "${spec.cron}"` : spec.times ? `daily at ${spec.times.join(', ')}` : spec.everyMs ? everyText(spec.everyMs) : 'once';
  const parts = [spec.days ? `${base} on ${spec.days.map((day) => WEEKDAYS[day]).join(', ')}` : base];
  if (spec.window) parts.push(`between ${spec.window.from}–${spec.window.to}`);
  if (spec.except?.length) parts.push(`skips ${spec.except.length} date${spec.except.length === 1 ? '' : 's'}`);
  if (spec.maxRuns !== undefined) parts.push(`${spec.maxRuns} runs in total`);
  if (spec.until !== undefined) parts.push(`until ${isoIn(spec.until, spec.tz)}`);
  if (spec.catchUp && spec.catchUp !== 'once') parts.push(`if missed: ${spec.catchUp}`);
  return parts.join(' · ');
}
