// Account and quota monitor (PR2) with a ManualClock, an in-memory Db and fake engines: one check
// per adopted login, bounded refreshes after activity and turn ends, stale flags,
// quota-open throttling with serial checks, and sign-in checks in
// the same queue, and failed checks that keep the old limits.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountServiceImpl, type AccountServiceDeps } from '../../../src/runtime/accounts/service.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { AccountMonitor, REFRESH_MS, isStale, usageSummaries } from '../../../src/runtime/accounts/monitor.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { AccountCheck, Engine } from '../../../src/runtime/engines/types.ts';
import type { Account, AccountLimits, EngineId, ProviderId, UsageSummary } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { fakeFinder, fakeSpawn, testSupervisor, tick, type FakeChild } from '../engines/fakes.ts';

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Answer = AccountCheck | Error;

const reading = (readAt: number, used = 30, resetsAt = readAt + 3 * DAY): AccountLimits => ({
  windows: [{ name: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: readAt + 4 * HOUR }, { name: 'weekly', windowMinutes: 10080, usedPercent: used, resetsAt }],
  readAt,
});

function plan(id: string, provider: ProviderId, patch: Partial<Account> = {}): Account {
  return { id, provider, label: id, auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: T0, ...patch };
}

const monitors: AccountMonitor[] = [];
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); });

function harness() {
  const db = new Db(':memory:');
  migrate(db);
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock(T0);
  const checks: string[] = [];
  const answers = new Map<string, Answer>();
  const holds = new Map<string, Promise<void>>(); // a check that waits until the test releases it
  const flight = { now: 0, max: 0 };
  const engine = (id: EngineId): Engine => ({
    id, caps: { sessions: false, dynamicTools: false, mcp: false, images: false, rebase: false, structured: false, ownTools: false },
    listModels: async () => [],
    checkAccount: async (account): Promise<AccountCheck> => {
      checks.push(account.id);
      flight.max = Math.max(flight.max, ++flight.now);
      try {
        await (holds.get(account.id) ?? tick());
        const answer = answers.get(account.id) ?? { state: 'ok', plan: 'max', email: 'person@example.test', limits: reading(clock.now(), 40) };
        if (answer instanceof Error) throw answer;
        return answer;
      } finally { flight.now--; }
    },
    run: async () => { throw new Error('not used in this test'); },
    dispose: async () => {},
  });
  const engines = { get: engine, all: () => [], disposeIdle: async () => {} };
  // Detection runs `claude --version` and `claude auth status --json`; app-servers stay up until exit().
  const login = { claude: true };
  const servers: FakeChild[] = [];
  const { spawn } = fakeSpawn((call) => {
    if (call.args.includes('app-server')) { servers.push(call.child); return; }
    const out = call.args.join(' ') === 'auth status --json' ? JSON.stringify({ loggedIn: login.claude, authMethod: 'claude.ai' }) : '2.1.0\n';
    setImmediate(() => { call.child.stdout.write(out); setImmediate(() => call.child.exit(0)); });
  });
  const supervisor = testSupervisor(spawn);
  const service = new AccountServiceImpl({
    db, bus, clock, paths: { accounts: 'accounts' }, engines: () => engines, env: {}, mkdir: async () => {}, signInUrlMs: 0, // B-051: no wait for a sign-in page
    finder: fakeFinder({ claude: 'claude' }), supervisor, secrets: {} as AccountServiceDeps['secrets'],
    detectDeps: { fetch: async () => { throw new Error('offline'); }, probeTimeoutMs: 1 },
  });
  monitors.push(service.monitor);
  const usage: UsageSummary[][] = [];
  const upserts: string[] = [];
  bus.on('usage.updated', (list) => usage.push(list));
  bus.on('account.upserted', (account) => upserts.push(account.id));
  const repo = new AccountRepo(db);
  let runs = 0;
  const run = (patch: Partial<Run> = {}) => bus.emit('run.upserted', { id: `run_${++runs}`, agentId: 'ag_1', trigger: 'message', status: 'running', ...patch });
  /** A Codex app-server for this account (the engine's lease `codex:<id>`). */
  const startServer = (accountId: string) => supervisor.spawn({ command: 'codex', args: ['app-server'], owner: `codex:${accountId}` });
  const settle = async () => { await tick(); await service.monitor.idle(); };
  const signingIn = (accountId: string) => supervisor.leases().some((lease) => lease.owner === `login:${accountId}`);
  /** Waits (bounded) until the CLI sign-in started for this account has exited. */
  const loginEnded = async (accountId: string) => {
    for (let i = 0; i < 50 && signingIn(accountId); i++) await tick();
    assert.equal(signingIn(accountId), false, 'the sign-in exited');
    await tick();
  };
  return { db, bus, clock, service, repo, checks, answers, holds, flight, login, usage, upserts, run, startServer, servers, settle, signingIn, loginEnded };
}

