// Account service test harness (PR5): an in-memory Db, a ManualClock, a scripted supervisor whose
// CLIs answer the official status commands (Codex/Claude Code sign-ins stay open until a test ends
// them), a fake vault and engines whose account check reads the key through the service like the
// HTTP engines do. No real CLI, account, key or network. B-051: installers are scripted too (`install`;
// without it they exit 0 and install nothing), and add()/login() do not wait for a sign-in page by default.
// Owns: nothing in production. Never imported by src/.

import * as path from 'node:path';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { AccountCheck, Engine } from '../../../src/runtime/engines/types.ts';
import type { Account, EngineId } from '../../../src/shared/model/providers.ts';
import type { ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import { fakeFinder, fakeSpawn, testSupervisor, tick, type SpawnCall } from '../engines/fakes.ts';

export const ACCOUNTS = path.resolve('data', 'accounts');
/** A made-up key value; tests assert it never leaves the process boundary. */
export const ENV_KEY = 'sk-env-test-0123456789abcdef';

/** Browser sign-ins stay open until a test exits them; sign-outs finish at once. */
const SIGN_INS = new Set(['login', 'auth login --claudeai']);

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  /** Executables the finder knows (null = not installed). */
  clis?: Record<string, string | null>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Another service on the same database (a restart). */
  db?: Db;
  /** B-044: what an engine lists, with the key the service hands it in-process (accounts.test). */
  listModels?: (account: Account, key: string | undefined) => Promise<Array<{ model: string }>>;
  /** B-044: the fake Codex engine's reset redemption (accounts.useReset). */
  consumeReset?: (account: Account, key: string, creditId?: string) => Promise<unknown>;
  /** B-051: another finder than the `clis` map (e.g. one that sees a CLI only on forced lookups). */
  finder?: ExecutableFinder;
  /** B-051 L4: how long add()/login() wait for a printed sign-in page (default 0: no wait). */
  signInUrlMs?: number;
  /** B-051: what an install command does (default: exits 0 and installs nothing). */
  install?: (call: SpawnCall) => void;
}

export function harness(options: HarnessOptions = {}) {
  const db = options.db ?? new Db(':memory:');
  migrate(db);
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock();
  /** What the default-home status commands report. */
  const login = { codex: true, claude: false };
  /** Sign-in processes, in start order. */
  const signIns: SpawnCall[] = [];
  const { spawn, calls } = fakeSpawn((call) => {
    const args = call.args.join(' ');
    if (SIGN_INS.has(args)) { signIns.push(call); return; }
    if (options.install && /install\.(?:ps1|sh)|install -g/.test(args)) { options.install(call); return; } // an installer (B-051)
    const codexOut = login.codex ? 'Logged in using ChatGPT\n' : 'Not logged in\n';
    const out = args === '--version' ? 'tool 1.2.3\n' : args === 'login status' ? codexOut : args === 'auth status --json' ? JSON.stringify({ loggedIn: login.claude, authMethod: 'claude.ai' }) : '';
    setImmediate(() => { call.child.stdout.write(out); setImmediate(() => call.child.exit(args === 'login status' && !login.codex ? 1 : 0)); });
  });
  const supervisor = testSupervisor(spawn);
  const clis: Record<string, string | null> = { codex: '/bin/codex', claude: '/bin/claude', ...options.clis };
  const env: NodeJS.ProcessEnv = options.env ?? {};
  const vault = new Map<string, string>();
  const secrets = {
    save: async (input: { value: string }) => { const id = `sec_${vault.size + 1}`; vault.set(id, input.value); return { id }; },
    read: async (id: string) => vault.get(id),
    remove: (id: string) => { vault.delete(id); },
  };
  const checks: string[] = [];
  /** Plan answers per account id (default: signed in). */
  const answers = new Map<string, AccountCheck>();
  let service: AccountServiceImpl | undefined;
  const engine = (id: EngineId): Engine => ({
    id, caps: { sessions: false, dynamicTools: false, mcp: false, images: false, rebase: false, structured: false, ownTools: false },
    listModels: async (account) => (options.listModels ? (await options.listModels(account, await service!.apiKey(account.id))).map((m) => ({ ...m, name: m.model, efforts: [] })) : []),
    ...(id === 'codex' && options.consumeReset ? { consumeReset: options.consumeReset } : {}),
    checkAccount: async (account): Promise<AccountCheck> => {
      checks.push(account.id);
      if (answers.has(account.id)) return answers.get(account.id)!;
      if (id === 'codex' || id === 'claude') return { state: 'ok', plan: 'pro' };
      const key = await service!.apiKey(account.id); // like engines/http/base.ts: the key is read in-process
      return key ? { state: 'ok', plan: 'api' } : { state: 'needs_login', message: 'Add an API key for this connection.' };
    },
    run: async () => { throw new Error('not used in these tests'); },
    dispose: async () => {},
  });
  const made: string[] = [];
  const removed: string[] = [];
  const offline = async (): Promise<Response> => { throw new Error('offline'); };
  service = new AccountServiceImpl({
    db, bus, clock, paths: { accounts: ACCOUNTS }, env, finder: options.finder ?? fakeFinder(clis), supervisor, secrets, signInUrlMs: options.signInUrlMs ?? 0,
    engines: () => ({ get: engine, all: () => [], disposeIdle: async () => {} }),
    mkdir: async (dir) => { made.push(dir); }, rmdir: async (dir) => { removed.push(dir); },
    detectDeps: { fetch: options.fetch ?? offline, probeTimeoutMs: 1 },
  });
  const upserts: Account[] = [];
  bus.on('account.upserted', (account) => upserts.push(account));
  const settle = async () => { for (let i = 0; i < 10; i++) await tick(); await service!.monitor.idle(); };
  return { db, bus, clock, login, signIns, calls, clis, env, vault, checks, answers, made, removed, upserts, settle, service, repo: new AccountRepo(db) };
}

/** A stored account row (as a restore or another path could write it). */
export function row(id: string, patch: Partial<Account> = {}): Account {
  return { id, provider: 'openai', label: id, auth: 'api_key', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...patch };
}
