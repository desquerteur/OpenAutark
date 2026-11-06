// Portability: "Export" of an agent (agents.ts), backup = a copy of the data folder (backup.ts)
// and restore = put it back at the next start (restore.ts).
// Owns: the entry points behind agents.export, system.backup/restore/restoreStatus/restartRuntime.
// Never: overwrites the live database while it is open (restore only stages).

import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { RestoreStatus } from '../../shared/model/restore.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { RuntimeServices } from '../contracts.ts';
import { exportAgentFile } from './agents.ts';
import { MANIFEST_FILE, checkBackup, createBackup, inBackupArea, isInside } from './backup.ts';
import { restoreStatusOf, stageRestore } from './restore.ts';

export interface PortabilityDeps {
  services: () => RuntimeServices;
}

export class Portability {
  private readonly deps: PortabilityDeps;
  private backingUp: Promise<unknown> | undefined;

  constructor(deps: PortabilityDeps) {
    this.deps = deps;
  }

  /** "Export": the agent with its folder's text files and (by default) its own notes as one JSON file. */
  async exportAgent(id: string, opts: { includeKnowledge?: boolean } = {}): Promise<FileRef> {
    return exportAgentFile(this.deps.services(), id, opts.includeKnowledge ?? true);
  }

  /** A copy of the data folder (default <data>/backups/<yyyy-mm-dd-hhmm>/); one at a time. */
  async backup(dir?: string): Promise<{ path: string; bytes: number }> {
    if (this.backingUp) throw new WorkforceError('conflict', 'A backup is already running.');
    const s = this.deps.services();
    const run = createBackup({ db: s.db, paths: s.paths, now: s.clock.now(), log: s.log, dir });
    this.backingUp = run;
    try {
      const result = await run;
      return { path: result.path, bytes: result.bytes };
    } finally {
      this.backingUp = undefined;
    }
  }

  /** Checks a backup folder (or its manifest.json) and stages it for the next start. */
  async restore(target: string): Promise<{ ok: true; restartRequired: true }> {
    const s = this.deps.services();
    const folder = path.basename(target) === MANIFEST_FILE ? path.dirname(target) : path.resolve(target);
    if (isInside(folder, s.paths.data) && !inBackupArea(folder, s.paths.data)) throw new WorkforceError('bad_request', 'Choose a backup outside the data folder.');
    checkBackup(folder);
    stageRestore(s.paths.data, folder, s.clock.now());
    s.log.info('restore staged', { folder });
    return { ok: true, restartRequired: true };
  }
}

/** system.restoreStatus: a staged restore, the last one a start applied or refused, and whether the app can restart itself. */
export function restoreStatus(s: Pick<RuntimeServices, 'paths' | 'host'>): RestoreStatus {
  return restoreStatusOf(s.paths.data, typeof s.host.restart === 'function');
}

/** system.restartRuntime: the host stops this runtime and starts it again (a staged restore is applied by that start). */
export async function restartRuntime(s: Pick<RuntimeServices, 'host' | 'log'>): Promise<{ ok: true }> {
  if (typeof s.host.restart !== 'function') throw new WorkforceError('unavailable', 'This runtime cannot restart itself. Restart Autark to finish.');
  s.log.info('restart requested');
  await s.host.restart();
  return { ok: true };
}
