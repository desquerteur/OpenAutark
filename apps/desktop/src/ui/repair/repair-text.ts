// Wording and view rules of the repair screen (23.10.2026), pure so tests can check them: a title
// and one or two plain sentences per start problem, honest about what happened to the data (a copy
// from before the update is only mentioned when one this version can open exists), the label of
// each pre-update copy, which copies can be restored (not one newer than this app's schema), and
// which action still runs for the state on screen (a retry or restore stays busy only until the
// restarted runtime answers again – then every button works again, also when the same problem
// came back).
// Owns: the texts and those rules. Never: renders or calls the runtime (RepairScreen.tsx does).

import type { RepairState, StartProblem, UpgradeBackupInfo } from '../../shared/model/repair.ts';

export interface ProblemText { title: string; body: string[] }

export function problemText(problem: StartProblem, backups: readonly UpgradeBackupInfo[]): ProblemText {
  const kept = backups.length > 0;
  switch (problem.code) {
    case 'migration_failed':
      return {
        title: 'Your data could not be updated for this version',
        body: ['Nothing was deleted.', kept ? 'A copy of your data from before the update is kept and can be restored.' : 'Try again, or export diagnostics.'],
      };
    case 'schema_newer':
      return {
        title: 'Your data is from a newer version',
        body: ['This version cannot open data saved by a newer version of Autark. Install the newer version again' + (kept ? ', or restore a copy from before that update.' : '.')],
      };
    case 'backup_failed':
      return {
        title: 'The update could not start safely',
        body: ['Autark copies your data before updating it. The copy failed, so your data was not changed.', 'Free some disk space and try again.'],
      };
    case 'data_unreadable':
      return {
        title: 'Your data could not be read',
        body: [kept ? 'Restore a copy from before an update, or export diagnostics.' : 'Export diagnostics to find out more.'],
      };
    case 'crash_loop':
    default:
      return {
        title: 'Autark stopped while starting',
        body: [`It stopped ${problem.attempts ?? 'several'} times in a row before it was ready.`, kept ? 'Try again, or restore a copy from before the last update.' : 'Try again, or export diagnostics.'],
      };
  }
}

/**
 * "Before the update to 0.3.0 · 21 Oct 2026, 14:05" (the version that made the copy right before it
 * updated the data); a copy of data an incomplete update left behind says so.
 */
export function copyLabel(copy: UpgradeBackupInfo, date: (ms: number) => string): string {
  return `Before the update to ${copy.appVersion} · ${date(copy.createdAt)}${copy.partial ? ' · after an incomplete update' : ''}`;
}

/** A copy this version can open (restoring a newer one would only bring back "data from a newer version"). */
export function restorable(copy: UpgradeBackupInfo, appSchema: number): boolean {
  return copy.schema <= appSchema;
}

export type RepairAction = 'retry' | 'diagnostics' | `restore:${string}`;

/** The last action pressed on the screen, for the state it was pressed on. */
export interface LastAction {
  kind: RepairAction;
  /** The state on screen when it was pressed (identity: every answer of repair.state is a new object). */
  state: RepairState;
  /** False while it runs; a retry or restore that succeeded stays running until the runtime answers again. */
  done: boolean;
  note?: { text: string; error?: boolean };
}

export interface ScreenStatus { busy: RepairAction | null; note: { text: string; error?: boolean } | null }

/** What the screen shows for `last` while `state` is on screen. */
export function screenStatus(last: LastAction | null, state: RepairState): ScreenStatus {
  if (!last) return { busy: null, note: null };
  if (last.state === state) return { busy: last.done ? null : last.kind, note: last.note ?? null };
  // The restarted runtime answered: a new state, every button works again.
  if (last.kind === 'retry' && state.active && state.problem && state.problem.code === last.state.problem?.code) {
    return { busy: null, note: { text: 'Started again: the same problem came back.', error: true } };
  }
  return { busy: null, note: null };
}
