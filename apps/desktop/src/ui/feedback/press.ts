// B-055 Q4: one press on the header's feedback cell, two meanings. Pointer down is reported first
// (`press`: the cell takes the window's screenshot before anything opens). Released before HOLD_MS
// it is a tap (`tap`: the menu opens or closes); held HOLD_MS or longer it is talk (`holdStart`
// when the hold is recognized – dictation starts –, `holdEnd` on release, `holdCancel` when the
// pointer is taken away or Escape ends it). Without dictation (`canHold` false) every press is a
// tap, however long. Enter/Space (a click without a pointer) is always a tap.
// Owns: the press/hold decision. Never: captures, dictates or opens anything itself.

/** Pressing longer than this is a hold (talk here, hold-to-talk on the mic button); shorter is a tap. */
export const HOLD_MS = 300;

export type PressPhase = 'idle' | 'down' | 'holding';
/** 'pointer': the press reported `press` before (the screenshot is on its way); 'key': it did not. */
export type TapSource = 'pointer' | 'key';

export interface PressEvents {
  press(): void;
  tap(source: TapSource): void;
  holdStart(): void;
  holdEnd(): void;
  holdCancel(): void;
}

/** Runs `run` after `ms`; returns the cancel. */
export type Schedule = (run: () => void, ms: number) => () => void;

const timer: Schedule = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export class PressTracker {
  private readonly events: PressEvents;
  private readonly canHold: () => boolean;
  private readonly schedule: Schedule;
  private readonly holdMs: number;
  private state: PressPhase = 'idle';
  private disarm: (() => void) | null = null;

  constructor(events: PressEvents, options: { canHold: () => boolean; schedule?: Schedule; holdMs?: number }) {
    this.events = events;
    this.canHold = options.canHold;
    this.schedule = options.schedule ?? timer;
    this.holdMs = options.holdMs ?? HOLD_MS;
  }

  get phase(): PressPhase {
    return this.state;
  }

  /** Pointer down (primary button): reports the press and arms the hold. A second pointer is ignored. */
  down(): void {
    if (this.state !== 'idle') return;
    this.state = 'down';
    this.events.press();
    if (this.state === 'down' && this.canHold()) this.disarm = this.schedule(() => this.held(), this.holdMs);
  }

  /** Pointer up: a tap before the hold, the end of the talk after it. */
  up(): void {
    const was = this.reset();
    if (was === 'down') this.events.tap('pointer');
    else if (was === 'holding') this.events.holdEnd();
  }

  /** Pointer cancelled or Escape: a pending press does nothing, a running talk is discarded. */
  cancel(): void {
    if (this.reset() === 'holding') this.events.holdCancel();
  }

  /** A click without a pointer press (Enter/Space, a screen reader): a tap. */
  key(): void {
    if (this.state === 'idle') this.events.tap('key');
  }

  private held(): void {
    this.disarm = null;
    if (this.state !== 'down') return;
    this.state = 'holding';
    this.events.holdStart();
  }

  private reset(): PressPhase {
    const was = this.state;
    this.state = 'idle';
    this.disarm?.();
    this.disarm = null;
    return was;
  }
}
