// Which agent last worked in which window of this PC (B-055 Q10): a step in a window another
// agent used less than WINDOW_NOTE_MS ago gets one factual line in its result ("Ada (agent) worked
// in this window 12 s ago."), so agents notice each other and split the work themselves – no
// rule beyond that information. Also the window titles this PC's outputs showed (the lease's
// refusal names the holder's window by them).
// Owns: the in-memory window → last agent table (bounded, newest kept), the titles and the note.
// Never: refuses anything (lease.ts does), stores anything, or names what the other agent did.

import type { ComputerCaller } from './lease.ts';

export const WINDOW_NOTE_MS = 60_000;
const MAX_WINDOWS = 200;

export class WindowMemory {
  private readonly used = new Map<number, { caller: ComputerCaller; at: number }>();
  private readonly titles = new Map<number, string>();
  private readonly now: () => number;

  constructor(deps: { now: () => number }) {
    this.now = deps.now;
  }

  /** A window and its title as an output showed them. */
  title(hwnd: number | undefined, title: string | undefined): void {
    if (hwnd === undefined || !hwnd || !title) return;
    this.titles.delete(hwnd);
    this.titles.set(hwnd, title);
    if (this.titles.size > MAX_WINDOWS) this.titles.delete(this.titles.keys().next().value as number);
  }

  titleOf(hwnd: number): string | undefined {
    return this.titles.get(hwnd);
  }

  /** The note for `caller` about window `hwnd` ('' when nobody else worked there lately) – reading only. */
  note(caller: ComputerCaller | undefined, hwnd: number | undefined): string {
    if (!caller || hwnd === undefined || !hwnd) return '';
    const last = this.used.get(hwnd);
    if (!last || last.caller.key === caller.key) return '';
    const ago = this.now() - last.at;
    if (ago >= WINDOW_NOTE_MS) return '';
    const seconds = Math.max(0, Math.round(ago / 1000));
    return `${last.caller.name} (agent) worked in this window ${seconds < 2 ? 'just now' : `${seconds} s ago`}.`;
  }

  /** `caller` acted in window `hwnd`: returns the note about the agent before it, then remembers this step. */
  use(caller: ComputerCaller | undefined, hwnd: number | undefined): string {
    const note = this.note(caller, hwnd);
    if (!caller || hwnd === undefined || !hwnd) return note;
    this.used.delete(hwnd);
    this.used.set(hwnd, { caller, at: this.now() });
    if (this.used.size > MAX_WINDOWS) this.used.delete(this.used.keys().next().value as number);
    return note;
  }
}
