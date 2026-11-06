// Limit-aware account selection (PR1): a used-up window counts as cooling until its reset, model
// windows (weekly-opus …) exclude only matching models, the plan primary is the first signed-in
// account while the opt-in rotation stays, ranking takes the smallest headroom of the windows that
// apply, the router asks per model, and the real AccountService passes the model through and
// records turn-reported states.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedUntil, headroom, isHealthy, modelOnlyLimit, selectCandidates,
} from '../../../src/runtime/accounts/candidates.ts';
import { parseClaudeRateLimitEvent, windowApplies, windowScope } from '../../../src/runtime/accounts/limits.ts';
import { AccountServiceImpl, type AccountServiceDeps } from '../../../src/runtime/accounts/service.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { planPrimary } from '../../../src/shared/model/plan-roles.ts';
import type { Account, EngineId, LimitWindow, ProviderId } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent, mode, standardSetup } from '../models/harness.ts';

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function plan(id: string, provider: ProviderId, patch: Partial<Account> = {}): Account {
  return {
    id, provider, label: id, auth: provider === 'codex' || provider === 'claude' ? 'cli' : 'api_key', state: 'ok',
    priority: 0, rotation: false, enabled: true, detected: false, createdAt: T0, ...patch,
  };
}

const win = (name: string, usedPercent: number, resetsAt?: number): LimitWindow => ({
  name, windowMinutes: name.startsWith('5h') ? 300 : 10080, usedPercent, resetsAt,
});
const limits = (...windows: LimitWindow[]) => ({ windows, readAt: T0 });
const ids = (accounts: Account[]) => accounts.map((account) => account.id);

test('a used-up 5h or weekly window counts as cooling until its reset, then the plan is healthy again', () => {
  const fiveHour = plan('acc_5h', 'codex', { limits: limits(win('5h', 100, T0 + HOUR), win('weekly', 40, T0 + 3 * DAY)) });
  assert.equal(isHealthy(fiveHour, T0), false);
  assert.equal(blockedUntil(fiveHour, T0), T0 + HOUR);
  assert.deepEqual(ids(selectCandidates([fiveHour], 'codex', T0)), []);
  assert.deepEqual(ids(selectCandidates([fiveHour], 'codex', T0 + HOUR - 1)), []);
  assert.deepEqual(ids(selectCandidates([fiveHour], 'codex', T0 + HOUR)), ['acc_5h'], 'the reading expired with the reset');

  const weekly = plan('acc_week', 'claude', { limits: limits(win('5h', 10, T0 + HOUR), win('weekly', 100, T0 + 2 * DAY)) });
  assert.deepEqual(ids(selectCandidates([weekly], 'claude', T0 + DAY)), []);
  assert.equal(blockedUntil(weekly, T0), T0 + 2 * DAY);
  assert.deepEqual(ids(selectCandidates([weekly], 'claude', T0 + 2 * DAY + 1)), ['acc_week']);

  // Both apply: the later reset decides. A marked cooling counts the same way.
  const both = plan('acc_both', 'codex', { coolingUntil: T0 + 30 * 60_000, state: 'cooling', limits: limits(win('5h', 100, T0 + HOUR), win('weekly', 100, T0 + DAY)) });
  assert.equal(blockedUntil(both, T0), T0 + DAY);
  // 99 % still runs; 100 % without a known reset is left to the provider's own limit answer.
  assert.equal(isHealthy(plan('acc_99', 'codex', { limits: limits(win('5h', 99, T0 + HOUR)) }), T0), true);
  assert.equal(isHealthy(plan('acc_noreset', 'codex', { limits: limits(win('5h', 100)) }), T0), true);
});

