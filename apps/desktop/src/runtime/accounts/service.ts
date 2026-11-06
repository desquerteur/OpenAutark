// AccountService: unlimited accounts per provider, each with an isolated CLI home (<accounts>/<provider>/<id>
// for Codex, Claude Code and Kimi Code – cli-homes.ts), an encrypted API key reference or a key from this PC's
// environment (connect.ts, env-keys.ts – read in-process when needed, never stored); detection and
// adoption (adoption.ts; removed detected logins stay dismissed until "Add again", dismissed.ts),
// official-CLI login/logout (sign-in.ts – Copilot CLI and Kimi Code in a terminal window), limits, candidates per
// engine and model, usage, turn-reported states, and a restored account's home (rehome; reanchor.ts).
// PR8: Gemini CLI and Copilot CLI are ACP plans, one per PC in the CLI's default home (acp-plans.ts);
// Kimi Code (B-044) is an ACP plan with its own homes like Codex (cli-homes.ts, KIMI_CODE_HOME);
// acpLaunch is the ACP engine's resolver, sharing the launches (`--help` read once) with detection.
// B-044: Codex banked resets (resets.ts, accounts.useReset) and the API key form's Test before
// saving (endpoint-test.ts, accounts.test – the typed key only in memory for that call).
// Every CLI the service starts (scan, sign-ins) runs in the empty engine folder, never the process cwd;
// Copilot CLI's sign-in window, an agent itself, in a new folder below temp each time (sign-in.ts).
// Plan readings stay current through its AccountMonitor (monitor.ts), whose serial queue runs every check.
// 01.11.2026: older 'decision' and model data accounts are moved to normal connections at the start (legacy.ts).
// B-051: adding a Codex/Claude Code plan installs its missing CLI first (install.ts; a failed install creates
// nothing); add()/login({ page }) hand back the sign-in page the CLI printed (sign-in.ts, never stored); a plan
// that cannot run agents (Claude Free, cli.ts planBlocked) is 'error' even from a background check.
// B-066: API connections live in settings.json's `providers` section (provider-file.ts): an entry is an account with its
// id, the table keeps its state and limits; add, rename and remove go through the file. Plans stay detected.
// Its input and dependency shapes and the provider labels: service-shape.ts.
// 04.11.2026: a plan's login files travel between the CEO's own PCs in devices/sync/logins.ts (not here); a sign-out
// here marks the plan (cli-homes.ts signedOut), so no login from a linked PC signs it in again.
// Owns: the accounts table (via AccountRepo) and account.upserted / account.removed / usage.updated.
// Never: reads/copies provider tokens, stores key values (SecretService does), or rotates mid-turn.

import os from 'node:os';
import type { AccountService as AccountServiceContract } from '../contracts.ts';
import { DECISION_PROVIDER, MEDIA_ONLY_PROVIDERS, type Account, type AccountLimits, type DetectionReport, type EngineId, type ProviderId, type UsageSummary } from '../../shared/model/providers.ts';
import { AccountRepo } from './repo.ts';
import { migrateOldAccounts } from './legacy.ts';
import { detect as scan } from './detect.ts';
import { engineFor, selectCandidates } from './candidates.ts';
import { mergeLimits } from './limits.ts';
import { AccountMonitor } from './monitor.ts';
import { installCli } from './install.ts';
import { SignIns } from './sign-in.ts';
import { planBlocked } from './cli.ts';
import { envKey } from './env-keys.ts';
import { connection, handleId, vaultId } from './connect.ts';
import { DismissedLogins, dismissalKey, serverKey } from './dismissed.ts';
import { ProviderFile } from './provider-file.ts';
import { Adoption, CLI_PROVIDERS } from './adoption.ts';
import { AcpPlans } from './acp-plans.ts';
import { CliHomes, signedOut } from './cli-homes.ts';
import { AcpLaunches, acpProvider } from '../engines/acp/providers.ts';
import { Resets } from './resets.ts';
import { testEndpoint, type EndpointTestInput } from './endpoint-test.ts';
import { mediaKeyState } from '../media/providers/key-check.ts'; // B-058 i1
import { PROVIDER_LABELS, type AccountServiceDeps, type AddAccountInput } from './service-shape.ts';
import type { ResetOutcome } from '../../shared/api/methods-providers.ts';
import type { AcpLaunch } from '../engines/acp/process.ts';
import { engineCwd } from '../system/paths.ts';
import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';

