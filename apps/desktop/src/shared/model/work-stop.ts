// The person's emergency stop of all agent work on one PC (21.10. 17:09: no everyday Stop in the
// chat, but a separate brake that really stops real actions) – the state the runtime reports
// (agents/work-stop.ts) and the window/phone/tray show (ui/shell/work-stop.ts, main/work-stop.ts).
// Owns: the state shape and the global shortcut names. Never: behaviour.

export interface WorkStopState {
  /** No agent turn runs on this PC until the person resumes. */
  stopped: boolean;
  /** When it was stopped or resumed last (runtime clock). */
  at: number;
  /** The paired phone or browser that pressed it (absent: this PC). */
  stoppedFrom?: string;
  /** Turns the stop cut off. */
  stoppedRuns?: number;
  /** Agent turns run on this PC now, or calls of linked PCs run here (not stored; main offers the global shortcut only then). */
  working?: boolean;
}

/** The global emergency-stop shortcut while agents work on this PC (Electron accelerator syntax; main/work-stop.ts). */
export const WORK_STOP_ACCELERATOR = 'Control+Alt+Shift+X';
/** The same shortcut as people read it (tray menu). */
export const WORK_STOP_KEYS = 'Ctrl+Alt+Shift+X';