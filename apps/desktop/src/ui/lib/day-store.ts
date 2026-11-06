// My day's data in the client (B-041 §6): the calendar window the views show (calendar.list for a
// range – the person's events and the time blocks of their to-dos, the agents' runs, the zone the
// runtime does day math in), the to-do → block join (`slotOf`: the calendar row is the only slot,
// TaskView carries none), the morning briefing, the work the person handed off, and the day clock.
// Loaded after every (re)connect by store.loadAll (today and the six days after it; a view loads other
// ranges itself) and kept fresh by events (wireDay from store-events.wireEvents):
// calendar.upserted/removed (collected and applied once per frame – a sync sends a burst), day.briefing
// and task.upserted/removed for the handed-off list. When
// the window comes to the front (focus, or the page turns visible) the connected calendars are synced
// (calendar.sync; the runtime skips a source synced in the last 30 s) and the day is loaded again.
// Every call is gated with can(): a connection that may not call a method gets an empty value, never
// a refused call. The day clock is one timeout to the next block start or end or the next local
// midnight in the day's zone, re-armed when the window changes – never an interval.
// Owns: these signals, their loader, the event apply, the clock and the sync on coming to the front.
// Never: renders, decides My day's groups (ui/day/day-groups.ts), writes (day.* and calendar.*
// changes come from the views), imports the store (store.ts imports this) or polls.

import { computed, effect, signal } from '@preact/signals';
import type { Briefing, CalendarEvent, CalendarList } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { atWallTime, nextDate, wallClock } from '../chat/composer/schedule-clock.ts';
import { ownerOf } from '../tasks/work-model.ts';
import type { LoadCall } from './load.ts';
import { rpc } from './rpc.ts';
import { can } from './session.ts';
import { NEXT_FRAME, calendarBuffer, type CalendarWindow, type DayRange } from './day-window.ts';

export type { CalendarWindow, DayRange };
/** The window's pure updates (lib/day-window.ts). */
export { withChanges, withEvent, withoutEvent } from './day-window.ts';

/** The calendar range shown now and what calendar.list returned for it (null: not loaded or not allowed here). */
export const calendarWindow = signal<CalendarWindow | null>(null);
/** The time block of each to-do in the window, by task id (kind 'todo'; a planned block wins over a done or cut one). */
export const slotOf = computed(() => slotMap(calendarWindow.value?.list.events ?? []));
/** Today's morning briefing (null: none yet or not allowed here). */
export const briefing = signal<Briefing | null>(null);
/** What the person asked for that others are doing (open, and recently done). */
export const handedOff = signal<TaskView[]>([]);
/** The time My day reads blocks at: moved at the next block start or end and at local midnight. */
export const dayClock = signal(Date.now());

/** The device's zone, until calendar.list (or the profile, via loadDay's options) names the runtime's. */
const deviceZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

