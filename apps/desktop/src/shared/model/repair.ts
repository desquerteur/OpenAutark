// Repair after a broken upgrade or a crash loop at start (23.10.2026): the plain-data shapes shared
// by runtime and UI and the RPC shapes of repair.state / repair.retry / repair.restore /
// repair.diagnostics, merged into Methods by module augmentation (api/methods.ts is at its size
// limit). While the runtime runs in repair mode it serves only these and session.info; the app
// shows the repair screen instead of the shell, without the overlay and its plugins.
// Owns: the shapes. Never: behaviour (runtime/repair/*, runtime/db/upgrade.ts, ui/repair/*).

/** Why this start shows the repair screen. */
export type StartProblemCode =
  | 'migration_failed' // the data could not be updated to this version's schema
  | 'schema_newer' // the data was written by a newer app version
  | 'backup_failed' // the safety copy before the update could not be made (nothing was migrated)
  | 'data_unreadable' // the database file is damaged or not a database
  | 'crash_loop'; // several starts in a row ended before the runtime was stable

export interface StartProblem {
  code: StartProblemCode;
  /** Short, redacted English text of the underlying error (never a stack trace or a secret). */
  detail?: string;
  /** The app version that hit the problem. */
  version: string;
  /** Schema the data has, and the schema this app expects (upgrade problems). */
  dataSchema?: number;
  appSchema?: number;
  /** Starts in a row that ended before the runtime was stable (crash loop). */
  attempts?: number;
  at: number;
}

/** One consistent copy of the data taken right before a new app version migrated it. */
export interface UpgradeBackupInfo {
  /** File name without extension (`<version>-s<schema>`). */
  id: string;
  /** The app version that made the copy (before it migrated). */
  appVersion: string;
  /** The data's schema in the copy. */
  schema: number;
  bytes: number;
  createdAt: number;
  /** When the migration from this copy's data finished (absent: it failed or has not finished yet). */
  migratedAt?: number;
  /** Made from data an incomplete update had left behind (not a state a released version wrote cleanly). */
  partial?: true;
}

export interface RepairState {
  /** True while the runtime runs in repair mode (the repair screen replaces the app). */
  active: boolean;
  problem?: StartProblem;
  /** Newest first. */
  backups: UpgradeBackupInfo[];
  /** Schema this app version migrates to. */
  appSchema: number;
}

export interface DiagnosticsExport {
  /** Where the redacted text file was written (inside the data folder). */
  path: string;
  bytes: number;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: whether this start runs in repair mode, why, and the copies from before updates. */
    'repair.state': { params: void; result: RepairState };
    /** Owner, repair mode only: start normally again (the runtime restarts). */
    'repair.retry': { params: void; result: { ok: true } };
    /** Owner, repair mode only: put the copy `id` back as the live data (the replaced data is kept in `kept`), then restart. */
    'repair.restore': { params: { id: string }; result: { ok: true; kept: string } };
    /** Owner: a redacted diagnostics text file (versions, schema, start problem, copies, overlay, recent log), shown in the file manager. */
    'repair.diagnostics': { params: void; result: DiagnosticsExport };
  }
}
