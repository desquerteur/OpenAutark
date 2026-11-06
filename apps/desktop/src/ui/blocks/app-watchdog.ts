// CPU watchdog for ```app frames (and overlay plugin frames): decides when a frame has kept a
// thread busy for too long, so AppFrame can freeze it. Two signals:
//  * long tasks the host's PerformanceObserver attributes to the frame's <iframe> (frames that
//    share the host's renderer thread) – more than WATCHDOG.busyMs busy inside a sliding window;
//  * missed heartbeat pings (MCP `ping`, answered by wf.js and any MCP Apps view) for frames in
//    their own process – only once the app has answered a ping at all, and only after
//    WATCHDOG.heartbeatMs without an answer (a caller may allow a frame that cannot stall the
//    app longer, without loosening the long-task rule). While it waits, one more ping goes out
//    (a second chance) and no other: a starved frame that wakes up has at most two to answer.
// Owns: these rules and the shared long-task fan-out. Never: touches the DOM or the frame
// (sending, timers and the observer are injected), never trips a frame that never answered a
// ping, and never blames a frame for the host's own delays (a late host timer re-measures).

export const WATCHDOG = {
  busyMs: 2000, // long tasks: longer than this busy → freeze
  heartbeatMs: 2000, // pings: no answer for this long → freeze
  windowMs: 3000, // long-task busy time is summed over this window
  pingEveryMs: 1000, // pause between an answer and the next ping
  answerMs: 1000, // a ping counts as missed after this
  lateMs: 500, // host timer this late → the host was busy itself; measure again
} as const;

export type TripReason = 'long-tasks' | 'heartbeat';

export interface WatchdogTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface WatchdogDeps {
  /** Sends a JSON-RPC `ping` request with this id to the frame. */
  ping: (id: string) => void;
  onTrip: (reason: TripReason) => void;
  timers: WatchdogTimers;
  limits?: Partial<Record<keyof typeof WATCHDOG, number>>;
}

export class CpuWatchdog {
  private readonly deps: WatchdogDeps;
  private readonly limits: Record<keyof typeof WATCHDOG, number>;
  private tasks: Array<{ start: number; end: number }> = [];
  private running = false;
  private started = false;
  private armed = false; // the app answered at least one ping
  private tripped = false;
  private waitingSince: number | undefined; // first unanswered ping
  private retried = false; // the second chance of this wait went out
  private dueAt = 0; // when the answer check should run (later = the host itself was busy)
  private timer: unknown;
  private seq = 0;

  constructor(deps: WatchdogDeps) {
    this.deps = deps;
    this.limits = { ...WATCHDOG, ...deps.limits };
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  /** The app finished its handshake (again): heartbeat (re)starts, unarmed. */
  start(): void {
    if (this.tripped) return;
    this.clearTimer();
    this.started = true;
    this.running = true;
    this.armed = false;
    this.endWait();
    this.sendPing();
  }

  /** Page hidden: no pings (background timers are throttled). */
  pause(): void {
    this.running = false;
    this.endWait();
    this.clearTimer();
  }

  /** Page visible again: a fresh measurement (the armed state is kept). */
  resume(): void {
    if (!this.started || this.running || this.tripped) return;
    this.running = true;
    this.sendPing();
  }

  stop(): void {
    this.started = false;
    this.pause();
  }

  /** Any message from the frame: its thread runs. */
  alive(): void {
    if (!this.running || this.waitingSince === undefined) return;
    this.armed = true;
    this.endWait();
    this.clearTimer();
    this.timer = this.deps.timers.set(() => { this.timer = undefined; this.sendPing(); }, this.limits.pingEveryMs);
  }

  /** A long task attributed to the frame (performance.now() time base). */
  longTask(start: number, duration: number): void {
    if (this.tripped || !(duration > 0)) return;
    const end = start + duration;
    this.tasks.push({ start, end });
    const from = end - this.limits.windowMs;
    this.tasks = this.tasks.filter((task) => task.end > from);
    const busy = this.tasks.reduce((sum, task) => sum + Math.max(0, Math.min(task.end, end) - Math.max(task.start, from)), 0);
    if (busy > this.limits.busyMs) this.trip('long-tasks');
  }

  private endWait(): void {
    this.waitingSince = undefined;
    this.retried = false;
  }

  private sendPing(): void {
    if (!this.running || this.tripped) return;
    this.waitingSince ??= this.deps.timers.now();
    this.deps.ping(`wf-ping-${++this.seq}`);
    this.checkIn(this.limits.answerMs);
  }

  private checkIn(ms: number): void {
    this.clearTimer();
    this.dueAt = this.deps.timers.now() + ms;
    this.timer = this.deps.timers.set(() => { this.timer = undefined; this.check(); }, ms);
  }

  private check(): void {
    if (!this.running || this.waitingSince === undefined) return;
    const now = this.deps.timers.now();
    if (now - this.dueAt > this.limits.lateMs) this.waitingSince = now; // our own timer was late: measure again (the ping stays out)
    if (!this.armed) return; // never answered: maybe no ping support – wait quietly for a first answer
    const left = this.waitingSince + this.limits.heartbeatMs - now;
    if (left <= 0) this.trip('heartbeat');
    else if (!this.retried) { this.retried = true; this.sendPing(); } // a second chance (e.g. the app just reloaded)
    else this.checkIn(left); // no ping storm: the frame answers the ones it has once it runs
  }

  private trip(reason: TripReason): void {
    if (this.tripped) return;
    this.tripped = true;
    this.running = false;
    this.clearTimer();
    this.tasks = [];
    this.deps.onTrip(reason);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.timers.clear(this.timer);
    this.timer = undefined;
  }
}

export interface LongTaskEntry {
  startTime: number;
  duration: number;
  /** id attributes of the containers (iframes) the task is attributed to. */
  containers: string[];
}

/** Starts observing; returns the stop function, or null when long tasks are not observable. */
export type LongTaskSource = (onEntries: (entries: LongTaskEntry[]) => void) => (() => void) | null;

/** One long-task observer for all frames: runs only while at least one frame is watched. */
export class LongTaskHub {
  private readonly source: LongTaskSource;
  private readonly watchers = new Map<string, (start: number, duration: number) => void>();
  private stopSource: (() => void) | null = null;

  constructor(source: LongTaskSource) {
    this.source = source;
  }

  watch(containerId: string, fn: (start: number, duration: number) => void): () => void {
    this.watchers.set(containerId, fn);
    if (!this.stopSource) this.stopSource = this.source((entries) => this.dispatch(entries));
    return () => {
      if (this.watchers.get(containerId) !== fn) return;
      this.watchers.delete(containerId);
      if (this.watchers.size === 0) { this.stopSource?.(); this.stopSource = null; }
    };
  }

  get active(): boolean {
    return this.stopSource !== null;
  }

  private dispatch(entries: LongTaskEntry[]): void {
    for (const entry of entries) {
      for (const id of new Set(entry.containers)) {
        try { this.watchers.get(id)?.(entry.startTime, entry.duration); } catch { /* one frame must not break the others */ }
      }
    }
  }
}