test('adoption: a login found on this PC gets exactly one check; a sign-out outside Workforce becomes needs_login, old limits kept', async () => {
  const h = harness();
  await h.service.detect();
  await h.settle();
  const [adopted, ...rest] = h.service.list();
  assert.equal(rest.length, 0);
  assert.equal(adopted.provider, 'claude');
  assert.equal(adopted.detected, true);
  assert.deepEqual(h.checks, [adopted.id], 'one check right after adoption (the monitor was not even started)');
  assert.equal(adopted.plan, 'max');
  assert.equal(adopted.checkedAt, T0);
  assert.equal(adopted.limits?.windows.find((window) => window.name === 'weekly')?.usedPercent, 40);
  assert.ok(h.usage.length >= 1, 'the reading reaches the quota rail');
  assert.equal(h.usage.at(-1)?.[0].weeklyRemainingPercent, 60);

  // Detecting again changes nothing while the login is unchanged.
  await h.service.detect(true);
  await h.settle();
  assert.equal(h.service.list().length, 1);
  assert.equal(h.checks.length, 1);

  // Signed out in a terminal: the next detection asks the official check, which says needs_login.
  h.clock.advance(MIN);
  h.login.claude = false;
  h.answers.set(adopted.id, { state: 'needs_login', message: 'Sign in to Claude Code.' });
  await h.service.detect(true);
  await h.settle();
  const signedOut = h.service.get(adopted.id)!;
  assert.equal(signedOut.state, 'needs_login');
  assert.deepEqual(signedOut.limits, adopted.limits, 'the last readings stay');
  assert.equal(h.checks.length, 2);

  // Signed in again outside Workforce: one more check makes it usable.
  h.login.claude = true;
  h.answers.delete(adopted.id);
  await h.service.detect(true);
  await h.settle();
  assert.equal(h.service.get(adopted.id)?.state, 'ok');
  assert.equal(h.checks.length, 3);
  h.db.close();
});

test('activity and turn ends share the provider cadence; Codex reads even without an existing server', async () => {
  const h = harness();
  h.repo.save(plan('acc_claude', 'claude', { checkedAt: T0, limits: reading(T0) }));
  h.repo.save(plan('acc_codex', 'codex', { checkedAt: T0, limits: reading(T0), priority: 1 }));
  h.clock.advance(REFRESH_MS.codex - 1);
  h.service.monitor.activity();
  await h.settle();
  assert.deepEqual(h.checks, []);
  h.clock.advance(1);
  h.service.monitor.afterTurn('acc_codex');
  await h.settle();
  assert.deepEqual(h.checks, ['acc_codex'], 'no 30-minute server-start gate');
  h.clock.advance(REFRESH_MS.claude - REFRESH_MS.codex);
  await h.service.usage();
  await h.settle();
  assert.deepEqual(h.checks, ['acc_codex', 'acc_claude', 'acc_codex']);
  h.service.monitor.afterTurn('acc_claude');
  await h.settle();
  assert.equal(h.checks.length, 3, 'no duplicate check within the interval');
  h.db.close();
});

test('stale: readings older than two minutes or with a passed reset are flagged; a changed flag is published', async () => {
  const limits = reading(T0);
  assert.equal(isStale(limits, T0 + 2 * MIN), false);
  assert.equal(isStale(limits, T0 + 2 * MIN + 1), true);
  assert.equal(isStale(reading(T0, 30, T0 + 10 * MIN), T0 + 10 * MIN), true, 'a passed reset');
  const summary = usageSummaries([plan('acc_a', 'claude', { limits })], T0 + 31 * MIN)[0];
  assert.equal(summary.limits?.stale, true);
  assert.equal(summary.weeklyRemainingPercent, 70);
  assert.equal(usageSummaries([plan('acc_a', 'claude', { limits })], T0 + MIN)[0].limits?.stale, false);
  assert.deepEqual(usageSummaries([plan('acc_k', 'openrouter', { auth: 'api_key' })], T0), [], 'only plans');

  // A signed-out plan is not checked by the cadence, yet its readings turning stale reach the UI once.
  const h = harness();
  h.repo.save(plan('acc_out', 'claude', { state: 'needs_login', checkedAt: T0, limits }));
  h.service.monitor.start();
  h.clock.advance(MIN);
  h.run();
  await h.settle();
  assert.equal(h.usage.length, 0, 'nothing changed');
  h.clock.advance(2 * MIN);
  h.run();
  await h.settle();
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0][0].limits?.stale, true);
  h.run();
  await h.settle();
  assert.equal(h.usage.length, 1, 'published once');
  assert.deepEqual(h.checks, []);
  assert.equal(h.service.get('acc_out')?.limits?.stale, undefined, 'the stored reading is not rewritten');
  h.db.close();
});

