// What the app window does when its page (the renderer process) is gone: a clean exit or a killed process is
// left alone (show() – tray "Open" – loads it again); any other crash reloads the page, at most MAX_RELOADS
// times within WINDOW_MS – then main stops and tells the person (a dialog with "Try again"). The system refusing
// the renderer's code (integrity-failure) is never retried: reloading cannot fix it.
// Owns: this decision and the dialog text. Never: imports electron or touches a window.

export type CrashStep =
  | { kind: 'ignore' }
  | { kind: 'reload'; delayMs: number }
  | { kind: 'stuck'; why: 'repeated' | 'blocked' };

/** Crashes within this time count together. */
export const WINDOW_MS = 60_000;
/** Reloads within WINDOW_MS before the person is asked. */
export const MAX_RELOADS = 2;
const DELAY_MS = 1000;

export class RendererRecovery {
  private readonly now: () => number;
  private crashes: number[] = [];

  constructor(options: { now(): number }) {
    this.now = options.now;
  }

  /** A fresh start: a new window, or the person asked to open it again. */
  reset(): void {
    this.crashes = [];
  }

  /** The renderer is gone for `reason` (Electron's render-process-gone reason). */
  gone(reason: string): CrashStep {
    if (reason === 'clean-exit' || reason === 'killed') return { kind: 'ignore' };
    if (reason === 'integrity-failure') return { kind: 'stuck', why: 'blocked' };
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < WINDOW_MS), now];
    return this.crashes.length > MAX_RELOADS ? { kind: 'stuck', why: 'repeated' } : { kind: 'reload', delayMs: DELAY_MS };
  }
}

/** The dialog main shows when it stops reloading (agents keep working meanwhile). */
export function stuckDialog(why: 'repeated' | 'blocked'): { message: string; detail: string; buttons: [string, string] } {
  const detail = why === 'blocked'
    ? 'The system blocked the window\'s code, so it cannot be shown. Agents keep working in the background. Reinstalling the app may help.'
    : 'It stopped several times in a minute. Agents keep working in the background.';
  return { message: 'The window stopped working', detail, buttons: ['Try again', 'Close window'] };
}
