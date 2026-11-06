// The composer's schedule mode, pure: the settings block's fields (Once: a date and a time; Repeat: every N
// minutes/hours/days/weeks, or on chosen weekdays at a time, or a cron rule; an optional start and end) become the
// ScheduleSpec messages.schedule takes – the same shapes the agents' `when` builds (runtime/schedules/when.ts) – and an
// existing spec becomes the form again (Edit). Also the quick picks and every error text.
// Owns: the form model, its defaults, the form → spec and spec → form translation. Never: RPC, DOM or the clock (`now`
// is passed in) – the rule in words is schedule-rule.ts.

import type { Schedule, ScheduleSpec } from '../../../shared/model/tasks.ts';
import { atWallTime, endOfDay, nextDate, wallClock } from './schedule-clock.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const UNIT_MS = { minutes: MIN, hours: HOUR, days: DAY, weeks: 7 * DAY } as const;
export type EveryUnit = keyof typeof UNIT_MS;
export const UNITS: readonly EveryUnit[] = ['minutes', 'hours', 'days', 'weeks'];

export type ScheduleKind = 'once' | 'repeat';
/** Repeat: 'days' = on weekdays at a time, 'every' = at intervals, 'cron' = a cron rule (Advanced). */
export type RepeatKind = 'days' | 'every' | 'cron';

export interface ScheduleForm {
  kind: ScheduleKind;
  /** Once: local date YYYY-MM-DD and time HH:MM (what the fields hold). */
  date: string;
  time: string;
  repeat: RepeatKind;
  /** Every: the number as typed, and its unit. */
  every: string;
  unit: EveryUnit;
  /** Days: weekdays 0 (Sunday) … 6 (Saturday) and the time HH:MM. */
  days: number[];
  clock: string;
  /** Advanced: the 5-field cron rule as typed. */
  cron: string;
  /** Optional: the first run not before this local YYYY-MM-DDTHH:MM, and the last day YYYY-MM-DD ('' = none). */
  start: string;
  end: string;
  /** The zone every field is read in. */
  tz: string;
}

export type ScheduleResult = { spec: ScheduleSpec; at?: number } | { error: string; soft?: boolean };

export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

const two = (value: number): string => String(value).padStart(2, '0');
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** The start of a new form: Once, one hour from `now` to the whole minute; Repeat starts as "every day at 09:00". */
export function defaultForm(now: number, tz: string): ScheduleForm {
  const { date, hour, minute } = wallClock(Math.floor((now + HOUR) / MIN) * MIN, tz);
  return { kind: 'once', date, time: `${two(hour)}:${two(minute)}`, repeat: 'days', every: '1', unit: 'hours', days: [...ALL_DAYS], clock: '09:00', cron: '', start: '', end: '', tz };
}

/** Today's date on the clock of `tz` (the date field's earliest day). */
export function todayIn(now: number, tz: string): string {
  return wallClock(now, tz).date;
}

/** One-tap times for Once. A pick that has passed stays in its place, switched off. */
export interface QuickPick { key: string; label: string; date: string; time: string; disabled: boolean }

export function quickPicks(now: number, tz: string): QuickPick[] {
  const today = wallClock(now, tz);
  const ahead = defaultForm(now, tz);
  const tomorrow = nextDate(today.date);
  let monday = nextDate(tomorrow); // the first Monday at least two days away
  for (let weekday = (today.weekday + 2) % 7; weekday !== 1; weekday = (weekday + 1) % 7) monday = nextDate(monday);
  return [
    { key: 'hour', label: 'In 1 hour', date: ahead.date, time: ahead.time, disabled: false },
    { key: 'evening', label: 'Today 18:00', date: today.date, time: '18:00', disabled: atWallTime(today.date, 18, 0, tz) <= now },
    { key: 'tomorrow', label: 'Tomorrow 09:00', date: tomorrow, time: '09:00', disabled: false },
    { key: 'monday', label: 'Next Monday 09:00', date: monday, time: '09:00', disabled: false },
  ];
}

function localInstant(value: string, tz: string): number | undefined {
  const match = LOCAL.exec(value);
  if (!match) return undefined;
  const at = atWallTime(match[1], Number(match[2]), Number(match[3]), tz);
  return Number.isFinite(at) ? at : undefined;
}

/** An instant as the start field holds it (local YYYY-MM-DDTHH:MM). */
export function localInput(ms: number, tz: string): string {
  const { date, hour, minute } = wallClock(ms, tz);
  return `${date}T${two(hour)}:${two(minute)}`;
}

/** n and unit of an interval in the largest unit that divides it evenly (minutes otherwise, rounded). */
export function splitEvery(ms: number): { n: number; unit: EveryUnit } {
  for (const unit of ['weeks', 'days', 'hours'] as const) if (ms >= UNIT_MS[unit] && ms % UNIT_MS[unit] === 0) return { n: ms / UNIT_MS[unit], unit };
  return { n: Math.max(1, Math.round(ms / MIN)), unit: 'minutes' };
}