test('quota open: usage(refresh) checks at the provider cadence, one at a time, and returns the fresh readings', async () => {
  const h = harness();
  h.repo.save(plan('acc_c1', 'claude', { checkedAt: T0 - HOUR, limits: reading(T0 - HOUR, 90) }));
  h.repo.save(plan('acc_c2', 'claude', { checkedAt: T0 - HOUR, priority: 1 }));
  h.repo.save(plan('acc_codex', 'codex', { checkedAt: T0 - 10 * MIN, limits: reading(T0 - 10 * MIN) }));
  h.repo.save(plan('acc_key', 'openrouter', { auth: 'api_key' }));

  const [first, second] = await Promise.all([h.service.usage(true), h.service.usage(true)]);
  assert.deepEqual(h.checks, ['acc_c1', 'acc_codex', 'acc_c2'], 'both providers are read; API keys are not asked');
  assert.equal(h.flight.max, 1, 'one check at a time');
  const c1 = first.find((entry) => entry.accountId === 'acc_c1')!;
  assert.equal(c1.weeklyRemainingPercent, 60, 'the answer carries the fresh reading');
  assert.equal(c1.limits?.stale, false);
  assert.deepEqual(second, first);
  assert.ok(h.usage.length >= 2, 'usage.updated after each refresh');

  h.clock.advance(30_000);
  await h.service.usage(true);
  assert.deepEqual(h.checks.slice(3), ['acc_codex'], 'Claude throttled to one minute, Codex to 15 s');
  h.clock.advance(30_000);
  await h.service.usage(true);
  assert.deepEqual(h.checks.slice(4), ['acc_c1', 'acc_codex', 'acc_c2']);
  assert.equal(h.flight.max, 1);
  h.db.close();
});

test('failed checks keep the old limits and state; an error account comes back through the monitor', async () => {
  const h = harness();
  const old = reading(T0, 70);
  h.repo.save(plan('acc_claude', 'claude', { checkedAt: T0, limits: old, plan: 'pro', email: 'person@example.test' }));
  const before = h.service.get('acc_claude')!;

  // The check throws (CLI hung): nothing is stored.
  h.answers.set('acc_claude', new Error('timed out'));
  h.clock.advance(5 * MIN);
  h.service.monitor.activity();
  await h.settle();
  assert.deepEqual(h.service.get('acc_claude'), before);
  assert.equal(h.upserts.length, 0);
  // Retried with the cadence, not on every event.
  h.service.monitor.activity();
  await h.settle();
  assert.equal(h.checks.length, 1);

  // The check answers 'error' (did not answer): a background check changes nothing.
  h.answers.set('acc_claude', { state: 'error', message: 'Claude Code did not answer the account check.' });
  h.clock.advance(5 * MIN);
  h.service.monitor.activity();
  await h.settle();
  assert.deepEqual(h.service.get('acc_claude'), before);

  // Signed in but no usage reading this time: plan, e-mail and limits stay, the check time moves.
  h.answers.set('acc_claude', { state: 'ok' });
  h.clock.advance(5 * MIN);
  h.service.monitor.activity();
  await h.settle();
  const kept = h.service.get('acc_claude')!;
  assert.deepEqual(kept.limits, old);
  assert.equal(kept.plan, 'pro');
  assert.equal(kept.email, 'person@example.test');
  assert.equal(kept.checkedAt, h.clock.now());

  // A turn found the CLI missing ('error'); once it answers again, the monitor's next check clears it.
  assert.equal(h.service.markUnavailable('acc_claude', 'error'), true);
  h.answers.set('acc_claude', { state: 'error', message: 'Claude Code is not installed.' });
  h.clock.advance(5 * MIN);
  h.service.monitor.activity();
  await h.settle();
  assert.equal(h.service.get('acc_claude')?.state, 'error');
  h.answers.delete('acc_claude');
  h.clock.advance(5 * MIN);
  h.service.monitor.activity();
  await h.settle();
  assert.equal(h.service.get('acc_claude')?.state, 'ok');
  assert.equal(h.service.get('acc_claude')?.limits?.readAt, h.clock.now());

  // Sign-in and add keep their direct semantics: a failed foreground check shows the error.
  h.answers.set('acc_claude', { state: 'error', message: 'Claude Code is not installed.' });
  assert.equal((await h.service.check('acc_claude')).state, 'error');
  h.db.close();
});

test('sign-in and add: the check after a CLI login waits in the same serial queue; there a failure shows', async () => {
  const h = harness();
  h.repo.save(plan('acc_c1', 'claude', { checkedAt: T0 - HOUR }));
  let release!: () => void;
  h.holds.set('acc_c1', new Promise((resolve) => { release = resolve; }));
  const refresh = h.service.usage(true); // acc_c1 is being checked and holds the queue

  const added = await h.service.add({ provider: 'claude', label: 'Work' });
  assert.equal(added.state, 'needs_login', 'until the CLI sign-in ends');
  assert.equal(h.signingIn(added.id), true);
  await h.loginEnded(added.id);
  assert.deepEqual(h.checks, ['acc_c1'], 'the sign-in check waits for the running one');
  release();
  await refresh;
  await h.settle();
  assert.deepEqual(h.checks, ['acc_c1', added.id]);
  assert.equal(h.flight.max, 1);
  assert.equal(h.service.get(added.id)?.state, 'ok');
  assert.equal(h.service.get(added.id)?.plan, 'max');

  // Signing in again and the check fails: unlike a background check, the error shows.
  h.answers.set(added.id, { state: 'error', message: 'Claude Code is not installed.' });
  await h.service.login(added.id);
  await h.loginEnded(added.id);
  await h.settle();
  assert.equal(h.service.get(added.id)?.state, 'error');
  assert.equal(h.checks.length, 3);
  h.db.close();
});
