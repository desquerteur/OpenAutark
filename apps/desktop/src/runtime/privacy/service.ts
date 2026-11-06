// PrivacyService: retention (old tool traces and corrected knowledge versions, retention.ts – a pass when the
// lifecycle.retention settings change and at most once a day on a finished run; no timer) and the person's
// "Delete histories" of a Claude Code account (native-history.ts). Deleting a note is knowledge.forget – delete
// is delete, there is no cascade, inventory or export.
// Owns: that wiring. Never: acts for an agent, or runs a retention pass while both retention settings are 0.

import type { Bus } from '../bus.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Settings } from '../../shared/model/system.ts';
import { retentionOf, type RetentionResult } from '../../shared/model/lifecycle.ts';
import { applyRetention, passDue } from './retention.ts';
import type { NativeHistory, ProviderHistoryState, PurgeResult } from './native-history.ts';

export interface PrivacyDeps {
  db: Db;
  clock: Clock;
  bus?: Bus;
  log?: Logger;
  settings: () => Pick<Settings, 'lifecycle'>;
  /** Deletes expired knowledge versions (KnowledgeStore.purgeVersions); the removed ids. */
  purgeVersions?: (ids: readonly string[]) => string[];
  history?: NativeHistory;
}

export class PrivacyService {
  private readonly d: PrivacyDeps;
  private readonly off: Array<() => void> = [];
  private lastRetention = '';

  constructor(deps: PrivacyDeps) {
    this.d = deps;
  }

  start(): void {
    const bus = this.d.bus;
    this.lastRetention = JSON.stringify(retentionOf(this.d.settings()));
    if (!bus || this.off.length) return;
    this.off.push(bus.on('run.upserted', (run) => {
      if (run.endedAt === undefined || run.status === 'running' || run.status === 'queued') return;
      this.maybePass();
    }));
    this.off.push(bus.on('settings.updated', (settings) => {
      const next = JSON.stringify(retentionOf(settings));
      if (next === this.lastRetention) return;
      this.lastRetention = next;
      this.run(); // new retention takes effect now
    }));
  }

  stop(): void {
    for (const off of this.off.splice(0)) off();
  }

  /** The Claude Code accounts whose history the person may clear. */
  providerHistories(): ProviderHistoryState {
    return this.d.history?.state() ?? { codex: { deleted: 0, waiting: 0, failed: 0 }, claude: [] };
  }

  /** The person's "Delete histories" for one isolated Claude Code account (native-history.ts). */
  purgeProviderHistory(accountId: string): Promise<PurgeResult> {
    if (!this.d.history) throw new WorkforceError('unavailable', 'Provider histories cannot be deleted here.');
    return this.d.history.purgeClaude(accountId);
  }

  applyRetention(): RetentionResult {
    return applyRetention({ db: this.d.db, log: this.d.log, purgeVersions: this.d.purgeVersions }, retentionOf(this.d.settings()), this.d.clock.now());
  }

  /** A daily pass on activity (a finished run), when retention is on and the last pass is a day old. */
  private maybePass(): void {
    try {
      if (passDue(this.d.db, retentionOf(this.d.settings()), this.d.clock.now())) this.run();
    } catch (error) {
      this.d.log?.warn('retention check failed', { error: String(error) });
    }
  }

  private run(): void {
    try { this.applyRetention(); } catch (error) { this.d.log?.warn('retention pass failed', { error: String(error) }); }
  }
}
