// Process supervisor: every child process the runtime starts is a *lease*.
// Owns: spawning (below-normal priority, hidden windows), idle kill timers, kill trees
// (Windows `taskkill /T /F`, POSIX process groups) and admission control from the PC's real memory headroom (B-078 T10:
// commit headroom and cores, system/headroom.ts – no longer free physical RAM alone) (B-057: background work –
// split turns – waits behind the agents' own turns, which may borrow one slot when only background work holds them).
// Login guard 03.11.: a lease can end gently (releaseAfter: the process exits by itself, its tree is killed only after a
// grace) and a group runs one lease at a time (spawnAlone; none starts any more once killAll ran) – for CLIs that may be
// saving a sign-in (accounts/cli.ts).
// I02: an optional env decorator (`env`) is applied to every spawned env – composition gives it the
// safe git env (git/safe-env.ts), so no engine, CLI or sign-in process runs repository hooks.
// Never: decides *what* to run (engines/accounts do) or polls – timers are per lease and reset by activity.

import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeOs from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { heavySlotsFor, readMemory, type MemorySnapshot } from './headroom.ts';

/** The part of ChildProcess the runtime uses (fakes in tests implement just this). */
export interface ChildLike {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: Array<'pipe' | 'ignore'>;
  windowsHide?: boolean;
  detached?: boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface OsLike {
  freemem(): number;
  /** B-078 T10: the PC's real headroom (headroom.ts readMemory); without it maxHeavy reads freemem alone. */
  memory?(): MemorySnapshot;
  cpuCount(): number;
  setPriority(pid: number, priority: number): void;
  platform: NodeJS.Platform;
}

export interface LeaseInfo {
  id: number;
  owner: string; // e.g. "codex:acc_…", "claude:run_…"
  kind: 'heavy' | 'light';
  pid?: number;
  startedAt: number;
  lastActiveAt: number;
}

export interface Lease extends LeaseInfo {
  child: ChildLike;
  /** spawnAlone: at most one running lease of this group. */
  group?: string;
  /** Marks activity (resets the idle timer). */
  touch(): void;
  /** Kills the process tree and ends the lease. Idempotent. */
  release(): Promise<void>;
  /** Lets the process exit by itself; kills its tree like release() only if it still runs after graceMs. Resolves when it is gone. */
  releaseAfter(graceMs: number): Promise<void>;
  /** Resolves when the process has exited. */
  exited: Promise<number | null>;
}

export interface SpawnInput {
  command: string; args: string[]; owner: string; kind?: 'heavy' | 'light'; cwd?: string; env?: NodeJS.ProcessEnv; stdio?: Array<'pipe' | 'ignore'>;
  idleMs?: number; onIdle?: () => void; group?: string;
}

const MB = 1024 * 1024;

export function defaultOs(): OsLike {
  return {
    freemem: () => nodeOs.freemem(),
    memory: () => readMemory(process.platform),
    cpuCount: () => nodeOs.availableParallelism?.() ?? nodeOs.cpus().length,
    setPriority: (pid, priority) => nodeOs.setPriority(pid, priority),
    platform: process.platform,
  };
}

export interface SupervisorDeps {
  spawn?: SpawnFn;
  os?: OsLike;
  now?: () => number;
  /** Kill a process tree; default uses taskkill on Windows and process groups elsewhere. */
  killTree?: (pid: number) => Promise<void>;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
  /** I02: decorates every child's env (undefined = the inherited env); e.g. the safe git env. */
  env?: (env: NodeJS.ProcessEnv | undefined) => NodeJS.ProcessEnv;
}

export class Supervisor {
  private readonly spawnFn: SpawnFn;
  private readonly os: OsLike;
  private readonly now: () => number;
  private readonly killTreeFn: (pid: number) => Promise<void>;
  readonly log?: SupervisorDeps['log']; // B-052: also the Codex server's short notes
  private readonly envFn?: SupervisorDeps['env'];
  private readonly active = new Map<number, Lease>();
  private sequence = 0;
  private heavySlots = 0;
  /** B-057: how many of the held heavy slots are background work (split turns). */
  private backgroundSlots = 0;
  /** B-057: an agent's own turn holds the one slot beyond maxHeavy (see admit). */
  private borrowed = false;
  private waiters: Array<() => void> = [];
  /** B-057: background waiters (split turns) – woken only when no other waiter waits. */
  private later: Array<() => void> = [];
  /** Set by killAll (shutdown): a spawnAlone still waiting starts nothing – the runtime's exit would kill it at once. */
  private stopping = false;

