// CLI accounts with their own home (Codex, Claude Code, Kimi Code; split from service.ts): adding one
// creates <accounts>/<provider>/<id> (CODEX_HOME, CLAUDE_CONFIG_DIR, KIMI_CODE_HOME) and
// starts its sign-in; a sign-in that could not start keeps the account and the error, and the next
// add of that provider retries that account. Removing deletes a home only when it is exactly
// <accounts>/<its provider>/<its id> – never the default CLI home, the accounts folder, a provider
// folder or another account's home (a crafted restore could point there).
// B-051: a missing Codex or Claude Code CLI is installed before add() runs (service.ts), so no account is
// left behind for that cause; add() hands back the sign-in page its sign-in printed (`signInUrl`, never stored).
// 04.11.2026 (owner: sign in once, the plan works on all his PCs): which CLIs have homes of their own, each CLI's
// default home and the names of the files that hold its login there (devices/sync/logins.ts copies those), and
// which plans the person signed out of here (a login from another PC stays out until one is made here).
// Owns: creating and deleting these homes, the retry of an unstarted sign-in, those names and the sign-out marks.
// Never: signs in itself (the service's login does), reads files in a home, or deletes anything else.

import os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Account, ProviderId } from '../../shared/model/providers.ts';
import type { Db } from '../db/database.ts';
import { KvRepo } from '../store/kv.ts';
import { acpProvider } from '../engines/acp/providers.ts';
import type { AccountRepo } from './repo.ts';

const SIGNED_OUT = 'accounts.signed-out';

/**
 * The plans the person signed out of on this PC (accounts.logout): `mark` after the sign-out, `has` before a login
 * from another PC is written (it is not), `clear` once a login is here again or the account is gone.
 */
export const signedOut = {
  mark: (db: Db, id: string, at: number): void => new KvRepo(db).set(SIGNED_OUT, id, true, at),
  has: (db: Db, id: string): boolean => new KvRepo(db).get<boolean>(SIGNED_OUT, id) === true,
  clear: (db: Db, id: string): void => { new KvRepo(db).delete(SIGNED_OUT, id); },
};

/** Whether accounts of `provider` get homes of their own (CODEX_HOME, CLAUDE_CONFIG_DIR, KIMI_CODE_HOME); else one sign-in per PC in the default home. */
export function ownHomes(provider: ProviderId): boolean {
  return provider === 'codex' || provider === 'claude' || Boolean(acpProvider(provider)?.home);
}

/** A CLI's default home, where a login this PC found lives (an account without `home`); undefined: none known. */
export function defaultHome(provider: ProviderId, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  if (provider === 'codex') return env.CODEX_HOME || path.join(home, '.codex');
  if (provider === 'claude') return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return provider === 'gemini-cli' ? path.join(home, '.gemini') : undefined;
}

/**
 * The files that hold a CLI plan's login in its home, the deciding one first. Claude Code on macOS keeps its login
 * in the Keychain, Copilot CLI and Kimi Code keep theirs in no file known here: none.
 */
export function loginFiles(provider: ProviderId, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (provider === 'codex') return ['auth.json'];
  if (provider === 'claude') return platform === 'darwin' ? [] : ['.credentials.json'];
  return provider === 'gemini-cli' ? ['oauth_creds.json', 'google_accounts.json'] : [];
}

export interface CliHomeDeps {
  accounts: string; // the accounts folder (Paths.accounts)
  repo: AccountRepo;
  /** Stores and announces an account (AccountService). */
  save(account: Account): Account;
  /** A new account row with the service's defaults (label, priority, id). */
  blank(provider: ProviderId, patch: Partial<Account>): Account;
  /** The service's sign-in (it calls started() once the sign-in runs); `url`: the sign-in page it printed. */
  login(id: string): Promise<{ started: boolean; url?: string }>;
  require(id: string): Account;
  mkdir?: (dir: string) => Promise<void>;
  rmdir?: (dir: string) => Promise<void>;
}

export class CliHomes {
  private readonly deps: CliHomeDeps;
  /** Per provider: the account whose sign-in add() could not start (CLI or terminal missing). */
  private readonly unstarted = new Map<ProviderId, string>();

  constructor(deps: CliHomeDeps) { this.deps = deps; }

  /** Its own home, then its sign-in; `chosenLabel` renames an account that is retried; `signInUrl`: the page the sign-in printed. */
  async add(provider: ProviderId, chosenLabel: string | undefined, label: string, rotation: boolean): Promise<Account & { signInUrl?: string }> {
    const retry = this.unstarted.get(provider);
    const pending = retry ? this.deps.repo.get(retry) : undefined;
    let account: Account;
    if (pending?.state === 'needs_login' && pending.home) account = this.deps.save({ ...pending, label: chosenLabel ?? pending.label, rotation });
    else {
      account = this.deps.blank(provider, { auth: 'cli', label, rotation, state: 'needs_login' });
      account.home = path.join(this.deps.accounts, provider, account.id);
      await (this.deps.mkdir ?? ((dir) => fsp.mkdir(dir, { recursive: true }).then(() => undefined)))(account.home);
      this.deps.save(account);
    }
    let url: string | undefined;
    try { url = (await this.deps.login(account.id)).url; } catch (error) { this.unstarted.set(provider, account.id); throw error; }
    const added = this.deps.require(account.id);
    return url ? { ...added, signInUrl: url } : added;
  }

  /** The account's sign-in runs now: the next add makes a new home. */
  started(account: Account): void {
    if (this.unstarted.get(account.provider) === account.id) this.unstarted.delete(account.provider);
  }

  /** Deletes the account's home if add() made it (exactly <accounts>/<provider>/<id>); anything else stays. */
  async remove(account: Account): Promise<void> {
    if (!account.home) return;
    const parts = path.relative(path.resolve(this.deps.accounts), path.resolve(account.home)).split(path.sep);
    const own = parts.length === 2 && parts[0] === account.provider && parts[1] === account.id;
    if (own) await (this.deps.rmdir ?? ((dir) => fsp.rm(dir, { recursive: true, force: true })))(path.resolve(account.home)).catch(() => undefined);
  }
}
