// Keep the PC awake for agent work after hours (B-041 track A2, contract §5.10): with settings.day.keepAwake, in
// the night window (workEnd → the next planAt, profile zone) while agent turns run or wakes wait that are due
// before the morning, one host.keepAwake('Agents are working tonight') hold – released when nothing is left, at
// planAt, or after 10 h at most (then not again before the next evening). Running turns hold the PC by
// themselves (agents/dispatch-live.ts – B-078: with day.keepAwake their hold keeps the screen on too, at any hour; the
// switch is Settings › General "Keep the screen on while agents work"); this hold covers the gaps between them (queued
// wakes, the news delay).
// Event-driven: the wake queue's changes, 'agent.activity', settings changes and resume; one re-armable timeout
// (people/due-timer.ts) for the next edge – the night's start, or the hold's end. A lid closed anyway still
// sleeps: B-059 records it – a 'suspend' in the night window while agent work ran or waited, and the 'resume'
// after it, become one span in kv day/slept (the last SLEPT_MAX, none older than 36 h), which the briefing
// (day/briefing.ts sleptSince) says plainly: "PC slept 23:10–06:40 – night work paused". A lock is no sleep.
// Owns: that one hold and the sleep record. Never: polls, holds outside the night window or longer than 10 h.

import type { RuntimeServices } from '../contracts.ts';
import type { SleepSpan } from '../../shared/model/calendar.ts';
import { clockMinutes } from '../../shared/model/day-settings.ts';
import { addDays } from '../calendar/when.ts';
import { DueTimer, REAL_DUE_TIMERS } from '../people/due-timer.ts';
import type { Timers } from '../people/join.ts';
import { KvRepo } from '../store/kv.ts';
import { dayZone, daySettings, localTime, wallTime } from './clock.ts';

export type KeepAwakeDeps = Pick<RuntimeServices, 'bus' | 'clock' | 'settings' | 'host' | 'wakes'> & Partial<Pick<RuntimeServices, 'log' | 'dispatcher' | 'db'>>;

export const KEEP_AWAKE_REASON = 'Agents are working tonight';
export const MAX_HOLD_MS = 10 * 60 * 60_000;
/** B-059: kv day/slept – the PC's sleeps while night work waited (SleepSpan[], oldest first). */
export const SLEPT_KV = { ns: 'day', key: 'slept' } as const;
const SLEPT_MAX = 8;
const SLEPT_KEEP_MS = 36 * 60 * 60_000;

/** The recorded sleeps that ended at or after `since` (oldest first); [] without a record. */
export function sleptSince(db: RuntimeServices['db'], since: number): SleepSpan[] {
  try {
    const spans = new KvRepo(db).get<SleepSpan[]>(SLEPT_KV.ns, SLEPT_KV.key);
    return Array.isArray(spans) ? spans.filter((span) => typeof span?.from === 'number' && typeof span.to === 'number' && span.to >= since) : [];
  } catch {
    return [];
  }
}

/** The night window around `now` ([workEnd, next planAt) in the zone), or undefined during the day. */
export function nightOf(now: number, tz: string, workEnd: string, planAt: string): { from: number; to: number } | undefined {
  const local = localTime(now, tz);
  const end = clockMinutes(workEnd) ?? 20 * 60;
  const plan = clockMinutes(planAt) ?? 6 * 60;
  if (end > plan) {
    if (local.minutes >= end) return { from: wallTime(local.date, workEnd, tz), to: wallTime(addDays(local.date, 1), planAt, tz) };
    if (local.minutes < plan) return { from: wallTime(addDays(local.date, -1), workEnd, tz), to: wallTime(local.date, planAt, tz) };
    return undefined;
  }
  return local.minutes >= end && local.minutes < plan ? { from: wallTime(local.date, workEnd, tz), to: wallTime(local.date, planAt, tz) } : undefined;
}

export class KeepAwake {
  readonly s: KeepAwakeDeps;
  private readonly timer: DueTimer;
  private offs: Array<() => void> = [];
  private release?: () => void;
  private until?: number;
  /** After a hold reached its end: no new one before this (the night is spent). */
  private spentUntil?: number;
  private turns = 0;
  /** B-059: when the PC went to sleep while night work ran or waited (cleared at resume). */
  private sleptAt?: number;