  constructor(deps: SupervisorDeps = {}) {
    this.spawnFn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options as Parameters<typeof nodeSpawn>[2]) as unknown as ChildLike);
    this.os = deps.os ?? defaultOs();
    this.now = deps.now ?? Date.now;
    this.log = deps.log;
    this.envFn = deps.env;
    this.killTreeFn = deps.killTree ?? ((pid) => this.defaultKillTree(pid));
  }

  /**
   * Like spawn, once no lease of `input.group` runs any more (the last check and the spawn are one synchronous step).
   * After killAll it rejects instead: a waiter woken by the shutdown's kill would start a process the exit kills hard.
   */
  async spawnAlone(input: SpawnInput & { group: string }): Promise<Lease> {
    for (let held = this.holder(input.group); held; held = this.holder(input.group)) await held.exited;
    if (this.stopping) throw new Error('The app is stopping: no new process.');
    return this.spawn(input);
  }

  private holder(group: string): Lease | undefined {
    for (const lease of this.active.values()) if (lease.group === group) return lease;
    return undefined;
  }

  /** Starts a child process as a lease. `idleMs` kills it after that long without `touch()`. */
  spawn(input: SpawnInput): Lease {
    const posix = this.os.platform !== 'win32';
    const child = this.spawnFn(input.command, input.args, {
      cwd: input.cwd, env: this.envFn ? this.envFn(input.env) : input.env, stdio: input.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: posix, // own process group so the whole tree can be killed
    });
    if (child.pid) {
      try { this.os.setPriority(child.pid, nodeOs.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    }
    const id = ++this.sequence;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    let retiring: Promise<void> | undefined;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    const lease: Lease = {
      id, owner: input.owner, kind: input.kind ?? 'heavy', pid: child.pid, startedAt: this.now(), lastActiveAt: this.now(), child, exited,
      ...(input.group ? { group: input.group } : {}),
      touch: () => {
        lease.lastActiveAt = this.now();
        if (input.idleMs) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { input.onIdle?.(); void lease.release(); }, input.idleMs);
          idleTimer.unref?.();
        }
      },
      release: async () => {
        if (released) return exited.then(() => undefined);
        released = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (child.exitCode === null && child.pid) {
          try { await this.killTreeFn(child.pid); } catch (error) { this.log?.warn('kill tree failed', { owner: input.owner, error: String(error) }); }
        }
        if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
        // Do not hang shutdown on a process that ignores signals.
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref?.())]);
      },
      releaseAfter: (graceMs) => retiring ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) this.log?.warn('process still running after its grace: killing its tree', { owner: input.owner });
          void lease.release();
        }, graceMs);
        timer.unref?.();
        void exited.then(() => { clearTimeout(timer); resolve(); });
      }),
    };
    const finish = (code: number | null) => {
      if (idleTimer) clearTimeout(idleTimer);
      this.active.delete(id);
      resolveExit(code);
    };
    child.once('exit', (code) => finish(code));
    child.once('error', () => finish(null));
    this.active.set(id, lease);
    lease.touch();
    return lease;
  }

  leases(): LeaseInfo[] {
    return [...this.active.values()].map(({ id, owner, kind, pid, startedAt, lastActiveAt }) => ({ id, owner, kind, pid, startedAt, lastActiveAt }));
  }

  /** Current capacity for heavy work (turns that run engine processes), from the PC's real headroom (headroom.ts). */
  maxHeavy(): number {
    const memory = this.os.memory?.() ?? { availableMb: this.os.freemem() / MB, exact: this.os.platform === 'linux' };
    return heavySlotsFor(memory, this.os.cpuCount());
  }

  /** True when a heavy slot is free right now. */
  canAdmit(): boolean {
    return this.heavySlots < this.maxHeavy();
  }

  /**
   * Waits for a heavy slot (event-driven: woken when a slot is released, no polling).
   * Returns the release function. Rejects when the signal aborts.
   * B-057 S12: `background` (a split's turn) waits behind every other waiter – a freed slot goes to the agents' own
   * turns (the person's replies) first, and a background turn never takes a slot while one of those waits. An agent's
   * own turn never waits behind background work alone: when no slot is free and every held slot is background work, it
   * takes one slot beyond maxHeavy (one such borrowed slot at a time; released like any other). Background never borrows.
   */
  async admit(signal?: AbortSignal, options: { background?: boolean } = {}): Promise<() => void> {
    const background = options.background === true;
    let borrowed = false;
    while (!this.canAdmit() || (background && this.waiters.length > 0)) {
      if (!background && this.mayBorrow()) { borrowed = true; break; } // B-057 S12: the person is never blocked by split work
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const queue = () => (background ? this.later : this.waiters);
        const wake = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = () => {
          if (background) this.later = this.later.filter((w) => w !== wake);
          else this.waiters = this.waiters.filter((w) => w !== wake);
          reject(signal!.reason);
        };
        queue().push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.heavySlots++;
    if (background) this.backgroundSlots++;
    if (borrowed) this.borrowed = true;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.heavySlots--;
      if (background) this.backgroundSlots--;
      if (borrowed) this.borrowed = false;
      const next = this.waiters.shift() ?? this.later.shift();
      next?.();
    };
  }

  /** B-057 S12: the one slot beyond maxHeavy is free and every held slot is background work (split turns). */
  private mayBorrow(): boolean {
    return !this.borrowed && this.heavySlots > 0 && this.backgroundSlots === this.heavySlots;
  }

  /** Re-checks waiters (call after RAM was freed outside the supervisor, e.g. a lease ended); the agents' own turns first. */
  nudge(): void {
    const waiting = [...this.waiters, ...this.later];
    this.waiters = [];
    this.later = [];
    for (const wake of waiting) wake();
  }

  async killAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.active.values()].map((lease) => lease.release()));
  }

  private defaultKillTree(pid: number): Promise<void> {
    if (this.os.platform === 'win32') {
      return new Promise((resolve) => {
        const killer = this.spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
      });
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { /* group gone */ }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
      timer.unref?.();
      resolve();
    });
  }
}
