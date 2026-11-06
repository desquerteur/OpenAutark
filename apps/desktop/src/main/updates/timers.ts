// Named one-shot timers for the update service (check, restart countdown, install watchdog).
// Tests inject now/setTimer/clearTimer; without them real, unref'd timeouts are used.
// Owns: arming, replacing and clearing a timer by name. Never: intervals – every timer fires
// once and its owner re-arms it when needed.

export interface TimerHooks {
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class NamedTimers<K extends string> {
  private readonly hooks: TimerHooks;
  private readonly handles = new Map<K, unknown>();

  constructor(hooks: TimerHooks) {
    this.hooks = hooks;
  }

  now(): number { return this.hooks.now ? this.hooks.now() : Date.now(); }

  has(name: K): boolean { return this.handles.has(name); }

  /** Replaces the timer of that name; it is gone (has() false) before fn runs. */
  set(name: K, fn: () => void, ms: number): void {
    this.clear(name);
    const run = () => { this.handles.delete(name); fn(); };
    if (this.hooks.setTimer) {
      this.handles.set(name, this.hooks.setTimer(run, ms));
      return;
    }
    const handle = setTimeout(run, ms);
    handle.unref?.();
    this.handles.set(name, handle);
  }

  clear(name: K): void {
    if (!this.handles.has(name)) return;
    const handle = this.handles.get(name);
    this.handles.delete(name);
    if (this.hooks.clearTimer) this.hooks.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