  constructor(s: KeepAwakeDeps, options: { timers?: Timers } = {}) {
    this.s = s;
    this.timer = new DueTimer(options.timers ?? REAL_DUE_TIMERS, () => s.clock.now(), () => this.check());
  }

  /** Holding now? */
  get holding(): boolean { return this.release !== undefined; }

  start(): void {
    if (this.offs.length) return;
    try { this.turns = this.s.dispatcher?.activity?.().length ?? 0; } catch { this.turns = 0; }
    this.offs = [
      this.s.wakes.onChange(() => this.check()),
      this.s.bus.on('agent.activity', ({ active }) => { this.turns = active.length; this.check(); }),
      this.s.bus.on('settings.updated', () => this.check()),
      // Re-armed from the wall clock (a timer armed before sleep runs late by the sleep time, even for the same edge).
      this.s.host.onPower((event) => {
        if (event === 'suspend') this.fellAsleep();
        if (event === 'resume') this.wokeUp();
        if (event === 'resume' || event === 'unlock') { this.timer.stop(); this.check(); }
      }),
    ];
    this.check();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.timer.stop();
    this.letGo();
  }

  /** Holds or releases for the current state, and arms the timer for the next edge. */
  check(): void {
    if (!this.offs.length) return;
    const now = this.s.clock.now();
    const settings = daySettings(this.s);
    const tz = dayZone(this.s);
    const night = nightOf(now, tz, settings.workEnd, settings.planAt);
    if (this.release && this.until !== undefined && now >= this.until) { this.spentUntil = night?.to ?? now; this.letGo(); }
    const spent = this.spentUntil !== undefined && now < this.spentUntil;
    const wanted = settings.keepAwake && night !== undefined && !spent && (this.turns > 0 || this.queued(now, night.to));
    if (wanted && !this.release) this.hold(now, Math.min(night!.to, now + MAX_HOLD_MS));
    else if (!wanted && this.release) this.letGo();
    if (this.release) this.timer.arm(this.until);
    else this.timer.arm(night ? (spent ? this.spentUntil : undefined) : this.nextNight(now, tz, settings.workEnd));
  }

  /** Wakes due now, or due before the morning. */
  private queued(now: number, before: number): boolean {
    try {
      return this.s.wakes.dueAgents(now).length > 0 || (this.s.wakes.nextDueAfter(now) ?? Infinity) < before;
    } catch {
      return false;
    }
  }

  /** B-059: a 'suspend' in the night window while agent work ran or waited is remembered until the resume. */
  private fellAsleep(): void {
    const now = this.s.clock.now();
    const settings = daySettings(this.s);
    const night = nightOf(now, dayZone(this.s), settings.workEnd, settings.planAt);
    if (night && (this.holding || this.turns > 0 || this.queued(now, night.to))) this.sleptAt = now;
  }

  /** B-059: the resume after such a sleep stores its span (kv day/slept). */
  private wokeUp(): void {
    const from = this.sleptAt;
    this.sleptAt = undefined;
    const db = this.s.db;
    if (from === undefined || !db) return;
    const now = this.s.clock.now();
    try {
      const spans = sleptSince(db, now - SLEPT_KEEP_MS).concat({ from, to: now }).slice(-SLEPT_MAX);
      new KvRepo(db).set(SLEPT_KV.ns, SLEPT_KV.key, spans, now);
    } catch (error) {
      this.s.log?.warn('keepAwake: the sleep was not recorded', { error: String(error) });
    }
  }

  /** Today's workEnd when it is still ahead, else tomorrow's. */
  private nextNight(now: number, tz: string, workEnd: string): number {
    const today = localTime(now, tz).date;
    const tonight = wallTime(today, workEnd, tz);
    return tonight > now ? tonight : wallTime(addDays(today, 1), workEnd, tz);
  }

  private hold(now: number, until: number): void {
    try {
      this.release = this.s.host.keepAwake(KEEP_AWAKE_REASON);
      this.until = until;
      this.s.log?.info('keeping the PC awake for agent work tonight', { until: new Date(until).toISOString() });
    } catch (error) {
      this.s.log?.warn('keepAwake failed', { error: String(error), at: now });
    }
  }

  private letGo(): void {
    const release = this.release;
    this.release = undefined;
    this.until = undefined;
    if (!release) return;
    try { release(); } catch { /* host gone */ }
  }
}
