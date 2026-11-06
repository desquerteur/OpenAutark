// My day's calendar window, pure updates (B-041 §6, split out of lib/day-store.ts): the window after an upserted
// or removed row, and after a burst of them in one pass (a sync or a calendar switched on or off sends hundreds of
// rows – one window update and one sort, not one per row), and the buffer that collects the rows of one frame.
// Owns: these updates and the buffer. Never: the signals themselves (day-store.ts passes read and write in).

import type { CalendarEvent, CalendarList } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';

export interface DayRange { from: number; to: number }
export interface CalendarWindow extends DayRange { list: CalendarList }

const overlaps = (event: CalendarEvent, range: DayRange): boolean => event.endAt > range.from && event.startAt < range.to;

/** The window after an upserted event: in it when it is the caller's and overlaps the range, else out of it. */
export function withEvent(window: CalendarWindow, event: CalendarEvent): CalendarWindow {
  const rest = window.list.events.filter((entry) => entry.id !== event.id);
  const keep = event.ownerId === HUMAN_ID && overlaps(event, window);
  if (!keep && rest.length === window.list.events.length) return window;
  const events = keep ? [...rest, event].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt) : rest;
  return { ...window, list: { ...window.list, events } };
}

/**
 * The window after a burst of changes – `upserts` and the `removed` ids – in one pass, sorted once (a sync or a
 * calendar switched on or off sends hundreds of rows: one window update, not one per row).
 */
export function withChanges(window: CalendarWindow, upserts: ReadonlyMap<string, CalendarEvent>, removed: ReadonlySet<string>): CalendarWindow {
  if (!upserts.size && !removed.size) return window;
  const rest = window.list.events.filter((entry) => !upserts.has(entry.id) && !removed.has(entry.id));
  const added = [...upserts.values()].filter((event) => event.ownerId === HUMAN_ID && overlaps(event, window));
  if (!added.length && rest.length === window.list.events.length) return window;
  const events = added.length ? [...rest, ...added].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt) : rest;
  return { ...window, list: { ...window.list, events } };
}

/** The window without the event `id` (unchanged when it held none). */
export function withoutEvent(window: CalendarWindow, id: string): CalendarWindow {
  if (!window.list.events.some((entry) => entry.id === id)) return window;
  return { ...window, list: { ...window.list, events: window.list.events.filter((entry) => entry.id !== id) } };
}

export const NEXT_FRAME = (apply: () => void): void => {
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') requestAnimationFrame(() => apply());
  else setTimeout(apply, 16);
};

/** calendar.upserted / calendar.removed collected and applied together (withChanges), once per flush. */
export function calendarBuffer(
  read: () => CalendarWindow | null, write: (window: CalendarWindow) => void, flush: (apply: () => void) => void,
): { upsert(event: CalendarEvent): void; remove(id: string): void; dispose(): void } {
  let upserts = new Map<string, CalendarEvent>();
  let removed = new Set<string>();
  let pending = false;
  let live = true;
  const apply = () => {
    pending = false;
    if (!live) return;
    const [ups, gone] = [upserts, removed];
    upserts = new Map();
    removed = new Set();
    const window = read();
    if (window) write(withChanges(window, ups, gone));
  };
  const queue = () => { if (!pending) { pending = true; flush(apply); } };
  return {
    upsert(event) { removed.delete(event.id); upserts.set(event.id, event); queue(); },
    remove(id) { upserts.delete(id); removed.add(id); queue(); },
    dispose() { live = false; },
  };
}