/**
 * The spec for the form: a one-off (`at`), an interval (`everyMs`, anchored at its start – default one interval from
 * `now`, to the whole minute – so lists and previews show the real runs), clock times on weekdays (`times` + `days`) or
 * a cron rule; a start is "not before" (`at`), an end is the whole last day (`until`). A text while something is
 * missing or wrong; `soft` = not yet filled in, not a mistake. Missed runs while the PC was off: one late run.
 */
export function scheduleSpec(form: ScheduleForm, now: number): ScheduleResult {
  const tz = form.tz;
  if (form.kind === 'once') {
    const clock = CLOCK.exec(form.time);
    if (!DATE.test(form.date) || !clock) return { error: 'Pick a date and a time.' };
    const at = atWallTime(form.date, Number(clock[1]), Number(clock[2]), tz);
    if (!Number.isFinite(at)) return { error: 'Pick a date and a time.' };
    if (at <= now) return { error: 'Pick a time in the future.' };
    return { spec: { at, tz, catchUp: 'once' }, at };
  }
  let start: number | undefined;
  if (form.start) {
    start = localInstant(form.start, tz);
    if (start === undefined) return { error: 'Pick a start date and time, or clear it.' };
  }
  let until: number | undefined;
  if (form.end) {
    if (!DATE.test(form.end)) return { error: 'Pick an end date, or clear it.' };
    until = endOfDay(form.end, tz);
    if (!Number.isFinite(until)) return { error: 'Pick an end date, or clear it.' };
    if (until <= now) return { error: 'The end date has passed.' };
    if (start !== undefined && start > until) return { error: 'The end is before the start.' };
  }
  const spec: ScheduleSpec = { tz, catchUp: 'once' };
  if (form.repeat === 'every') {
    if (!/^\d{1,5}$/.test(form.every.trim()) || Number(form.every) < 1) return { error: 'Enter how often: a whole number, 1 or more.' };
    const everyMs = Number(form.every) * UNIT_MS[form.unit];
    spec.everyMs = everyMs;
    spec.at = start ?? Math.round((now + everyMs) / MIN) * MIN;
  } else if (form.repeat === 'days') {
    if (!CLOCK.test(form.clock)) return { error: 'Pick a time.' };
    if (!form.days.length) return { error: 'Pick at least one day.' };
    spec.times = [form.clock];
    if (form.days.length < 7) spec.days = [...new Set(form.days)].sort((a, b) => a - b);
    if (start !== undefined) spec.at = start;
  } else {
    const fields = form.cron.trim().split(/\s+/).filter(Boolean);
    if (!fields.length) return { error: 'Enter a cron rule: minute hour day month weekday, e.g. 0 9 * * 1.', soft: true };
    if (fields.length < 5 || fields.length > 6) return { error: 'A cron rule has 5 fields: minute hour day month weekday.' };
    spec.cron = fields.join(' ');
    if (start !== undefined) spec.at = start;
  }
  if (until !== undefined) spec.until = until;
  return { spec };
}

/** Same rule, whatever else changed – an untouched rule is not sent again when a scheduled message is edited. */
export function formKey(form: ScheduleForm): string {
  return JSON.stringify([form.kind, form.date, form.time, form.repeat, form.every.trim(), form.unit, [...form.days].sort(), form.clock, form.cron.trim(), form.start, form.end, form.tz]);
}

/**
 * The form of a stored spec (Edit); undefined when the form cannot show it (several times a day, a daily window,
 * skipped dates, a run limit). An interval whose anchor lies in the past shows no start: the rule is only
 * sent again when the person changes it (formKey).
 */
export function formFromSpec(spec: ScheduleSpec, now: number, fallbackTz: string): ScheduleForm | undefined {
  if (spec.except?.length || spec.window || spec.maxRuns !== undefined) return undefined;
  const tz = spec.tz || fallbackTz;
  const form = defaultForm(now, tz);
  const start = spec.at !== undefined && spec.at > now ? localInput(spec.at, tz) : '';
  const end = spec.until !== undefined ? wallClock(spec.until, tz).date : '';
  if (spec.cron !== undefined) return { ...form, kind: 'repeat', repeat: 'cron', cron: spec.cron, start, end };
  if (spec.everyMs !== undefined) {
    const { n, unit } = splitEvery(spec.everyMs);
    return { ...form, kind: 'repeat', repeat: 'every', every: String(n), unit, start, end };
  }
  if (spec.times) {
    if (spec.times.length !== 1 || !CLOCK.test(spec.times[0])) return undefined;
    return { ...form, kind: 'repeat', repeat: 'days', clock: spec.times[0], days: spec.days?.length ? [...spec.days] : [...ALL_DAYS], start, end };
  }
  if (spec.at === undefined) return undefined;
  const { date, hour, minute } = wallClock(spec.at, tz);
  return { ...form, kind: 'once', date, time: `${two(hour)}:${two(minute)}` };
}

/** Only the person's own scheduled message can be changed from the composer, and only a rule the form can show. */
export function editableSchedule(schedule: Pick<Schedule, 'ownerId' | 'kind' | 'conversationId' | 'spec'>, now: number, tz: string): boolean {
  return schedule.ownerId === 'human' && schedule.kind === 'message' && !!schedule.conversationId && formFromSpec(schedule.spec, now, tz) !== undefined;
}
