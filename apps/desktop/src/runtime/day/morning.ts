// The morning run (B-041 track A2, contract §5.9): one re-armable timeout (people/due-timer.ts) to the next
// settings.day.planAt in the profile zone – re-armed at start, on host.onPower 'resume' / 'unlock' and on a
// settings change; when today's run was missed (the PC was off or asleep at planAt, and the working day is not
// over yet) it runs shortly after (CATCH_UP_MS – never inside start()). A run: the day service's plan of today
// (which syncs connected calendars first and records kv day/planned:<member>) → the briefing (day/briefing.ts).
// kv day/planned:<member> = the local date keeps start, resume, the timer and a manual "Plan" from planning one
// day twice; a day the run already tried is not tried again before the next planAt (no retry loop). Only the
// owner's day in this build.
// Owns: the morning timer and its idempotency. Never: polls, a second timer, or runs while day.autoPlan is off.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { addDays, localDate } from '../calendar/when.ts';
import { DueTimer, REAL_DUE_TIMERS } from '../people/due-timer.ts';
import type { Timers } from '../people/join.ts';
import { KvRepo } from '../store/kv.ts';
import { Briefings, type BriefingDeps } from './briefing.ts';
import { dayZone, daySettings, wallTime } from './clock.ts';
import { PLANNED_KV, plannedDate } from './plan.ts';

export type MorningDeps = BriefingDeps & Pick<RuntimeServices, 'host'> & Partial<Pick<RuntimeServices, 'day' | 'calendarSources'>>;

/** A missed run starts this long after start or wake-up (the rest of the app settles first). */
export const CATCH_UP_MS = 30_000;
const OWNER = HUMAN_ID;

export class MorningPlan {
  readonly s: MorningDeps;
  private readonly timer: DueTimer;
  private readonly catchUpMs: number;
  private readonly briefings: Briefings;
  private offs: Array<() => void> = [];
  private running?: Promise<void>;
  /** The local date the run last tried (one try per day). */
  private tried?: string;

  constructor(s: MorningDeps, options: { timers?: Timers; catchUpMs?: number } = {}) {
    this.s = s;
    this.catchUpMs = options.catchUpMs ?? CATCH_UP_MS;
    this.briefings = new Briefings(s);
    this.timer = new DueTimer(options.timers ?? REAL_DUE_TIMERS, () => s.clock.now(), () => { void this.run(); });
  }

  start(): void {
    if (this.offs.length) return;
    this.offs = [
      // The delay is measured again from the wall clock: a timer armed before sleep runs late by the sleep time
      // (its monotonic clock stops during suspend on macOS and Linux), even for the same planAt.
      this.s.host.onPower((event) => { if (event === 'resume' || event === 'unlock') { this.timer.stop(); this.arm(); } }),
      this.s.bus.on('settings.updated', () => this.arm()),
    ];
    this.arm();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.timer.stop();
  }

  /** When the run comes next: soon for a missed one today, else the next planAt; none while autoPlan is off. */
  nextRun(now: number): number | undefined {
    const settings = daySettings(this.s);
    if (!settings.autoPlan) return undefined;
    const tz = dayZone(this.s);
    const today = localDate(now, tz);
    const planAt = wallTime(today, settings.planAt, tz);
    if (now < planAt) return planAt;
    const missed = now < wallTime(today, settings.workEnd, tz) && this.tried !== today && !this.done(today);
    return missed ? now + this.catchUpMs : wallTime(addDays(today, 1), settings.planAt, tz);
  }

  arm(): void {
    if (!this.offs.length) return;
    this.timer.arm(this.nextRun(this.s.clock.now()));
  }

  /** One run (the timer's; tests call it): today's plan unless planned already, then the briefing unless there is one. */
  run(): Promise<void> {
    this.running ??= this.once().finally(() => { this.running = undefined; this.arm(); });
    return this.running;
  }

  private async once(): Promise<void> {
    const s = this.s;
    const now = s.clock.now();
    const settings = daySettings(s);
    const tz = dayZone(s);
    const today = localDate(now, tz);
    if (!settings.autoPlan || now < wallTime(today, settings.planAt, tz)) return; // switched off, or an early wake of a long timer
    this.tried = today;
    if (plannedDate(s, OWNER) !== today) {
      try {
        if (s.day) await s.day.plan(OWNER, today, 'plan');
      } catch (error) {
        s.log.warn('my day: the morning plan failed', { error: String(error) });
      }
      try { new KvRepo(s.db).set(PLANNED_KV.ns, PLANNED_KV.key(OWNER), today, s.clock.now()); } catch { /* the try above stands */ }
    }
    if (this.briefings.get(OWNER, today)) return;
    try { await this.briefings.build(OWNER, today); } catch (error) { s.log.warn('my day: no morning briefing', { error: String(error) }); }
  }

  private done(today: string): boolean {
    return plannedDate(this.s, OWNER) === today && this.briefings.get(OWNER, today) !== null;
  }
}