test('weekly-opus at 100 % excludes opus but keeps sonnet; model windows need the model', () => {
  const claude = plan('acc_claude', 'claude', { limits: limits(win('weekly-opus', 100, T0 + 2 * DAY), win('weekly', 40, T0 + 3 * DAY)) });
  assert.deepEqual(ids(selectCandidates([claude], 'claude', T0, 'claude-opus-5-5')), []);
  assert.deepEqual(ids(selectCandidates([claude], 'claude', T0, 'opus')), [], 'the alias too');
  assert.deepEqual(ids(selectCandidates([claude], 'claude', T0, 'claude-sonnet-5')), ['acc_claude']);
  assert.deepEqual(ids(selectCandidates([claude], 'claude', T0)), ['acc_claude'], 'without a model only account-wide windows bind');
  assert.equal(blockedUntil(claude, T0, 'claude-opus-5-5'), T0 + 2 * DAY);
  assert.deepEqual(ids(selectCandidates([claude], 'claude', T0 + 2 * DAY + 1, 'claude-opus-5-5')), ['acc_claude']);

  // weekly-sonnet the other way round; Codex model buckets ("5h-<limit name>") the same way.
  const sonnet = plan('acc_sonnet', 'claude', { limits: limits(win('weekly-sonnet', 100, T0 + DAY)) });
  assert.equal(isHealthy(sonnet, T0, 'claude-sonnet-5'), false);
  assert.equal(isHealthy(sonnet, T0, 'claude-opus-5-5'), true);
  const codex = plan('acc_codex', 'codex', { limits: limits(win('5h-gpt-5-3-codex-spark', 100, T0 + HOUR)) });
  assert.equal(isHealthy(codex, T0, 'gpt-5.3-codex-spark'), false);
  assert.equal(isHealthy(codex, T0, 'gpt-5.3-codex'), true, 'whole words only');

  // Scopes: account-wide names have none; a scope that names no model never excludes anything.
  assert.equal(windowScope('5h'), undefined);
  assert.equal(windowScope('weekly'), undefined);
  assert.equal(windowScope('weekly-opus'), 'opus');
  assert.equal(windowApplies('weekly-oauth-apps', 'claude-opus-5-5'), false);
  assert.equal(windowApplies('weekly-opus', 'opusplan'), false);
  assert.equal(windowApplies('5h', 'anything'), true);
});

test('a primary that needs sign-in lets the second plan run without rotation', () => {
  const first = plan('acc_1', 'claude', { state: 'needs_login', priority: 0 });
  const second = plan('acc_2', 'claude', { priority: 1, rotation: false, createdAt: T0 + 1 });
  assert.deepEqual(ids(selectCandidates([first, second], 'claude', T0)), ['acc_2']);
  assert.equal(planPrimary([first, second])?.id, 'acc_2');
  // An error or a switched-off first plan never shuts out the next one either.
  assert.deepEqual(ids(selectCandidates([{ ...first, state: 'error' }, second], 'claude', T0)), ['acc_2']);
  assert.deepEqual(ids(selectCandidates([{ ...first, state: 'disabled', enabled: false }, second], 'claude', T0)), ['acc_2']);
  // Once signed in again it is the primary and the second (rotation off) stays out.
  assert.deepEqual(ids(selectCandidates([{ ...first, state: 'ok' }, second], 'claude', T0)), ['acc_1']);
});

test('rotation off with the primary cooling yields no plan of that provider; rotation on uses the backup', () => {
  const primary = plan('acc_1', 'claude', { state: 'cooling', coolingUntil: T0 + HOUR, priority: 0 });
  const second = plan('acc_2', 'claude', { priority: 1, createdAt: T0 + 1 });
  assert.deepEqual(ids(selectCandidates([primary, second], 'claude', T0)), []);
  assert.deepEqual(ids(selectCandidates([primary, { ...second, rotation: true }], 'claude', T0)), ['acc_2']);
  // A used-up window cools the primary the same way (no state change needed).
  const usedUp = plan('acc_1', 'claude', { priority: 0, limits: limits(win('5h', 100, T0 + HOUR)) });
  assert.deepEqual(ids(selectCandidates([usedUp, second], 'claude', T0)), []);
  assert.deepEqual(ids(selectCandidates([usedUp, { ...second, rotation: true }], 'claude', T0)), ['acc_2']);
  // After the reset the primary is used first again, the backup stays behind it.
  assert.deepEqual(ids(selectCandidates([primary, { ...second, rotation: true }], 'claude', T0 + HOUR)), ['acc_1', 'acc_2']);
  // Keyed providers have no rotation rule.
  const keys = [plan('acc_k1', 'openrouter', { state: 'cooling', coolingUntil: T0 + HOUR }), plan('acc_k2', 'openrouter', { priority: 1 })];
  assert.deepEqual(ids(selectCandidates(keys, 'compatible', T0)), ['acc_k2']);
});

