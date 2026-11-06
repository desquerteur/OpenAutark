// My day's view state in the client (B-041 §4.1): the day shown (the route's date, else today in the day's
// zone), the calendar range the views need loaded (the mini month's six weeks around that day – one
// calendar.list covers the day grid and the month's marks; lib/day-store.ts keeps it fresh by events), the
// connected calendars (calendar.sources, reloaded on the owner's 'calendar.sources' event while a view shows
// them), the List | Calendar choice of a narrow column, the Day | Week choice of the calendar and the row a view asks
// the list to open.
// Owns: these signals and the calls that fill them. Never: renders, decides groups (day-groups.ts) or polls –
// the calendar comes from day-store, which events keep fresh.

import { computed, signal } from '@preact/signals';
import type { CalendarEvent, CalendarSource } from '../../shared/model/calendar.ts';
import { calendarWindow, dayClock, dayZone, loadDay, localDate } from '../lib/day-store.ts';
import { route } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { atWallTime, nextDate } from '../chat/composer/schedule-clock.ts';
import { dayBounds, monthGrid, spanIn } from './day-grid.ts';
import type { Span } from './day-grid.ts';

/** Today in the day's zone (moves at local midnight with the day clock). */
export const today = computed(() => localDate(dayClock.value, dayZone.value));

/** The day My day shows: the route's date, else today. */
export const shownDate = computed(() => {
  const current = route.value;
  return current.view === 'day' && current.date ? current.date : today.value;
});

/** A narrow column or a phone shows the list or the calendar. */
export const dayLayout = signal<'list' | 'calendar'>('list');
/** The calendar pane shows one day or the week of the shown day (Day | Week in the header; a computer only). */
export const calendarSpan = signal<'day' | 'week'>('day');
/** A row another part of My day asks the list to show and open (the calendar's "Show in list", a handed-off step). */
export const revealRequest = signal<{ id: string; seq: number } | null>(null);
let revealSeq = 0;
export function revealTodo(id: string): void {
  revealRequest.value = { id, seq: ++revealSeq };
  dayLayout.value = 'list';
  calendarSpan.value = 'day'; // the week hides the list in a wide view
}

// ------------------------------------------------------------------ the calendar range

/** 'idle' before a view asked, 'loading', 'ready', or 'unavailable' (not allowed here, or the calendar did not answer). */
export const calendarStatus = signal<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

/** The six weeks of the mini month around `date` in `tz` (42 days – calendar.list allows 62). */
export function monthRange(date: string, tz: string): { from: number; to: number } {
  const days = monthGrid(date);
  return { from: atWallTime(days[0], 0, 0, tz), to: atWallTime(nextDate(days[days.length - 1]), 0, 0, tz) };
}

let ensuring = 0;
/** Loads the calendar around `date` unless the window already covers it. */
export async function ensureCalendar(date: string): Promise<void> {
  const tz = dayZone.peek();
  const range = monthRange(date, tz);
  const window = calendarWindow.peek();
  if (window && window.from <= range.from && window.to >= range.to) { calendarStatus.value = 'ready'; return; }
  const request = ++ensuring;
  calendarStatus.value = 'loading';
  await loadDay(range);
  if (request !== ensuring) return;
  const loaded = calendarWindow.peek();
  calendarStatus.value = loaded && loaded.from <= range.from && loaded.to >= range.to ? 'ready' : 'unavailable';
}

// ------------------------------------------------------------------ connected calendars

/** The connected calendars (empty where they may not be read). */
export const sources = signal<CalendarSource[]>([]);
/** Sources the person switched off: their events are not shown. */
export const hiddenSources = computed(() => new Set(sources.value.filter((source) => !source.visible).map((source) => source.id)));

async function loadSources(): Promise<void> {
  // a room's calendar (owner room:…) is the room's, listed in Settings › Calendar only
  try { sources.value = (await rpc.call('calendar.sources')).filter((source) => !source.ownerId.startsWith('room:')); } catch { /* keep what is shown */ }
}

let sourceUsers = 0;
let offSources: (() => void) | undefined;
/** A view that shows the sources (DayNav, the calendar): loads them and follows 'calendar.sources' while one is mounted. */
export function watchSources(): () => void {
  sourceUsers++;
  if (sourceUsers === 1) {
    void loadSources();
    offSources = rpc.on('calendar.sources', () => { void loadSources(); });
  }
  return () => {
    sourceUsers--;
    if (sourceUsers === 0) { offSources?.(); offSources = undefined; }
  };
}

/** Shows or hides a connected calendar (owner only: calendar.updateSource). */
export async function setSourceVisible(source: CalendarSource, visible: boolean): Promise<void> {
  const before = sources.peek();
  sources.value = before.map((entry) => (entry.id === source.id ? { ...entry, visible } : entry));
  try {
    const saved = await rpc.call('calendar.updateSource', { id: source.id, visible });
    sources.value = sources.peek().map((entry) => (entry.id === saved.id ? saved : entry));
  } catch (error) {
    sources.value = before;
    toastError(error, 'Could not change the calendar');
  }
}

type DayEvents = ReadonlyArray<{ event: CalendarEvent; span: Span }>;
/** eventsOn's results for the current window and hidden sources, by day and zone (the day grid re-renders each minute, the week asks for 7 days). */
let shown: { events: readonly CalendarEvent[] | undefined; hidden: ReadonlySet<string>; byDay: Map<string, DayEvents> } | undefined;

/** The events of the window shown on `date` (sources switched off left out): the day's bounds once, zone math only for its events. */
export function eventsOn(date: string, tz: string): DayEvents {
  const hidden = hiddenSources.value;
  const events = calendarWindow.value?.list.events;
  if (!shown || shown.events !== events || shown.hidden !== hidden) shown = { events, hidden, byDay: new Map() };
  const key = `${date}|${tz}`;
  const known = shown.byDay.get(key);
  if (known) return known;
  const bounds = dayBounds(date, tz);
  const out: Array<{ event: CalendarEvent; span: Span }> = [];
  for (const event of events ?? []) {
    if (hidden.has(event.sourceId) || event.allDay || event.endAt <= bounds.start || event.startAt >= bounds.end) continue;
    const span = spanIn(event, bounds, tz);
    if (span) out.push({ event, span });
  }
  if (shown.byDay.size > 60) shown.byDay.clear();
  shown.byDay.set(key, out);
  return out;
}
