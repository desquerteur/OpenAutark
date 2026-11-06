// The ONE timer of the runtime, armed for min(next due schedule, next future wake) and re-armed on every change,
// on power resume and after clock jumps – no polling loop. Due schedules are taken with a compare-and-swap on
// next_at (+ lease marker), so an occurrence fires once even with two processes; catch-up after the PC was off
// follows the spec's policy: 'once' (default, one late fire), 'all' (every missed occurrence, capped) or 'skip'
// (drop fires later than the grace period). Due wakes are announced to the dispatcher through onDueWakes(); wakes
// due "now" are announced immediately (microtask batch). B-044: each arm reports the earliest due time to
// `nextDue` (next-due.json, settled at stop); `pausedBy`: an agent never resumes the person's pause. B-054: only a
// scheduled message requires a chat; a routine may have none (its tasks are then chat-free, fire.ts).
// Owns: schedule CRUD, timing and firing. Never: runs agents (the dispatcher claims wakes).

import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices, Scheduler } from '../contracts.ts';
import type { Schedule, ScheduleSpec } from '../../shared/model/tasks.ts';
import type { NextDueSink } from './next-due.ts';
import { ScheduleRepo } from './repo.ts';
import { firesBetween, isOneOff, nextFire, validateSpec } from './spec.ts';
import { ScheduleGone, announceCreated, fireSchedule } from './fire.ts';

export const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows above this (~24.8 days)

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SchedulerDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'wakes' | 'chats' | 'tasks'>
  & Partial<Pick<RuntimeServices, 'host' | 'notifications' | 'log'>>;

export interface SchedulerOptions {
  timers?: Timers;
  graceMs?: number; // 'skip' policy: fires later than this are dropped (default 2 min)
  maxCatchUp?: number; // 'all' policy cap (default 50)
  maxAgentSchedules?: number; // active schedules per agent (default 200)
  nextDue?: NextDueSink; // told the earliest due time on every arm (undefined: nothing due), settled at stop
}

type CreateInput = Parameters<Scheduler['create']>[0];

export class SchedulerImpl implements Scheduler {
  private readonly s: SchedulerDeps;
  private readonly repo: ScheduleRepo;
  private readonly timers: Timers;
  private readonly o: Required<Omit<SchedulerOptions, 'timers' | 'nextDue'>> & Pick<SchedulerOptions, 'nextDue'>;
  private readonly lease = newId('sch').slice(4); // per-process marker for audit/debugging
  private readonly dueListeners = new Set<(agentIds: string[]) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private timer: unknown;
  private expectedAt?: number;
  private wakeScanAt = 0;
  private immediate = new Set<string>();
  private flushQueued = false;
  private running = false;

  constructor(deps: SchedulerDeps, options: SchedulerOptions = {}) {
    this.s = deps;
    this.repo = new ScheduleRepo(deps.db);
    this.timers = options.timers ?? realTimers;
    this.o = { graceMs: options.graceMs ?? 120_000, maxCatchUp: options.maxCatchUp ?? 50, maxAgentSchedules: options.maxAgentSchedules ?? 200, nextDue: options.nextDue };
  }

