// Settings sections `day` and `calendar` (B-041, the My day concept §4): working hours,
// the planning buffer and the morning plan, My day's "AI helps" switch, keeping the PC awake for queued agent
// work after hours and the agents' lane in the calendar; plus the Google OAuth client the person connects
// (the client secret lives in the vault – settings hold only its id). They join Settings by module
// augmentation. All day math uses settings.profile.timezone. lastEvening is the one "since
// last evening" rule of the runtime (day/briefing.ts, day/handed-off.ts).
// Owns: these shapes, their defaults, DAY_BOUNDARY_HOUR and lastEvening. Never: reads, validates or stores
// settings (runtime/settings/*), or a secret value.

/** Settings › day. */
export interface DaySettings {
  workStart: string; // 'HH:MM', default '08:00'
  workEnd: string; // default '20:00'
  bufferMin: number; // 0–60, default 10
  autoPlan: boolean; // morning plan, default true
  planAt: string; // default '06:00'
  aiHelps: boolean; // My day input switch "AI helps" (tidy, sort, assistant prep), default true
  keepAwake: boolean; // B-078: the screen stays on while agents work; also keeps the PC awake while queued agent work exists after workEnd, default true
  agentLane: boolean; // show agents' schedule runs in My day's calendar, default false
}

/**
 * B-078 (D17): the keep-awake reason of running agent turns with day.keepAwake on – the host then keeps the screen on
 * ('prevent-display-sleep', main/host-services.ts); any other reason only keeps the app from being suspended.
 */
export const SCREEN_ON_REASON = 'Agents are working – the screen stays on';

/** Before 04:00 "tomorrow" means the coming day; one constant for parser, planner, Timer. */
export const DAY_BOUNDARY_HOUR = 4;
/** Upper bound of day.bufferMin (minutes between planned blocks). */
export const MAX_BUFFER_MIN = 60;

export const DEFAULT_DAY_SETTINGS: Readonly<DaySettings> = Object.freeze({
  workStart: '08:00', workEnd: '20:00', bufferMin: 10, autoPlan: true, planAt: '06:00', aiHelps: true, keepAwake: true, agentLane: false,
});

/** Settings › calendar: the person's own Google OAuth client (Desktop app type). */
export interface CalendarSettings {
  googleClientId?: string;
  googleSecretId?: string; // vault id of the client secret – never the secret itself
}

/** The day settings with every key (defaults for keys missing in older stored settings). */
export function daySettingsOf(settings: { day?: Partial<DaySettings> } | undefined): DaySettings {
  return { ...DEFAULT_DAY_SETTINGS, ...(settings?.day ?? {}) };
}

/** 'HH:MM' → minutes after local midnight (undefined when it is no valid clock time). */
export function clockMinutes(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/**
 * "Since last evening": the end of the working hours (`workEnd` 'HH:MM', else 20:00) of the evening before the
 * person's day in `tz` – before DAY_BOUNDARY_HOUR the day that just ended is still the person's day (01:00 on the
 * 25th reads from the evening of the 23rd). DST-correct to the minute.
 */
export function lastEvening(now: number, tz: string, workEnd?: string): number {
  const wall = wallOf(now, tz);
  const day = wall.minutes < DAY_BOUNDARY_HOUR * 60 ? plusDays(wall.date, -1) : wall.date;
  return wallInstant(plusDays(day, -1), clockMinutes(workEnd ?? '') ?? 20 * 60, tz);
}

const MIN = 60_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The local date and minutes after midnight of `at` in `tz`. */
function wallOf(at: number, tz: string): { date: string; minutes: number } {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formats.set(tz, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** Epoch ms of the wall time `minutes` after local midnight of `date` in `tz`. */
function wallInstant(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN;
  const offset = (ms: number) => {
    const local = wallOf(ms, tz);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld) + local.minutes * MIN - Math.floor(ms / MIN) * MIN;
  };
  return wall - offset(wall - offset(wall));
}

/** `date` (YYYY-MM-DD) plus `days` calendar days. */
function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

declare module './system.ts' {
  interface Settings {
    /** Addition (B-041); missing in settings stored before it – read with daySettingsOf. */
    day?: DaySettings;
    /** Addition (B-041): optional, no defaults. */
    calendar?: CalendarSettings;
  }
}
