// Composition of My day (B-041): the calendar (A1), the connected sources (G), the learned estimates and the day
// service (A2) on RuntimeServices, plus the morning run and the keep-awake hold (A2). Every part gets the
// late-bound services record `s` and picks what it needs; start() subscribes listeners and arms timers (never
// runs a plan inside start), stopCalendar(s) undoes it in reverse order at shutdown. B-078 (D20): the peer method
// 'calendar.ask' (calendar/linked.ts) opens on the mesh's extension point to every link kind – linked PCs ask this
// PC for its person's free/busy, entries or a booking; what each link gets is decided there.
// Owns: this wiring. Never: behaviour, or a timer of its own.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { CalendarServiceImpl } from '../calendar/service.ts';
import { CalendarSourcesImpl } from '../calendar/sources/index.ts';
import { TaskEstimates } from '../day/estimates.ts';
import { DayServiceImpl } from '../day/service.ts';
import { MorningPlan } from '../day/morning.ts';
import { KeepAwake } from '../day/keep-awake.ts';
import { EVERY_LINK } from '../devices/mesh.ts';
import { registerCalendarAsk } from '../calendar/linked.ts';

interface Startable { start(): void; stop(): void }

const running = new WeakMap<RuntimeServices, Startable[]>();

export function createCalendar(s: RuntimeServices): void {
  const calendar = new CalendarServiceImpl(s);
  const sources = new CalendarSourcesImpl(s);
  const day = new DayServiceImpl(s);
  s.calendar = calendar;
  s.calendarSources = sources;
  s.estimates = new TaskEstimates(s);
  s.day = day;
  registerCalendarAsk(s, EVERY_LINK);
  const parts: Startable[] = [calendar, sources, day, new MorningPlan(s), new KeepAwake(s)];
  running.set(s, parts);
  for (const part of parts) {
    try { part.start(); } catch (error) { s.log.warn('my day part did not start', { error: String(error) }); }
  }
}

/** Shutdown: listeners and timers go (reverse order); each part stops on its own. */
export function stopCalendar(s: RuntimeServices): void {
  for (const part of (running.get(s) ?? []).reverse()) {
    try { part.stop(); } catch (error) { s.log.warn('my day part did not stop', { error: String(error) }); }
  }
  running.delete(s);
}
