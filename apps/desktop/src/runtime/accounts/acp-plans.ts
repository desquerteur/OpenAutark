// Plan CLIs on the ACP engine (PR8: Gemini CLI, Copilot CLI) as accounts. Each keeps one sign-in
// per PC in its default home (engines/acp/providers.ts), so a provider has one account here: added
// by hand or adopted by detection (adoption.ts). Adding checks it and starts the sign-in only when
// the check asks for one (Copilot CLI's window also when the check failed otherwise: it may answer a
// missing sign-in with another error). Gemini CLI signs in through ACP authenticate (its Google method opens the
// browser) and is checked again when that ends; Copilot CLI runs its own /login in a visible
// terminal window (sign-in.ts). Neither has a sign-out Workforce could start. B-044: Kimi Code has a
// home variable (KIMI_CODE_HOME), so the service adds its accounts like Codex (cli-homes.ts, each its
// own home); its `kimi login` window and the missing sign-out run through login()/logout() here.
// Owns: the one-account-per-PC rule and the running ACP sign-ins (one per account).
// Never: reads the CLIs' homes or tokens, or starts anything after dispose().

import type { Account, ProviderId } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { acpProvider, startAuthentication } from '../engines/acp/providers.ts';
import type { AccountRepo } from './repo.ts';
import type { SignIns } from './sign-in.ts';
import { loginKey, type DismissedLogins } from './dismissed.ts';

export interface AcpPlanDeps {
  repo: AccountRepo;
  dismissed: DismissedLogins;
  /** Stores and announces an account (AccountService). */
  save(account: Account): Account;
  /** A new account row with the service's defaults (label, priority, id). */
  blank(provider: ProviderId, patch: Partial<Account>): Account;
  /** The account check whose failure shows (the monitor's queue); resolves when it is done. */
  check(id: string): Promise<void>;
  signIns: SignIns;
  /** The ACP engine (its authMethods / authenticate hooks). */
  engine(): unknown;
}

export class AcpPlans {
  private readonly deps: AcpPlanDeps;
  /** Account id → its running ACP authenticate (ends with the check that follows it). */
  private readonly signingIn = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(deps: AcpPlanDeps) { this.deps = deps; }

  static handles(provider: ProviderId): boolean {
    return acpProvider(provider) !== undefined;
  }

  /**
   * The provider's one account on this PC (its default home), checked; its sign-in starts when it
   * needs one. A terminal sign-in (Copilot CLI) also starts when the check failed otherwise: the CLI
   * may answer a missing sign-in with another error, and its own window shows what is wrong.
   */
  async add(provider: ProviderId, label: string): Promise<Account> {
    this.deps.dismissed.delete(loginKey(provider)); // added by hand: detection may adopt it again
    const account = this.deps.repo.list().find((a) => a.provider === provider && a.home === undefined)
      ?? this.deps.save(this.deps.blank(provider, { auth: 'cli', label, state: 'unknown' }));
    await this.deps.check(account.id);
    const checked = this.deps.repo.get(account.id) ?? account;
    const ownWindow = acpProvider(provider)?.signIn === 'terminal';
    if (checked.state === 'needs_login' || (checked.state === 'error' && ownWindow)) await this.login(checked);
    return this.deps.repo.get(account.id) ?? checked;
  }

  /** Gemini CLI: ACP authenticate, checked when it ends; Copilot CLI: its own sign-in in a terminal window. */
  async login(account: Account): Promise<{ started: boolean }> {
    const spec = acpProvider(account.provider);
    if (!spec) return { started: false };
    if (spec.signIn === 'terminal') return this.deps.signIns.login(account);
    if (this.signingIn.has(account.id)) return { started: true };
    const started = startAuthentication(this.deps.engine(), account, spec);
    const ended = started
      .then(({ done }) => done)
      .then(async () => { if (!this.disposed) await this.deps.check(account.id); })
      .catch(() => undefined)
      .finally(() => { if (this.signingIn.get(account.id) === ended) this.signingIn.delete(account.id); });
    this.signingIn.set(account.id, ended);
    try { await started; } catch (error) {
      if (this.signingIn.get(account.id) === ended) this.signingIn.delete(account.id);
      throw error;
    }
    return { started: true };
  }

  /** Sign-out stays with the CLI itself: Workforce only stops using the account (Remove). */
  logout(account: Account): never {
    throw new WorkforceError('bad_request', `${account.label} has no sign-out Autark can start. Remove the account to stop using it.`);
  }

  /** Shutdown: a sign-in that ends later starts no check. */
  dispose(): void {
    this.disposed = true;
  }
}
