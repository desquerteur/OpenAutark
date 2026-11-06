// B-044 "Keep agents running": the two small files beside the data that the OS launcher start of
// the app reads before anything else runs (main/launcher.ts) – <data>/next-due.json, written by the
// runtime's scheduler whenever it re-arms (runtime/schedules/next-due.ts), and <data>/run-state.json,
// written by main at start and on every deliberate quit.
// Owns: the file names and shapes. Never: reads or writes them (runtime and main do).

export const NEXT_DUE_FILE = 'next-due.json';
export const RUN_STATE_FILE = 'run-state.json';

/** When the earliest schedule or wake is due (epoch ms); null when nothing is. */
export interface NextDue {
  at: number | null;
}

/** Why the app was quit on purpose: the person (tray, menu, window), an update install, the system ending the session, the launcher's crash-loop cap. */
export type QuitBy = 'person' | 'update' | 'system' | 'launcher';

export interface RunState {
  state: 'running' | 'quit';
  at: number; // when this state was written
  pid?: number; // 'running': the main process
  by?: QuitBy; // 'quit'
  ends?: number[]; // unexpected ends noticed at later starts (last 30 min, at most 3)
  capped?: number; // the launcher stopped restarting at this time (until the person starts the app; Windows: a task start 30 minutes later)
}