export type { SecretPort } from './connect.ts';
export type { AccountServiceDeps, AddAccountInput } from './service-shape.ts';

export class AccountServiceImpl implements AccountServiceContract {
  private readonly deps: AccountServiceDeps;
  private readonly repo: AccountRepo;
  private readonly dismissed: DismissedLogins;
  private readonly adoption: Adoption;
  private readonly signIns: SignIns;
  private readonly acp: AcpPlans;
  private readonly homes: CliHomes;
  private readonly launches: AcpLaunches;
  private readonly resets: Resets;
  /** settings.json's connections (absent without a settings service: tests). */
  private readonly file?: ProviderFile;
  /** Set when the constructor is through: its own sync checks nothing (the engines come later; the monitor reads every account). */
  private checking = false;
  /** Throwaway account id → the typed key while an endpoint test runs (endpoint-test.ts). */
  private readonly testKeys = new Map<string, string>();
  private disposed = false; // set by dispose(): a check that ends during shutdown stores nothing
  /** Keeps plan readings current (started by the runtime; explicit calls work without it). */
  readonly monitor: AccountMonitor;

  constructor(deps: AccountServiceDeps) {
    this.deps = deps;
    this.repo = new AccountRepo(deps.db);
    migrateOldAccounts(deps.db, deps.log); // once: older decision accounts become normal connections (legacy.ts)
    this.dismissed = new DismissedLogins(deps.db, () => this.now());
    this.monitor = new AccountMonitor({ accounts: this, bus: deps.bus, clock: deps.clock, log: deps.log });
    const { data, temp } = deps.paths;
    const cwd = data ? engineCwd({ data }) : temp ?? os.tmpdir(); // never the process cwd, where project config could apply
    this.signIns = new SignIns({
      finder: deps.finder, supervisor: deps.supervisor, env: deps.env, now: () => this.now(), terminal: deps.terminal, cwd,
      agentRoot: temp ?? os.tmpdir(), mkdir: deps.mkdir, urlWaitMs: deps.signInUrlMs, // Copilot CLI's window: a new folder each time, never the engine folder
      label: (provider) => PROVIDER_LABELS[provider] ?? provider, check: (id) => this.monitor.checkNow(id), state: (id) => this.repo.get(id)?.state,
    });
    this.launches = new AcpLaunches({ finder: deps.finder, supervisor: deps.supervisor, cwd, env: deps.env, promptDir: deps.enginePrompts }); // B-049 F3
    const store = {
      repo: this.repo, dismissed: this.dismissed, save: (account: Account) => this.save(account), blank: (provider: ProviderId, patch: Partial<Account>) => this.blank(provider, patch),
    };
    this.adoption = new Adoption({
      ...store, checkOnce: (id) => this.monitor.checkOnce(id), env: () => this.env(), now: () => this.now(), demo: deps.demo,
      scan: () => scan({ finder: deps.finder, supervisor: deps.supervisor, env: deps.env, now: () => this.now(), cwd, launches: this.launches, version: deps.version, ...deps.detectDeps }),
    });
    this.acp = new AcpPlans({ ...store, check: (id) => this.monitor.checkNow(id), signIns: this.signIns, engine: () => this.deps.engines().get('acp') });
    this.homes = new CliHomes({ ...store, accounts: deps.paths.accounts, login: (id) => this.login(id, { page: true }), require: (id) => this.require(id), mkdir: deps.mkdir, rmdir: deps.rmdir });
    this.resets = new Resets({ get: (id) => this.repo.get(id), engine: () => this.deps.engines().get('codex'), check: (id) => this.monitor.checkNow(id) });
    if (deps.settings) {
      this.file = new ProviderFile({
        ...store, db: deps.db, settings: deps.settings, now: () => this.now(), log: deps.log, forget: (account) => this.forget(account),
        check: (id) => { if (this.checking) void this.monitor.checkNow(id); },
      });
      // once: API connections from before the file; a file that cannot be written now must not stop the start, they move at the next
      try { this.file.moveOld(); } catch (error) { deps.log?.warn('API connections not moved into settings.json', { error: String(error) }); }
      this.file.sync();
      deps.bus.on('settings.updated', () => this.file!.sync());
      this.checking = true;
    }
  }