/** `tz` when Intl knows it (a profile may hold anything), else undefined. */
function knownZone(tz: unknown): string | undefined {
  if (typeof tz !== 'string' || !tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}
const zone = signal(deviceZone());
/** The zone of all day math (settings.profile.timezone as the runtime reports it). */
export const dayZone = computed(() => calendarWindow.value?.list.tz || zone.value);

const DAY_DAYS = 7;
/** setTimeout's longest reliable delay is ~24.8 days; the clock re-arms after a day at most. */
const MAX_CLOCK_DELAY = 86_400_000;

// ------------------------------------------------------------------ pure helpers (tested directly)

/** The local date (YYYY-MM-DD) of `at` in `tz`. */
export function localDate(at: number, tz: string): string {
  return wallClock(at, tz).date;
}

/** The first instant of the local day after the one `now` is in (DST-correct). */
export function nextMidnight(now: number, tz: string): number {
  return atWallTime(nextDate(localDate(now, tz)), 0, 0, tz);
}

/** Local midnight of `date` up to local midnight `days` days later. */
export function dayRange(date: string, tz: string, days = 1): DayRange {
  let end = date;
  for (let index = 0; index < days; index++) end = nextDate(end);
  return { from: atWallTime(date, 0, 0, tz), to: atWallTime(end, 0, 0, tz) };
}

/** The to-do blocks by task id; a planned block wins over a done or cut one, then the later start. */
export function slotMap(events: readonly CalendarEvent[]): Map<string, CalendarEvent> {
  const map = new Map<string, CalendarEvent>();
  const rank = (event: CalendarEvent) => (event.state === 'planned' ? 1 : 0);
  for (const event of events) {
    if (event.kind !== 'todo' || !event.taskId) continue;
    const held = map.get(event.taskId);
    if (!held || rank(event) > rank(held) || (rank(event) === rank(held) && event.startAt > held.startAt)) map.set(event.taskId, event);
  }
  return map;
}

/** The next moment a block starts or ends after `now`, or the next local midnight, whichever is first. */
export function nextDayChange(events: readonly CalendarEvent[], now: number, tz: string): number {
  let next = nextMidnight(now, tz);
  for (const event of events) {
    if (event.startAt > now && event.startAt < next) next = event.startAt;
    else if (event.endAt > now && event.endAt < next) next = event.endAt;
  }
  return next;
}

/** Work the caller created that someone else (an agent, the team, a colleague) owns – not their own to-do (Work's owner rule). */
export function isHandedOff(task: TaskView): boolean {
  return task.createdBy === HUMAN_ID && !task.parentId && task.status !== 'cancelled' && ownerOf(task).kind !== 'human';
}

/** The handed-off list after a task.upserted: replaced while it still is handed off, added when it became so, else left out. */
export function handedOffWith(list: readonly TaskView[], task: TaskView): TaskView[] {
  const rest = list.filter((entry) => entry.id !== task.id);
  if (!isHandedOff(task)) return rest.length === list.length ? list as TaskView[] : rest;
  const index = list.findIndex((entry) => entry.id === task.id);
  if (index === -1) return [...list, task];
  const next = list.slice();
  next[index] = task;
  return next;
}

/** A calendar.list answer the views can read (an older runtime or a fake may answer anything). */
function readList(value: unknown, tz: string): CalendarList | null {
  const list = value as Partial<CalendarList> | null;
  if (!list || typeof list !== 'object' || !Array.isArray(list.events)) return null;
  return { events: list.events, agentRuns: Array.isArray(list.agentRuns) ? list.agentRuns : [], tz: knownZone(list.tz) ?? tz, staleSources: Array.isArray(list.staleSources) ? list.staleSources : [] };
}

// ------------------------------------------------------------------ loading

export interface LoadDayOptions {
  /** The runtime's day zone when known before calendar.list answers (store.loadAll: settings.profile.timezone). */
  tz?: string;
  call?: LoadCall;
  now?: number;
}

let calendarRequest = 0;
/** The range a view asked for last: a reconnect (loadDay without a range) loads it again. */
let lastRange: DayRange | undefined;

/** calendar.list for `range`; only the newest request is applied (a view may move on meanwhile). */
async function loadCalendar(range: DayRange, call: LoadCall): Promise<void> {
  const request = ++calendarRequest;
  if (!can('calendar.list')) { calendarWindow.value = null; return; }
  try {
    const list = readList(await call('calendar.list', { from: range.from, to: range.to }), zone.peek());
    if (request === calendarRequest) calendarWindow.value = list ? { ...range, list } : null;
  } catch { /* keep what is shown (no calendar service yet, or the connection went away) */ }
}

async function loadBriefing(date: string, call: LoadCall): Promise<void> {
  if (!can('day.briefing')) { briefing.value = null; return; }
  try { briefing.value = (await call('day.briefing', { date })) ?? null; } catch { /* keep what is shown */ }
}

async function loadHandedOff(call: LoadCall): Promise<void> {
  if (!can('day.handedOff')) { handedOff.value = []; return; }
  try {
    const list = await call('day.handedOff', {});
    if (Array.isArray(list)) handedOff.value = list;
  } catch { /* keep what is shown */ }
}

/**
 * Loads My day's data: the calendar for `range` (default: the range a view asked for last, else
 * today and the six days after it in the day's zone), today's briefing and the handed-off list.
 * Never rejects; what may not be read is empty.
 */
export async function loadDay(range?: DayRange, options: LoadDayOptions = {}): Promise<void> {
  const call = options.call ?? rpc.call;
  const known = knownZone(options.tz);
  if (known) zone.value = known;
  const now = options.now ?? Date.now();
  const tz = dayZone.peek();
  if (range) lastRange = range;
  await Promise.all([
    loadCalendar(range ?? lastRange ?? dayRange(localDate(now, tz), tz, DAY_DAYS), call),
    loadBriefing(localDate(now, tz), call),
    loadHandedOff(call),
  ]);
}

// ------------------------------------------------------------------ events and the clock

/** What wireDay listens on (rpc in the app, a fake in unit tests). */
export interface DayEvents { on<E extends EventName>(event: E, fn: (data: EventMap[E]) => void): () => void }

/** The one timeout of the day clock (the window's timers in the app, a fake in unit tests). */
export interface DayTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const WINDOW_TIMERS: DayTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Moves dayClock now and arms its one timeout for the next block start or end or local midnight; re-armed when the window changes. */
function wireDayClock(timers: DayTimers, now: () => number): () => void {
  let timer: unknown;
  const tick = () => {
    if (timer !== undefined) timers.clear(timer);
    const at = now();
    dayClock.value = at;
    const next = nextDayChange(calendarWindow.peek()?.list.events ?? [], at, dayZone.peek());
    timer = timers.set(tick, Math.max(0, Math.min(next - at + 25, MAX_CLOCK_DELAY)));
  };
  const stop = effect(() => {
    void calendarWindow.value; // re-armed at every change of the window
    tick();
  });
  return () => { stop(); if (timer !== undefined) timers.clear(timer); };
}

/** Where wireDay hears that the window came to the front (window focus, page visible); a fake in unit tests. */
export interface DayFront { on(fn: () => void): () => void }

const WINDOW_FRONT: DayFront = {
  on: (fn) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
    const shown = () => { if (document.visibilityState === 'visible') fn(); };
    window.addEventListener('focus', fn);
    document.addEventListener('visibilitychange', shown);
    return () => { window.removeEventListener('focus', fn); document.removeEventListener('visibilitychange', shown); };
  },
};

