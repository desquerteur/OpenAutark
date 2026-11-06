// Repair service (23.10.2026): what the repair screen does. In repair mode (repair/server.ts – the
// runtime did not start: an upgrade problem or a crash loop) it reports the problem and the copies
// from before updates, starts normally again (Retry: the journal forgets the problem, the host
// restarts the runtime), puts a copy back as the live data (the replaced database files move to
// <data>/before-repair-<time>/, the newest KEEP_REPLACED such folders stay – safety-copies.ts –
// then restart; a copy newer than this app's schema is refused) and writes the diagnostics file.
// In normal mode (the same RPC methods on the full runtime) only state and diagnostics work.
// Owns: those four actions and the swap of the database files.
// Never: deletes the data it just replaced, touches blobs, theme.css or account homes (a
// migration changes none of them), runs a restore while the database is open (normal mode
// refuses), or counts an agent's call as the person's (the methods are owner-only).

import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { DiagnosticsExport, RepairState, StartProblem } from '../../shared/model/repair.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Logger } from '../contracts.ts';
import type { Host } from '../host.ts';
import { SCHEMA_VERSION } from '../db/migrate.ts';
import { listUpgradeBackups, upgradeBackupFile } from '../db/upgrade.ts';
import { stamp } from '../portability/backup.ts';
import { writeDiagnostics } from './diagnostics.ts';
import type { BootJournal } from './journal.ts';
import { pruneReplaced, REPLACED_PREFIX } from './safety-copies.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** Set only by the repair runtime (repair/server.ts): the start problem it shows. */
    repair?: RepairService;
  }
}

const DB_FILES = ['workforce.db', 'workforce.db-wal', 'workforce.db-shm'] as const;
const ONLY_REPAIR = 'This works only on the repair screen.';

export interface RepairDeps {
  dataDir: string;
  version: string;
  host: Pick<Host, 'restart' | 'openPath'>;
  journal: BootJournal;
  /** The problem of this start: set in repair mode, absent on a normal runtime. */
  problem?: StartProblem;
  now?: () => number;
  log?: Logger;
}

export class RepairService {
  private readonly deps: RepairDeps;
  private busy: Promise<unknown> | undefined;

  constructor(deps: RepairDeps) {
    this.deps = deps;
  }

  get active(): boolean { return this.deps.problem !== undefined; }

  state(): RepairState {
    return {
      active: this.active,
      ...(this.deps.problem ? { problem: this.deps.problem } : {}),
      backups: listUpgradeBackups(this.deps.dataDir),
      appSchema: SCHEMA_VERSION,
    };
  }

  /** Start normally again. */
  retry(): Promise<{ ok: true }> {
    return this.once(async () => {
      this.assertActive();
      this.deps.journal.clearRepair();
      this.deps.log?.info('repair: retry requested');
      await this.restart();
      return { ok: true as const };
    });
  }

  /** Put copy `id` back as the live data; the replaced files stay in the returned folder. */
  restore(id: string): Promise<{ ok: true; kept: string }> {
    return this.once(async () => {
      this.assertActive();
      const source = typeof id === 'string' ? upgradeBackupFile(this.deps.dataDir, id) : undefined;
      if (!source) throw new WorkforceError('not_found', 'This copy is no longer there.', { details: { id } });
      const copy = listUpgradeBackups(this.deps.dataDir).find((info) => info.id === id);
      if (copy && copy.schema > SCHEMA_VERSION) {
        throw new WorkforceError('conflict', 'This copy is from a newer version of Autark and cannot be opened here. Install that version to use it.', { details: { id, schema: copy.schema, appSchema: SCHEMA_VERSION } });
      }
      const kept = path.join(this.deps.dataDir, `${REPLACED_PREFIX}${stamp(this.now(), true)}`);
      mkdirSync(kept, { recursive: true, mode: 0o700 });
      const moved: string[] = [];
      try {
        for (const name of DB_FILES) {
          const file = path.join(this.deps.dataDir, name);
          if (!existsSync(file)) continue;
          renameSync(file, path.join(kept, name));
          moved.push(name);
        }
        copyFileSync(source, path.join(this.deps.dataDir, 'workforce.db'));
      } catch (error) {
        // Put back what was moved; the live data stays as it was.
        for (const name of moved) { try { renameSync(path.join(kept, name), path.join(this.deps.dataDir, name)); } catch { /* reported below */ } }
        const code = (error as NodeJS.ErrnoException).code;
        throw new WorkforceError('conflict', code === 'EBUSY' || code === 'EPERM' ? 'The data is in use. Close other Autark windows and try again.' : 'The copy could not be put back. Nothing was changed.', { cause: error });
      }
      this.deps.journal.clearRepair();
      const pruned = pruneReplaced(this.deps.dataDir, kept);
      this.deps.log?.info('repair: copy restored', { id, kept: path.basename(kept), pruned });
      await this.restart();
      return { ok: true as const, kept };
    });
  }

  /** Writes the redacted diagnostics file and shows it in the file manager (best effort). */
  async diagnostics(): Promise<DiagnosticsExport> {
    const result = writeDiagnostics({ dataDir: this.deps.dataDir, version: this.deps.version, state: this.state(), now: this.now() });
    try { await this.deps.host.openPath(result.path, true); } catch (error) { this.deps.log?.warn('diagnostics not shown', { error: String(error) }); }
    return result;
  }

  private assertActive(): void {
    if (!this.active) throw new WorkforceError('conflict', ONLY_REPAIR);
  }

  private async restart(): Promise<void> {
    if (typeof this.deps.host.restart !== 'function') throw new WorkforceError('unavailable', 'Restart Autark to continue.');
    await this.deps.host.restart();
  }

  /** One action at a time (a double click must not restore twice). */
  private once<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new WorkforceError('conflict', 'Already working on it.'));
    const run = action();
    this.busy = run;
    return run.finally(() => { this.busy = undefined; });
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
}