  /** The ACP engine's resolver (createEngineRegistry `acp`): the agent an ACP plan account starts; undefined when its CLI is missing. */
  readonly acpLaunch = (account: Account): Promise<AcpLaunch | undefined> => this.launches.resolve(account);

  private now(): number { return this.deps.clock.now(); }
  private env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }

  list(): Account[] { return this.repo.list(); }
  get(id: string): Account | undefined { return this.repo.get(id); }

  private require(id: string): Account {
    const account = this.repo.get(id);
    if (!account) throw new WorkforceError('not_found', 'This account does not exist.');
    return account;
  }

  private save(account: Account): Account {
    this.repo.save(account);
    this.deps.bus.emit('account.upserted', account);
    return account;
  }

  /** Also checks terminal sign-ins whose window may still be open (Settings asks when the person comes back). */
  async detect(force = false): Promise<DetectionReport> {
    await this.signIns.recheck();
    return this.adoption.detect(force);
  }

  /** The last detection's report without a new scan (RT7: readers that follow every rescan), dismissed entries marked; undefined before the first. */
  lastDetection(): DetectionReport | undefined { return this.adoption.cached(); }

  private blank(provider: ProviderId, patch: Partial<Account>): Account {
    const accounts = this.repo.list();
    const samePriority = accounts.filter((a) => a.provider === provider).length;
    return {
      id: newId('acc', this.now()), provider, label: PROVIDER_LABELS[provider] ?? provider, auth: 'none', state: 'unknown',
      priority: samePriority, rotation: false, enabled: true, detected: false, createdAt: this.now(), ...patch,
    };
  }

  /** `signInUrl` (Codex, Claude Code): the sign-in page the CLI printed within a few seconds – handed back, never stored. */
  async add(input: AddAccountInput): Promise<Account & { signInUrl?: string }> {
    const provider = input.provider;
    if (!PROVIDER_LABELS[provider]) throw new WorkforceError('bad_request', 'Choose a supported provider.');
    if (input.detected) return this.adoption.addAgain(provider, PROVIDER_LABELS[provider]!);
    const same = this.repo.list().filter((a) => a.provider === provider);
    const label = input.label?.trim().slice(0, 80) || (same.length ? `${PROVIDER_LABELS[provider]} ${same.length + 1}` : PROVIDER_LABELS[provider]!);
    // Kimi Code has a home variable: each added account gets its own home like Codex (cli-homes.ts).
    if (AcpPlans.handles(provider) && !acpProvider(provider)?.home && input.envVar === undefined) return this.acp.add(provider, label);
    if (CLI_PROVIDERS.has(provider) && input.envVar === undefined) {
      if (provider === 'codex' || provider === 'claude') await this.ensureCli(provider); // B-051 L3: install first, else nothing is created
      return this.homes.add(provider, input.label?.trim() ? label : undefined, label, input.rotation ?? false);
    }
    const connected = await connection({ ...input, label }, { env: this.env(), secrets: this.deps.secrets });
    const found = connected.auth === 'env' ? same.find((a) => a.auth === 'env' && a.envVar === connected.envVar) : undefined;
    if (found) return found; // one account per environment variable
    if (connected.auth === 'local' && connected.baseUrl) this.dismissed.delete(serverKey(provider, connected.baseUrl)); // added by hand again
    if (this.file && connected.auth !== 'env' && !input.demoEngine) return this.file.add({ provider, label, rotation: input.rotation }, connected);
    const account = this.save(this.blank(provider, { ...connected, label, rotation: input.rotation ?? false, ...(input.demoEngine ? { detected: true } : {}) }));
    void this.monitor.checkNow(account.id); // in the monitor's serial queue
    return account;
  }

  update(id: string, patch: Partial<Pick<Account, 'label' | 'priority' | 'rotation' | 'enabled'>>): Account {
    const account = this.require(id);
    const next: Account = { ...account };
    if (typeof patch.label === 'string' && patch.label.trim()) {
      next.label = patch.label.trim().slice(0, 80);
      if (this.file?.has(id)) this.file.rename(id, next.label);
    }
    if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) next.priority = Math.round(patch.priority);
    if (typeof patch.rotation === 'boolean') next.rotation = patch.rotation;
    if (typeof patch.enabled === 'boolean') { next.enabled = patch.enabled; if (!patch.enabled) next.state = 'disabled'; else if (next.state === 'disabled') next.state = 'unknown'; }
    const saved = this.save(next);
    // switched back on: checked again at once ('unknown' until the check answers – Settings says "Checking…")
    if (account.state === 'disabled' && saved.enabled) void this.monitor.checkNow(id);
    return saved;
  }

  /**
   * Starts the official sign-in under the account's home (Codex/Claude/Gemini CLI open the browser, Copilot CLI/Kimi Code a terminal).
   * `page` (B-051 L4, only for the person's own UI – accounts.login/add): also the sign-in page the CLI printed. Agent tools
   * never ask for it: their output is stored with the run, and the page must stay in memory.
   */
  async login(id: string, options: { page?: boolean } = {}): Promise<{ started: boolean; url?: string }> {
    const account = this.require(id);
    const result = AcpPlans.handles(account.provider) ? await this.acp.login(account) : await this.signIns.login(account, options.page === true);
    this.homes.started(account);
    return result;
  }

  /** Signs out through the CLI (Codex, Claude Code); ACP plans have none Workforce could start. It stays signed out here: no login from a linked PC comes back. */
  async logout(id: string): Promise<void> {
    const account = this.require(id);
    if (AcpPlans.handles(account.provider)) this.acp.logout(account);
    if (await this.signIns.logout(account) === 'window') return;
    signedOut.mark(this.deps.db, id, this.now());
    this.save({ ...this.require(id), state: 'needs_login', limits: undefined, email: undefined, plan: undefined });
  }

  async remove(id: string): Promise<void> {
    const account = this.require(id);
    if (this.file?.has(id)) { this.file.remove(id); return; } // the file's sync takes the account out; its key stays in the catalog
    await this.signIns.cancel(id);
    // the account's own typed key goes with it; a catalog entry it only names (a handle) stays the person's
    if (account.secretId && !handleId(account.secretId)) { try { this.deps.secrets.remove(account.secretId); } catch { /* already gone */ } }
    await this.homes.remove(account); // only exactly <accounts>/<its provider>/<its id>
    this.forget(account);
  }

  private forget(account: Account): void {
    this.resets.forget(account.id);
    this.repo.remove(account.id);
    const dismissal = dismissalKey(account);
    if (dismissal) this.dismissed.add(dismissal); // detection must not add it back; "Add again" undoes this
    this.deps.bus.emit('account.removed', { id: account.id });
  }

  async install(provider: 'claude' | 'codex'): Promise<void> {
    await installCli(provider, { supervisor: this.deps.supervisor, finder: this.deps.finder, env: this.deps.env, demo: this.deps.demo });
    await this.detect(true);
  }

  /** B-051 L3: the plan's CLI before its account – throws the install error (nothing created); a fresh install rescans in the background. */
  private async ensureCli(provider: 'claude' | 'codex'): Promise<void> {
    const installed = await installCli(provider, { supervisor: this.deps.supervisor, finder: this.deps.finder, env: this.deps.env, demo: this.deps.demo });
    if (installed) void this.detect(true).catch(() => undefined);
  }

  useReset(id: string, creditId?: string): Promise<ResetOutcome> { return this.resets.use(id, creditId); }

  test(input: EndpointTestInput): Promise<{ models: string[] }> {
    return testEndpoint(input, { engine: (id) => this.deps.engines().get(id), keys: this.testKeys, secrets: this.deps.secrets, now: () => this.now(), demo: this.deps.demo });
  }

  candidates(engine: EngineId, model?: string): Account[] {
    return selectCandidates(this.repo.list(), engine, this.now(), model);
  }

  markLimited(id: string, until: number, limits?: AccountLimits): void {
    const account = this.repo.get(id);
    if (!account) return;
    this.save({ ...account, state: 'cooling', coolingUntil: until, limits: limits ? mergeLimits(account.limits, limits) : account.limits });
    this.monitor.publish();
  }

  /** A turn found the account signed out ('needs_login') or its CLI missing ('error'); true when that changed its state. */
  markUnavailable(id: string, state: 'needs_login' | 'error'): boolean {
    const account = this.repo.get(id);
    if (!account || !account.enabled || account.state === state) return false;
    this.save({ ...account, state });
    this.monitor.publish();
    return true;
  }

  /** MM7 (portability/reanchor.ts): a restored account's CLI home on this PC; `signedOut` → needs_login (kept 'disabled' when off). */
  rehome(id: string, home: string, signedOut: boolean): Account {
    const account = this.require(id);
    return this.save({ ...account, home, ...(signedOut && account.enabled ? { state: 'needs_login' as const, coolingUntil: undefined } : {}) });
  }

  updateLimits(id: string, limits: AccountLimits): void {
    const account = this.repo.get(id);
    if (!account) return;
    const next: Account = { ...account, limits: mergeLimits(account.limits, limits) };
    if (account.state === 'cooling' && (account.coolingUntil ?? 0) <= this.now()) { next.state = 'ok'; next.coolingUntil = undefined; }
    this.save(next);
    this.monitor.publish();
  }

  /**
   * Runs the engine's official status check and stores state/plan/email/limits; readings the check
   * did not return stay. `background` (the monitor): a check that failed ('error') changes nothing;
   * `details`: Codex reads its banked resets' credit details too (else the count, monitor.ts).
   * An environment key that is not set is 'needs_login'; a set one without an engine (model data) is 'ok'.
   */
  async check(id: string, background = false, details = false): Promise<Account> {
    const account = this.require(id);
    const env = account.auth === 'env' && account.enabled ? envKey(account, this.env()) !== undefined : undefined;
    if (env === false) return this.save({ ...account, state: 'needs_login', checkedAt: this.now() });
    const engine = this.deps.demo && account.provider === 'compatible' ? 'fake' : engineFor(account.provider);
    const mediaKey = account.enabled && account.auth === 'api_key' && Boolean(account.secretId) && MEDIA_ONLY_PROVIDERS.includes(account.provider); // B-058: no engine
    if (mediaKey) { // B-058 i1: one free authenticated GET of the provider (media/providers/key-check.ts); unknown keeps a rejected key rejected, else 'ok'
      const state = await mediaKeyState(account, () => this.deps.secrets.read(vaultId(account.secretId!)), this.deps.detectDeps?.fetch);
      const fresh = this.require(id);
      return this.disposed ? fresh : this.save({ ...fresh, state: fresh.enabled ? state : 'disabled', checkedAt: this.now() });
    }
    // no engine: a set environment key, or a decision connection (accounts.try asks it one question), reads as connected
    if (!engine) return env || (account.provider === DECISION_PROVIDER && account.enabled) ? this.save({ ...account, state: 'ok', checkedAt: this.now() }) : account;
    const result = await this.deps.engines().get(engine).checkAccount(account, { details });
    if (this.disposed) return account; // shutdown: a check whose process was stopped stores nothing
    const fresh = this.require(id);
    if (background && result.state === 'error' && !planBlocked(result)) return fresh; // a plan that cannot run agents is a reading (B-051 L5)
    const cooling = fresh.coolingUntil !== undefined && fresh.coolingUntil > this.now();
    const next: Account = {
      ...fresh, state: !fresh.enabled ? 'disabled' : cooling && result.state === 'ok' ? 'cooling' : result.state,
      plan: result.plan ?? fresh.plan, email: result.email ?? fresh.email,
      limits: result.limits ? mergeLimits(fresh.limits, result.limits) : fresh.limits,
      coolingUntil: cooling ? fresh.coolingUntil : undefined, checkedAt: this.now(),
    };
    return this.save(next);
  }

  /** A check in the monitor's queue whose result shows – a login that arrived from a linked PC (devices/sync/logins.ts). */
  checkNow(id: string): Promise<void> { return this.monitor.checkNow(id); }

  /** Quota summaries; explicit refresh and activity share the automatic provider cadence. */
  async usage(refresh = false): Promise<UsageSummary[]> {
    if (refresh) await this.monitor.refreshAll();
    else this.monitor.activity();
    return this.monitor.summaries();
  }

  /** In-process only (HTTP engines, model data): the vault's key, or the environment variable's value at this moment. */
  async apiKey(id: string): Promise<string | undefined> {
    const tested = this.testKeys.get(id);
    if (tested !== undefined) return tested;
    const account = this.repo.get(id);
    if (account?.auth === 'env') return envKey(account, this.env());
    if (!account?.secretId) return undefined;
    return this.deps.secrets.read(vaultId(account.secretId));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.acp.dispose();
    await this.signIns.dispose();
  }
}