/** Focus and visibilitychange fire together, and the runtime ignores a calendar.sync within 30 s: one run per 30 s. */
const FRONT_GAP_MS = 30_000;

/** On coming to the front: calendar.sync (where allowed), then the day again (the range a view showed last). */
function wireFront(front: DayFront, call: () => LoadCall, now: () => number): () => void {
  let last = -Infinity;
  let running = false;
  return front.on(() => {
    const at = now();
    if (running || at - last < FRONT_GAP_MS) return;
    last = at;
    running = true;
    const current = call();
    const synced = can('calendar.sync') ? current('calendar.sync', {}).then(() => undefined, () => undefined) : Promise.resolve();
    void synced.then(() => loadDay(undefined, { call: current })).finally(() => { running = false; });
  });
}

export interface WireDayOptions {
  /** rpc.call at the time of each load (store tests point rpc.call at a fake). */
  call?: LoadCall;
  timers?: DayTimers;
  now?: () => number;
  /** The window's focus and visibility in the app. */
  front?: DayFront;
  /** Runs the buffered calendar changes once (default: the next animation frame, or a short timeout while hidden). */
  flush?: (apply: () => void) => void;
}

/** Called once from store-events.wireEvents: applies the day's events and starts the clock. Returns the disposer. */
export function wireDay(source: DayEvents = rpc, options: WireDayOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const calendar = calendarBuffer(() => calendarWindow.peek(), (window) => { calendarWindow.value = window; }, options.flush ?? NEXT_FRAME);
  const offs = [
    source.on('calendar.upserted', (event) => calendar.upsert(event)),
    source.on('calendar.removed', ({ id }) => calendar.remove(id)),
    () => calendar.dispose(),
    source.on('day.briefing', ({ ownerId, date }) => {
      if (ownerId === HUMAN_ID && date === localDate(now(), dayZone.peek())) void loadBriefing(date, options.call ?? rpc.call);
    }),
    source.on('task.upserted', (task) => { handedOff.value = handedOffWith(handedOff.peek(), task); }),
    source.on('task.removed', ({ id }) => {
      if (handedOff.peek().some((task) => task.id === id)) handedOff.value = handedOff.peek().filter((task) => task.id !== id);
    }),
    wireDayClock(options.timers ?? WINDOW_TIMERS, now),
    wireFront(options.front ?? WINDOW_FRONT, () => options.call ?? rpc.call, now),
  ];
  return () => { for (const off of offs) off(); };
}