test('ranking takes the smallest remaining share of 5h and weekly (and the model window)', () => {
  // Weekly alone would prefer A (80 % left); its 5h window has only 5 % left.
  const a = plan('acc_a', 'codex', { rotation: true, limits: limits(win('5h', 95, T0 + HOUR), win('weekly', 20, T0 + 3 * DAY)) });
  const b = plan('acc_b', 'codex', { rotation: true, createdAt: T0 + 1, limits: limits(win('5h', 10, T0 + HOUR), win('weekly', 60, T0 + 3 * DAY)) });
  assert.equal(headroom(a, T0), 5);
  assert.equal(headroom(b, T0), 40);
  assert.deepEqual(ids(selectCandidates([a, b], 'codex', T0)), ['acc_b', 'acc_a']);
  // Priority still comes first.
  assert.deepEqual(ids(selectCandidates([a, { ...b, priority: 1 }], 'codex', T0)), ['acc_a', 'acc_b']);

  // An opus turn also counts the opus window; a sonnet turn does not.
  const c = plan('acc_c', 'claude', { rotation: true, limits: limits(win('weekly', 10, T0 + DAY), win('weekly-opus', 90, T0 + DAY)) });
  const d = plan('acc_d', 'claude', { rotation: true, createdAt: T0 + 1, limits: limits(win('weekly', 50, T0 + DAY), win('weekly-opus', 20, T0 + DAY)) });
  assert.deepEqual(ids(selectCandidates([c, d], 'claude', T0, 'claude-opus-5-5')), ['acc_d', 'acc_c']);
  assert.deepEqual(ids(selectCandidates([c, d], 'claude', T0, 'claude-sonnet-5')), ['acc_c', 'acc_d']);
  // Unknown limits rank in the middle; expired readings are unknown.
  assert.equal(headroom(plan('acc_e', 'codex', { limits: limits(win('weekly', 30, T0 - 1)) }), T0), undefined);
});

test('a limit that only used up the model window belongs to the model, not the account', () => {
  const opus = plan('acc_c', 'claude', { limits: limits(win('weekly-opus', 100, T0 + DAY), win('weekly', 30, T0 + 3 * DAY)) });
  assert.equal(modelOnlyLimit(opus, T0, 'claude-opus-5-5'), true);
  assert.equal(modelOnlyLimit(opus, T0, 'claude-sonnet-5'), false, 'not the window of the model that ran');
  const both = plan('acc_c', 'claude', { limits: limits(win('weekly-opus', 100, T0 + DAY), win('5h', 100, T0 + HOUR)) });
  assert.equal(modelOnlyLimit(both, T0, 'claude-opus-5-5'), false, 'an account-wide window is used up too');
  assert.equal(modelOnlyLimit(plan('acc_none', 'claude'), T0, 'claude-opus-5-5'), false);
  const oauth = plan('acc_o', 'claude', { limits: limits(win('weekly-oauth-apps', 100, T0 + DAY)) });
  assert.equal(modelOnlyLimit(oauth, T0, 'claude-opus-5-5'), false, 'a scope naming no model cools the account');
});