  // ------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wakeScanAt = this.s.clock.now();
    this.unsubscribe.push(this.s.wakes.onChange(({ agentId, dueAt }) => {
      if (dueAt !== undefined && dueAt <= this.s.clock.now()) this.announce([agentId]);
      this.arm();
    }));
    if (this.s.host) {
      this.unsubscribe.push(this.s.host.onPower(event => {
        if (event === 'resume' || event === 'unlock') this.tick('power');
      }));
    }
    // Wakes already due (e.g. left from before a restart) and missed schedules.
    this.announce(this.s.wakes.dueAgents(this.wakeScanAt));
    this.tick('start');
  }

  async stop(): Promise<void> { // no timer or report after this; resolves once the last report is on disk
    this.running = false;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
    await this.o.nextDue?.settle?.();
  }

  onDueWakes(listener: (agentIds: string[]) => void): () => void {
    this.dueListeners.add(listener);
    return () => this.dueListeners.delete(listener);
  }

  arm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    if (!this.running) return;
    const now = this.s.clock.now();
    if (this.wakeScanAt > now) this.wakeScanAt = now; // clock went backwards
    const candidates = [this.repo.nextAt(), this.s.wakes.nextDueAfter(this.wakeScanAt)].filter((t): t is number => t !== undefined);
    const due = candidates.length ? Math.min(...candidates) : undefined;
    try { this.o.nextDue?.report(due); } catch (error) { this.s.log?.warn('next-due report failed', { error: String(error) }); }
    if (due === undefined) { this.expectedAt = undefined; return; }
    const delay = Math.min(Math.max(due - now, 0), MAX_TIMER_MS);
    this.expectedAt = now + delay;
    this.timer = this.timers.set(() => { this.timer = undefined; this.tick('timer'); }, delay);
  }

  /** Processes everything due now, then re-arms. Safe to call any time. */
  tick(source: 'timer' | 'power' | 'start' | 'manual' = 'manual'): void {
    const now = this.s.clock.now();
    if (source === 'timer' && this.expectedAt !== undefined && Math.abs(now - this.expectedAt) > 60_000) {
      this.s.log?.info('scheduler: clock jump detected', { driftMs: now - this.expectedAt });
    }
    for (let batch = 0; batch < 20; batch++) {
      const due = this.repo.due(now, 100);
      for (const schedule of due) this.fire(schedule, now);
      if (due.length < 100) break;
    }
    if (this.wakeScanAt > now) this.wakeScanAt = now;
    const agents = this.s.wakes.dueBetween(this.wakeScanAt, now);
    this.wakeScanAt = now;
    this.announce(agents);
    this.arm();
  }

  // ------------------------------------------------------------- CRUD

  create(input: CreateInput): Schedule {
    const now = this.s.clock.now();
    const error = validateSpec(input.spec, { minEveryMs: input.kind === 'timer' ? 1000 : 60_000 });
    if (error) throw new WorkforceError('bad_request', error);
    // B-054: only a scheduled message posts into a chat; routines, reminders and timers need none.
    if (input.kind === 'message' && !input.conversationId) throw new WorkforceError('bad_request', 'A scheduled message is posted in a chat: pass chatId.');
    if (input.kind === 'reminder' && input.ownerId === HUMAN_ID) throw new WorkforceError('bad_request', 'Reminders belong to agents; use a timer.');
    if (input.ownerId !== HUMAN_ID && this.repo.activeCount(input.ownerId) >= this.o.maxAgentSchedules) throw new WorkforceError('conflict', 'Too many active schedules for this agent.');
    const schedule: Schedule = {
      id: newId('sch', now), ownerId: input.ownerId, kind: input.kind, title: input.title.trim() || input.kind, spec: input.spec,
      payload: input.payload ?? {}, runs: 0, active: input.active ?? true, createdAt: now,
    };
    if (input.conversationId) schedule.conversationId = input.conversationId;
    if (input.taskId) schedule.taskId = input.taskId;
    const first = this.firstFire(input.spec, now);
    if (first === undefined) schedule.active = false; else schedule.nextAt = first;
    this.repo.insert(schedule);
    this.s.bus.emit('schedule.upserted', schedule);
    try { announceCreated(schedule, this.s); } catch (err) { this.s.log?.warn('schedule status line failed', { error: String(err) }); }
    this.arm();
    return schedule;
  }

  update(id: string, patch: Partial<Pick<Schedule, 'title' | 'spec' | 'payload' | 'active'>>, by?: string): Schedule {
    const schedule = this.require(id);
    const agent = by !== undefined && by !== HUMAN_ID;
    if (patch.active && !schedule.active && agent && this.pausedByPerson(schedule)) throw new WorkforceError('forbidden', 'The person paused this schedule; only they can resume it.');
    if (patch.spec) {
      const error = validateSpec(patch.spec, { minEveryMs: schedule.kind === 'timer' ? 1000 : 60_000 });
      if (error) throw new WorkforceError('bad_request', error);
      schedule.spec = patch.spec;
    }
    if (patch.title !== undefined) schedule.title = patch.title.trim() || schedule.title;
    if (patch.payload) schedule.payload = { ...schedule.payload, ...patch.payload };
    if (patch.active === false && by !== undefined && (schedule.active || !agent)) schedule.pausedBy = by; // the person's pause always counts
    else if (patch.active) delete schedule.pausedBy;
    if (patch.active !== undefined) schedule.active = patch.active;
    if (patch.spec || patch.active === true) {
      const next = this.firstFire(schedule.spec, this.s.clock.now());
      const exhausted = schedule.spec.maxRuns !== undefined && schedule.runs >= schedule.spec.maxRuns;
      if (next === undefined || exhausted) { schedule.active = false; delete schedule.nextAt; } else schedule.nextAt = next;
    }
    this.repo.save(schedule);
    this.s.bus.emit('schedule.upserted', schedule);
    this.arm();
    return schedule;
  }

  remove(id: string): void {
    if (!this.repo.delete(id)) return;
    this.s.bus.emit('schedule.removed', { id });
    this.arm();
  }

  list(filter?: { conversationId?: string; ownerId?: string; taskId?: string }): Schedule[] { return this.repo.list(filter); }

  get(id: string): Schedule | undefined { return this.repo.get(id); }

  runNow(id: string): void {
    const schedule = this.require(id);
    const now = this.s.clock.now();
    this.execute(schedule, now);
    schedule.runs += 1;
    schedule.lastAt = now;
    this.repo.save(schedule);
    this.s.bus.emit('schedule.upserted', schedule);
  }

  next(spec: ScheduleSpec, after: number): number | undefined { return nextFire(spec, after); }

  /** The person's pause: pausedBy 'human' – or, before B-044 only the person could pause, a stopped schedule that has not ended and records no one. */
  private pausedByPerson(schedule: Schedule): boolean {
    if (schedule.pausedBy !== undefined) return schedule.pausedBy === HUMAN_ID;
    try { return (schedule.spec.maxRuns ?? Infinity) > schedule.runs && nextFire(schedule.spec, this.s.clock.now()) !== undefined; } catch { return false; }
  }

  // ------------------------------------------------------------- firing

  /** First fire: a past one-off `at` still fires (late, once); everything else strictly after now. */
  private firstFire(spec: ScheduleSpec, now: number): number | undefined {
    if (isOneOff(spec) && spec.at! <= now) {
      return spec.until !== undefined && spec.at! > spec.until ? undefined : spec.at;
    }
    return nextFire(spec, now);
  }

  private fire(schedule: Schedule, now: number): void {
    const occurrence = schedule.nextAt!;
    const spec = schedule.spec;
    // Interval schedules are anchored at their previous occurrence (no drift, no catch-up storm).
    const anchored: ScheduleSpec = spec.everyMs !== undefined && spec.at === undefined ? { ...spec, at: occurrence } : spec;
    const policy = spec.catchUp ?? 'once';
    let next: number | undefined;
    let occurrences = [occurrence];
    try {
      next = nextFire(anchored, now);
      if (policy === 'skip' && now - occurrence > this.o.graceMs) occurrences = [];
      if (policy === 'all') occurrences = [occurrence, ...firesBetween(anchored, occurrence, now, this.o.maxCatchUp - 1)];
    } catch (error) {
      // A stored spec that no longer computes (e.g. restored from another version) must not
      // stop the single timer or the runtime start: switch it off, visibly.
      this.s.log?.error('schedule fire failed', { scheduleId: schedule.id, error: String(error) });
      this.deactivate(schedule.id);
      return;
    }
    if (spec.maxRuns !== undefined) occurrences = occurrences.slice(0, Math.max(0, spec.maxRuns - schedule.runs));
    const runs = schedule.runs + occurrences.length;
    const active = next !== undefined && (spec.maxRuns === undefined || runs < spec.maxRuns);
    const taken = this.repo.take(schedule.id, occurrence, {
      nextAt: active ? next : undefined, lastAt: occurrences.length ? now : schedule.lastAt ?? now,
      addRuns: occurrences.length, active, lease: `${this.lease}:${now}`,
    });
    if (!taken) return; // another process (or a re-entrant tick) fired this occurrence
    for (const at of occurrences) {
      if (!this.execute(schedule, at)) break;
    }
    const updated = this.repo.get(schedule.id);
    if (updated) this.s.bus.emit('schedule.upserted', updated);
  }

  /** Runs the schedule's effect; returns false when the schedule was deactivated. */
  private execute(schedule: Schedule, occurrence: number): boolean {
    try {
      fireSchedule(schedule, occurrence, this.s);
      return true;
    } catch (error) {
      if (error instanceof ScheduleGone) {
        this.deactivate(schedule.id, false);
        this.s.log?.info('schedule deactivated', { scheduleId: schedule.id, reason: error.message });
        return false;
      }
      this.s.log?.error('schedule fire failed', { scheduleId: schedule.id, error: String(error) });
      return true;
    }
  }

  /** Switches a schedule off (`emit`: tell the UI now; fire() emits after its own run). */
  private deactivate(id: string, emit = true): void {
    const current = this.repo.get(id);
    if (!current) return;
    current.active = false;
    delete current.nextAt;
    this.repo.save(current);
    if (emit) this.s.bus.emit('schedule.upserted', current);
  }

  private announce(agentIds: string[]): void {
    for (const id of agentIds) this.immediate.add(id);
    if (!this.immediate.size || this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const batch = [...this.immediate];
      this.immediate.clear();
      if (!batch.length) return;
      for (const listener of this.dueListeners) {
        try { listener(batch); } catch (error) { this.s.log?.error('onDueWakes listener failed', { error: String(error) }); }
      }
    });
  }

  private require(id: string): Schedule {
    const schedule = this.repo.get(id);
    if (!schedule) throw new WorkforceError('not_found', 'Schedule not found.', { details: { scheduleId: id } });
    return schedule;
  }
}
