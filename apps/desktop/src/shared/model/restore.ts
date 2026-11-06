// Restore status as Settings › About › Backup shows it (system.restoreStatus, MM7).
// Owns: the shape. Never: secret values, tokens or paths other than the backup folder the person
// chose.

export interface RestoreStatus {
  /** A restore waits for the next start (system.restore staged it). */
  staged?: { path: string; stagedAt: number };
  /** The last restore a start of this installation applied – or refused, with the reason. */
  last?: {
    ok: boolean;
    at: number;
    /** The backup folder. */
    from: string;
    /** When the backup was made. */
    backupAt?: number;
    /** Why it was not applied (the data stayed as it was). */
    error?: string;
    /** What the person sets up again (each is a to-do); absent until the runtime finished the restore. B-044: `homes` –
     *  approved home projects of another PC the restore cleared (approved again on this PC). */
    reentry?: { accounts: number; secrets: number; devices: number; homes: number };
  };
  /** This app can restart its runtime itself (system.restartRuntime); otherwise restart Workforce by hand. */
  canRestart: boolean;
}
