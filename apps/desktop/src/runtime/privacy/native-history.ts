// Provider-side histories of native sessions: the person's "Delete histories" on a Claude Code account
// (Settings › Models, AccountRow menu). The CLI has no per-session delete; `claude purge --all --yes` removes all
// transcripts of a config home – only for this app's isolated homes (<data>/accounts/…, never ~/.claude or a
// detected login), only while no turn of that account runs; the account's Claude sessions are renewed right
// before it and the engine holds the account during the purge (ClaudeEngine.purgeHistories).
// Owns: the purge preconditions. Never: reads or edits provider files, or runs a CLI the person did not start.

import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Engine } from '../engines/types.ts';
import type { Account, EngineId } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';

export interface NativeHistoryDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  accounts: () => Account[];
  engine: (id: EngineId) => Engine | undefined;
  /** <data>/accounts – this app's isolated CLI homes. */
  accountsRoot: string;
}

export interface ProviderHistoryState {
  /** Always zero: Codex threads are no longer deleted after a Forget (the shape stays for the method). */
  codex: { deleted: number; waiting: number; failed: number };
  /** Claude Code accounts whose history the person can delete (this app's isolated homes on this PC). */
  claude: Array<{ accountId: string; label: string; sessions: number; running: boolean }>;
}

export interface PurgeResult { accountId: string; label: string; purged: boolean; renewed: number; message?: string }

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export class NativeHistory {
  private readonly d: NativeHistoryDeps;

  constructor(deps: NativeHistoryDeps) {
    this.d = deps;
  }

  /** The Claude Code accounts the person may clear. */
  state(): ProviderHistoryState {
    const claude = this.purgeable().map((account) => ({
      accountId: account.id, label: account.label,
      sessions: Number(this.d.db.get<{ n: number }>(`SELECT count(*) AS n FROM engine_sessions WHERE engine = 'claude' AND account_id = ?`, [account.id])?.n ?? 0),
      running: this.running(account.id),
    }));
    return { codex: { deleted: 0, waiting: 0, failed: 0 }, claude };
  }

  /** Deletes every Claude Code history of one isolated account home of this app (the person's explicit action). */
  async purgeClaude(accountId: string): Promise<PurgeResult> {
    const account = this.purgeable().find((candidate) => candidate.id === accountId);
    if (!account) throw new WorkforceError('bad_request', "Only Claude Code accounts this app signed in itself (its own account folder on this PC) can be cleared here.");
    const engine = this.d.engine('claude');
    if (!engine?.purgeHistories) throw new WorkforceError('unavailable', 'Claude Code cannot delete histories here.');
    // One synchronous step up to the engine's hold: no turn of the account runs (checked), its Claude
    // sessions are renewed (the history they would resume goes – also when the purge then fails), and
    // purgeHistories holds the account before it yields, so a turn starting meanwhile waits for the
    // purge and starts fresh instead of resuming or writing a transcript being deleted.
    if (this.running(account.id)) throw new WorkforceError('conflict', 'A turn of this account is running. Try again when it has finished.');
    const renewed = Number(this.d.db.get<{ n: number }>(`SELECT count(*) AS n FROM engine_sessions WHERE engine = 'claude' AND account_id = ?`, [account.id])?.n ?? 0);
    this.d.db.run(`DELETE FROM engine_sessions WHERE engine = 'claude' AND account_id = ?`, [account.id]);
    const outcome = await engine.purgeHistories(account);
    this.d.log?.info('claude histories purged', { accountId: account.id, purged: outcome.purged, renewed });
    return { accountId: account.id, label: account.label, purged: outcome.purged, renewed, ...(outcome.message ? { message: outcome.message } : {}) };
  }

  private purgeable(): Account[] {
    let accounts: Account[] = [];
    try { accounts = this.d.accounts(); } catch { return []; }
    return accounts.filter((account) => account.provider === 'claude' && !account.detected && !account.deviceId && account.home !== undefined && inside(account.home, this.d.accountsRoot));
  }

  private running(accountId: string): boolean {
    return this.d.db.get(`SELECT 1 AS ok FROM runs WHERE account_id = ? AND status = 'running' LIMIT 1`, [accountId]) !== undefined;
  }
}
