// Graceful quit: ordered steps (renderer drafts, updater timers, runtime drain), each
// bounded by a timeout so a hung part can never keep the app alive.
// Owns: the quit order, running the steps and the overall cap. Never: calls app.quit itself
// or touches Electron (the actions are passed in).

export interface ShutdownStep {
  name: string;
  run(): unknown;
  timeoutMs?: number; // default 5 s
}

export interface ShutdownOptions {
  log?(line: string): void;
  totalMs?: number; // overall cap, default 20 s
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

function bounded(promise: Promise<unknown>, ms: number, options: ShutdownOptions): Promise<'done' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const set = options.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
    const clear = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const timer = set(() => resolve('timeout'), ms);
    promise.then(() => { clear(timer); resolve('done'); }, error => { clear(timer); reject(error); });
  });
}

/** Runs the steps in order; failures and timeouts are logged and skipped. */
export async function runShutdown(steps: readonly ShutdownStep[], options: ShutdownOptions = {}): Promise<void> {
  const all = (async () => {
    for (const step of steps) {
      try {
        const outcome = await bounded(Promise.resolve().then(() => step.run()), step.timeoutMs ?? 5000, options);
        if (outcome === 'timeout') options.log?.(`shutdown step "${step.name}" timed out`);
      } catch (error) {
        options.log?.(`shutdown step "${step.name}" failed: ${(error as Error)?.message ?? 'error'}`);
      }
    }
  })();
  const outcome = await bounded(all, options.totalMs ?? 20_000, options);
  if (outcome === 'timeout') options.log?.('shutdown did not finish in time; quitting anyway');
}

export interface QuitActions {
  /** An update install already drained renderer and runtime. */
  drained: boolean;
  flushDrafts(): unknown;
  disposeUpdates(): unknown;
  stopRuntime(): unknown;
  releasePower(): unknown;
  destroyTray(): unknown;
}

/** Quit order: drafts → updater timers → runtime drain → leftovers. */
export function quitSteps(actions: QuitActions): ShutdownStep[] {
  const final: ShutdownStep[] = [
    { name: 'power', run: actions.releasePower },
    { name: 'tray', run: actions.destroyTray },
  ];
  if (actions.drained) return [{ name: 'updates', run: actions.disposeUpdates }, ...final];
  return [
    { name: 'drafts', run: actions.flushDrafts, timeoutMs: 4000 },
    { name: 'updates', run: actions.disposeUpdates },
    { name: 'runtime', run: actions.stopRuntime, timeoutMs: 10_000 },
    ...final,
  ];
}