test('Claude rate_limit_event: a rejection uses the window up; an allowed 100 % reading never does', () => {
  const reset = Math.floor((T0 + DAY) / 1000);
  const event = (info: Record<string, unknown>) => parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: info }, T0);
  const rejected = event({ status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_opus', utilization: 0.97 });
  assert.equal(rejected.rejected, true);
  assert.deepEqual(rejected.limits?.windows, [{ name: 'weekly-opus', windowMinutes: 10080, usedPercent: 100, resetsAt: reset * 1000 }]);
  assert.deepEqual(event({ status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' }).limits?.windows.map((w) => [w.name, w.usedPercent]), [['5h', 100]]);
  assert.equal(event({ status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour', utilization: 1 }).limits?.windows[0].usedPercent, 99);
  assert.equal(event({ status: 'allowed_warning', resetsAt: reset, rateLimitType: 'five_hour', utilization: 0.8 }).limits?.windows[0].usedPercent, 80);
  assert.equal(event({ status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_oauth_apps' }).limits?.windows[0].name, 'weekly-oauth-apps', 'same names as get_usage');
  assert.equal(event({ status: 'allowed', rateLimitType: 'five_hour' }).limits, undefined, 'no reading, nothing invented');
});

test('AccountService: candidates get the model; turn-reported sign-out and missing CLI change the state once', () => {
  const db = new Db(':memory:');
  migrate(db);
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock(T0);
  const events: string[] = [];
  bus.onAny((event) => events.push(event));
  const unused = () => { throw new Error('not used in this test'); };
  const service = new AccountServiceImpl({
    db, bus, clock, paths: { accounts: 'accounts' }, engines: unused,
    finder: {} as AccountServiceDeps['finder'], supervisor: {} as AccountServiceDeps['supervisor'], secrets: {} as AccountServiceDeps['secrets'],
  });
  const repo = new AccountRepo(db);
  repo.save(plan('acc_1', 'claude', { limits: limits(win('weekly-opus', 100, T0 + DAY), win('weekly', 20, T0 + 3 * DAY)) }));
  repo.save(plan('acc_2', 'claude', { priority: 1, rotation: true, createdAt: T0 + 1 }));

  assert.deepEqual(ids(service.candidates('claude', 'claude-opus-5-5')), ['acc_2']);
  assert.deepEqual(ids(service.candidates('claude', 'claude-sonnet-5')), ['acc_1', 'acc_2']);

  // Signed out: needs_login (not cooling), reported as a change once.
  assert.equal(service.markUnavailable('acc_1', 'needs_login'), true);
  assert.equal(service.markUnavailable('acc_1', 'needs_login'), false);
  assert.equal(service.get('acc_1')?.state, 'needs_login');
  assert.equal(service.get('acc_1')?.coolingUntil, undefined);
  assert.deepEqual(ids(service.candidates('claude', 'claude-sonnet-5')), ['acc_2'], 'the backup takes over');
  assert.ok(events.includes('account.upserted') && events.includes('usage.updated'));

  // CLI missing: error. A switched-off account is left alone.
  assert.equal(service.markUnavailable('acc_2', 'error'), true);
  assert.equal(service.get('acc_2')?.state, 'error');
  assert.deepEqual(ids(service.candidates('claude')), []);
  service.update('acc_1', { enabled: false });
  assert.equal(service.markUnavailable('acc_1', 'error'), false);
  assert.equal(service.get('acc_1')?.state, 'disabled');
  db.close();
});

test('the router asks per model: a used-up weekly-opus moves opus work to another model; all limited names the earliest reset', async () => {
  const h = await standardSetup();
  const asked: Array<[EngineId, string | undefined]> = [];
  h.accounts.candidates = (engine: EngineId, model?: string) => {
    asked.push([engine, model]);
    return selectCandidates(h.accounts.accounts, engine, h.clock.now(), model);
  };
  const now = h.clock.now();
  const video = { agent: agent('ag_1'), mode: mode('chat'), text: 'Bitte schneide das Musikvideo und baue eine Intro-Animation in Remotion.' };
  assert.equal((await h.router.route(video)).modelId, 'claude:claude-opus-5-5');
  assert.ok(asked.some(([engine, model]) => engine === 'claude' && model === 'claude-opus-5-5'), 'the model reaches accounts.candidates');

  const claude = h.accounts.get('acc_claude')!;
  h.accounts.upsert({ ...claude, limits: limits(win('weekly-opus', 100, now + DAY), win('weekly', 30, now + 3 * DAY)) }, false);
  const moved = await h.router.route(video);
  assert.notEqual(moved.modelId, 'claude:claude-opus-5-5');
  assert.equal((await h.router.route({ ...video, agent: agent('ag_1', { modelPolicy: { pin: 'claude:claude-haiku-5-5' } }) })).accountId, 'acc_claude', 'other Claude models keep the plan');

  // Every plan used up: the error says when the first one is back (the 5h reset, not the weekly one).
  h.accounts.upsert({ ...claude, limits: limits(win('weekly', 100, now + DAY)) }, false);
  h.accounts.upsert({ ...h.accounts.get('acc_codex')!, limits: limits(win('5h', 100, now + HOUR)) }, false);
  await assert.rejects(h.router.route(video), (error: unknown) => {
    assert.ok(error instanceof WorkforceError);
    assert.match(error.message, /limited right now/);
    assert.equal(error.retryAfterMs, HOUR);
    return true;
  });
});
