// Detection → accounts (split from service.ts): the cached DetectionReport (one scan at a time;
// dismissed entries marked; one that could not tell an installed CLI's login is scanned again on the
// next detect, audit 23.10.), adoption of what a scan found – logins in the default CLI homes and
// running local servers become 'detected' accounts unless the person removed them (PR5,
// dismissed.ts) – the checks a scan triggers, and "Add again" for a dismissed login.
// Owns: the report cache and the adoption rules. Never: scans itself (detect.ts), signs in or deletes.

import type { Account, DetectionReport, ProviderId } from '../../shared/model/providers.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { AccountRepo } from './repo.ts';
import { loginKey, serverKey, type DismissedLogins } from './dismissed.ts';
import { envKey } from './env-keys.ts';
import { loginUnknown } from './detect.ts';

/** Providers whose logins live in a CLI home (default or <accounts>/<provider>/<id>; Gemini CLI and Copilot CLI only the default, PR8). */
export const CLI_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude', 'gemini-cli', 'copilot', 'kimi-cli']);

export interface AdoptionDeps {
  repo: AccountRepo;
  dismissed: DismissedLogins;
  /** Stores and announces an account (AccountService). */
  save(account: Account): Account;
  /** A new account row with the service's defaults (label, priority, id). */
  blank(provider: ProviderId, patch: Partial<Account>): Account;
  /** One check in the account monitor's serial queue. */
  checkOnce(id: string): void;
  scan(): Promise<DetectionReport>;
  env(): NodeJS.ProcessEnv;
  now(): number;
  /** Demo/test mode: an empty report – real logins are never detected. */
  demo?: boolean;
}

export class Adoption {
  private readonly deps: AdoptionDeps;
  private report: DetectionReport | undefined;
  private detecting: Promise<DetectionReport> | undefined;

  constructor(deps: AdoptionDeps) { this.deps = deps; }

  /** The last scan's report (no scan), dismissed logins and servers marked like detect(); undefined before the first. */
  cached(): DetectionReport | undefined { return this.report && this.deps.dismissed.mark(this.report); }

  /**
   * The cached report (a new scan when forced, none yet, or the last one could not tell an installed
   * CLI's login – detect.ts loginUnknown, e.g. a status command that timed out), dismissed logins and servers marked.
   */
  async detect(force: boolean): Promise<DetectionReport> {
    if (this.report && !force && !loginUnknown(this.report)) return this.deps.dismissed.mark(this.report);
    if (this.deps.demo) return (this.report = { clis: [], localServers: [], envKeys: [], checkedAt: this.deps.now() });
    if (!this.detecting) {
      this.detecting = this.deps.scan()
        .then((report) => { this.report = report; this.adopt(report); return report; })
        .finally(() => { this.detecting = undefined; });
    }
    return this.deps.dismissed.mark(await this.detecting);
  }

  /**
   * Creates 'detected' accounts for logins in the default CLI homes and running local servers (idempotent),
   * except dismissed ones. One check each (the monitor's queue): a new plan login, a detected login whose
   * sign-in changed outside Workforce (signed out → needs_login), an 'error' account whose CLI is
   * installed again and an environment key that is set again; a key that is gone is 'needs_login'.
   */
  adopt(report: DetectionReport): void {
    const { repo, dismissed } = this.deps;
    const existing = repo.list();
    const gone = new Set(dismissed.list());
    for (const cli of report.clis) {
      if (!CLI_PROVIDERS.has(cli.provider as ProviderId)) continue;
      const provider = cli.provider as ProviderId;
      const own = existing.find((a) => a.provider === provider && a.home === undefined);
      const signInChanged = own?.enabled && cli.loggedIn !== undefined && cli.loggedIn === (own.state === 'needs_login');
      if (own) { if (signInChanged) this.deps.checkOnce(own.id); continue; }
      if (!cli.loggedIn || gone.has(loginKey(provider))) continue;
      const adopted = this.deps.save(this.deps.blank(provider, { auth: 'cli', state: 'ok', detected: true }));
      if (isPlanProvider(provider)) this.deps.checkOnce(adopted.id);
    }
    for (const server of report.localServers) {
      if (gone.has(serverKey(server.provider, server.baseUrl)) || existing.some((a) => a.provider === server.provider && a.baseUrl === server.baseUrl)) continue;
      this.deps.save(this.deps.blank(server.provider, { auth: 'local', baseUrl: server.baseUrl, state: 'ok', detected: true }));
    }
    const installed = new Set<string>(report.clis.filter((cli) => cli.path).map((cli) => cli.provider)); // a CLI missing at a failed turn may be back
    for (const account of existing.filter((a) => a.state === 'error' && a.enabled && installed.has(a.provider))) this.deps.checkOnce(account.id);
    for (const account of existing.filter((a) => a.auth === 'env' && a.enabled)) { // the variable may be gone or back since the last start
      const set = envKey(account, this.deps.env()) !== undefined;
      if (!set && account.state !== 'needs_login') this.deps.save({ ...account, state: 'needs_login' });
      else if (set && account.state === 'needs_login') this.deps.checkOnce(account.id);
    }
  }

  /** "Add again": the dismissed default-home login becomes an account again if this PC still has it. */
  async addAgain(provider: ProviderId, label: string): Promise<Account> {
    if (!CLI_PROVIDERS.has(provider)) throw new WorkforceError('bad_request', 'Only a sign-in found on this PC can be added again.');
    this.deps.dismissed.delete(loginKey(provider));
    const signedIn = (report: DetectionReport | undefined) => report?.clis.some((cli) => cli.provider === provider && cli.loggedIn) === true;
    const report = signedIn(this.report) ? this.report! : await this.detect(true);
    this.adopt(report); // idempotent; also covers a scan that was already running when the dismissal ended
    const account = this.deps.repo.list().find((a) => a.provider === provider && a.auth === 'cli' && a.home === undefined);
    if (!account) throw new WorkforceError('not_found', `No ${label} sign-in was found on this PC.`);
    return account;
  }
}
