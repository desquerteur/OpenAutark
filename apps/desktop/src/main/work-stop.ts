// The person's emergency stop of all agent work on the main side (23.10.): reachable while the window
// is hidden – the tray's "Stop all agent work" (always, while the runtime is up; "Resume agent work"
// while stopped) and the global shortcut Ctrl+Alt+Shift+X, registered ONLY while agents work on this
// PC (WorkStopState.working), so it never takes the keys from other apps otherwise. One process holds the
// keys; another company on this PC tries again until the holder lets them go (B-072). It also cuts
// computer input (the runtime's latch does both). It acts at once, without a confirmation: four keys or
// a menu click are the deliberate act. A system notice afterwards says what happened (and when the stop failed).
// Follows `work.state` on the 'system' topic and loads the state once the runtime is up; a runtime that
// went away drops the shortcut and the tray entry.
// Owns: shortcut registration, the tray view of the stop and the notice. Never: decides anything itself
// (the runtime's latch does, agents/work-stop.ts), imports electron at runtime (desktop.ts passes
// globalShortcut and the notice in), or resumes from the shortcut.

import type { EventMap } from '../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../shared/api/methods.ts';
import type { Topic } from '../shared/api/protocol.ts';
import { WORK_STOP_ACCELERATOR, type WorkStopState } from '../shared/model/work-stop.ts';

/** How often a wanted but taken shortcut is tried again (one process on this PC holds the keys). */
const RETRY_MS = 10_000;

/** electron's globalShortcut (passed in by desktop.ts). */
export interface ShortcutRegistry { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }

export interface WorkStopRpc {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  on<E extends 'work.state'>(event: E, listener: (data: EventMap[E]) => void): () => void;
  subscribe(topic: Topic): Promise<() => void>;
}

/** What the tray shows: nothing (runtime down), Stop (with the shortcut while it is registered), or stopped (Resume). */
export type TrayWorkStop = { kind: 'ready'; shortcut: boolean } | { kind: 'stopped'; from?: string } | null;

export interface WorkStopControlDeps {
  rpc: WorkStopRpc;
  shortcut: ShortcutRegistry;
  tray: { setWorkStop(view: TrayWorkStop): void };
  /** A system notification (clicking it opens the window). */
  notify(title: string, body: string): void;
  log(line: string): void;
}

/** The notice after the person's stop from the tray or the shortcut. */
export function stopNotice(state: WorkStopState): { title: string; body: string } {
  const runs = state.stoppedRuns ?? 0;
  const ended = runs > 0 ? `${runs} running ${runs === 1 ? 'turn was' : 'turns were'} ended. ` : '';
  return { title: 'Agent work stopped', body: `${ended}Nothing runs until you press Resume (tray or window).` };
}

export class WorkStopControl {
  private readonly deps: WorkStopControlDeps;
  private registered = false;
  private wanted = false;
  private started = false;
  private state: WorkStopState | undefined;
  private stopping: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;

  constructor(deps: WorkStopControlDeps) {
    this.deps = deps;
  }

  /** Subscribes once (the RpcClient restores the topic after reconnects), then loads the state. */
  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.deps.rpc.on('work.state', (state) => this.apply(state));
      await this.deps.rpc.subscribe('system');
    }
    this.apply(await this.deps.rpc.call('work.state'));
  }

  /** The runtime stopped or restarts: no shortcut, no tray entry until it is up again. */
  reset(): void {
    this.state = undefined;
    this.render();
  }

  /** The person's stop (shortcut or tray): at once, then a notice – once while a stop is on its way (a double press, tray plus keys). */
  stop(): Promise<void> {
    this.stopping ??= this.stopOnce().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async stopOnce(): Promise<void> {
    try {
      const state = await this.deps.rpc.call('work.stop');
      this.apply(state);
      const notice = stopNotice(state);
      this.deps.notify(notice.title, notice.body);
    } catch (error) {
      this.deps.log(`agent work not stopped: ${errorText(error)}`);
      this.deps.notify('Agent work was not stopped', 'Try again from the tray, or use Stop all agent work in the window.');
    }
  }

  /** The person's Resume (tray). */
  async resume(): Promise<void> {
    try { this.apply(await this.deps.rpc.call('work.resume')); } catch (error) { this.deps.log(`agent work not resumed: ${errorText(error)}`); }
  }

  dispose(): void {
    this.setShortcut(false);
  }

  private apply(state: WorkStopState): void {
    // An event may arrive after a newer answer: the later change wins (a `working` flip keeps `at`).
    if (this.state && state.at < this.state.at) return;
    this.state = state;
    this.render();
  }

  private render(): void {
    const state = this.state;
    this.setShortcut(Boolean(state && !state.stopped && state.working));
    this.deps.tray.setWorkStop(!state ? null : state.stopped ? { kind: 'stopped', ...(state.stoppedFrom ? { from: state.stoppedFrom } : {}) } : { kind: 'ready', shortcut: this.registered });
  }

  private setShortcut(on: boolean): void {
    if (on && !this.registered) {
      // Tried again on each change and every RETRY_MS: whoever holds the keys (another company on this PC
      // whose agents went idle, or an app) may let them go. Meanwhile the tray and the window offer the stop.
      try { this.registered = this.deps.shortcut.register(WORK_STOP_ACCELERATOR, () => { void this.stop(); }); } catch { this.registered = false; }
      if (!this.registered && !this.wanted) this.deps.log('agent work: the stop shortcut is taken by another app or company');
    } else if (!on && this.registered) {
      try { this.deps.shortcut.unregister(WORK_STOP_ACCELERATOR); } catch { /* already gone */ }
      this.registered = false;
    }
    this.wanted = on;
    this.keepTrying(on && !this.registered);
  }

  /** A quiet retry while the keys are wanted but held elsewhere (unref'd: it never keeps the process alive). */
  private keepTrying(on: boolean): void {
    if (on === (this.retry !== undefined)) return;
    if (on) {
      this.retry = setInterval(() => this.render(), RETRY_MS);
      this.retry.unref?.();
      return;
    }
    clearInterval(this.retry);
    this.retry = undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'error';
}
