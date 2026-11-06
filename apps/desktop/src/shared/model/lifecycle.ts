// Data lifecycle (LIFECYCLE, 23.10.2026): how long derived data is kept (the Settings section `lifecycle`, joined by
// module augmentation), the result of a retention pass and the copies outside the database a restore leaves behind.
// Owns: these shapes and retentionOf. Never: reads, validates or stores anything (runtime/privacy/*).

/** Kept derived data; 0 = keep until deleted by hand. */
export interface RetentionSettings {
  /** Tool traces of finished runs (run items and their work episodes) older than this many days are deleted; open effects stay. */
  traceDays: number;
  /** Corrected or expired knowledge versions older than this many days are deleted (the current version stays). */
  historyDays: number;
}

export const DEFAULT_RETENTION: Readonly<RetentionSettings> = { traceDays: 0, historyDays: 0 };
export const MAX_RETENTION_DAYS = 3650;

/** Settings › lifecycle (absent in settings stored before it – read with the defaults). */
export interface LifecycleSettings {
  retention?: Partial<RetentionSettings>;
}

/** A copy this app cannot remove (or only by a separate step), named honestly. */
export interface RemainingCopy {
  kind: 'message' | 'provider' | 'backup' | 'export' | 'device' | 'file' | 'trace';
  label: string;
  detail: string;
  /** A folder of this PC (backups, exports) – owner only. */
  path?: string;
  at?: number;
}

export interface RetentionResult {
  traces: number;
  episodes: number;
  versions: number;
  at: number;
}

declare module './system.ts' {
  interface Settings {
    /** LIFECYCLE: retention of derived data (absent = keep). */
    lifecycle?: LifecycleSettings;
  }
}

/** The retention in force (missing parts: keep). */
export function retentionOf(settings: { lifecycle?: LifecycleSettings } | undefined): RetentionSettings {
  return { ...DEFAULT_RETENTION, ...(settings?.lifecycle?.retention ?? {}) };
}
