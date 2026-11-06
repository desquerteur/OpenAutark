// B-048 E4.1 – "use it or lose it" inside one provider (accounts/candidates.ts): expiring = remaining share
// × urgency(reset) – weekly windows urgent within 24 h, 5h windows within 1 h –, only for plan quota,
// with the guard that a 5h window under 10 % is never pushed while the weekly window has more; the plan
// login whose quota resets soonest with some left goes first (priority still before it); deterministic
// with a fixed clock. Owns: these assertions only. Never: real accounts or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPIRING_MIN, expiring, expiringRank, selectCandidates, urgency } from '../../../src/runtime/accounts/candidates.ts';
import type { Account, LimitWindow, ProviderId } from '../../../src/shared/model/providers.ts';

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function plan(id: string, provider: ProviderId, patch: Partial<Account> = {}): Account {
  return {
    id, provider, label: id, auth: provider === 'codex' || provider === 'claude' ? 'cli' : 'api_key', state: 'ok',
    priority: 0, rotation: true, enabled: true, detected: false, createdAt: T0, ...patch,
  };
}
const win = (name: string, usedPercent: number, resetsAt?: number): LimitWindow => ({ name, windowMinutes: name.startsWith('5h') ? 300 : 10080, usedPercent, resetsAt });
const limits = (...windows: LimitWindow[]) => ({ windows, readAt: T0 });
const ids = (accounts: Account[]) => accounts.map((account) => account.id);

test('urgency: weekly within 24 h and 5h within 1 h are 1; weekly decays slowly, 5h falls to 0 one hour later', () => {
  assert.equal(urgency(10080, 23 * HOUR), 1);
  assert.equal(urgency(10080, DAY), 1);
  assert.equal(urgency(10080, 2 * DAY), 0.5);
  assert.equal(urgency(10080, 6 * DAY), 1 / 6);
  assert.equal(urgency(300, 30 * 60_000), 1);
  assert.equal(urgency(300, 1.5 * HOUR), 0.5);
  assert.equal(urgency(300, 2 * HOUR), 0);
  assert.equal(urgency(300, 4.5 * HOUR), 0);
});

test('expiring: remaining share × urgency for plan quota only; the 5h guard', () => {
  const soon = plan('acc_soon', 'codex', { limits: limits(win('5h', 10, T0 + 4 * HOUR), win('weekly', 40, T0 + 10 * HOUR)) });
  assert.equal(expiring(soon, T0), 0.6, '60 % of the week left, reset in 10 h');
  const later = plan('acc_later', 'codex', { limits: limits(win('5h', 0, T0 + 4 * HOUR), win('weekly', 10, T0 + 6 * DAY)) });
  assert.equal(expiring(later, T0), 0.15, '90 % left, reset in 6 days');
  // The smallest remaining share of the windows that apply is what can still be used.
  const capped = plan('acc_capped', 'claude', { limits: limits(win('weekly', 20, T0 + 5 * HOUR), win('weekly-opus', 70, T0 + 5 * HOUR)) });
  assert.equal(expiring(capped, T0, 'claude-opus-5-5'), 0.3);
  assert.equal(expiring(capped, T0, 'claude-sonnet-5'), 0.8);
  // A 5h window about to reset counts too while the weekly window has room.
  assert.equal(expiring(plan('acc_5h', 'codex', { limits: limits(win('5h', 30, T0 + 30 * 60_000), win('weekly', 50, T0 + 5 * DAY)) }), T0), 0.5);

  // Guard: under 10 % of the 5h window left while the weekly window has more – never pushed further.
  const guarded = plan('acc_guard', 'codex', { limits: limits(win('5h', 95, T0 + 3 * HOUR), win('weekly', 20, T0 + 5 * HOUR)) });
  assert.equal(expiring(guarded, T0), 0);
  assert.equal(expiring({ ...guarded, limits: limits(win('5h', 95, T0 + 3 * HOUR), win('weekly', 97, T0 + 5 * HOUR)) }, T0), 0.03, 'the weekly window has less: nothing to protect');

  // No plan quota, no reading, expired readings: 0.
  const reset = limits(win('weekly', 10, T0 + HOUR));
  assert.equal(expiring(plan('acc_key', 'openai', { limits: reset }), T0), 0, 'a pay-per-use key never expires');
  assert.equal(expiring(plan('acc_env', 'claude', { auth: 'env', limits: reset }), T0), 0);
  assert.equal(expiring(plan('acc_apilogin', 'codex', { plan: 'api', limits: reset }), T0), 0, 'a CLI signed in with an API key pays per use');
  assert.equal(expiring(plan('acc_none', 'codex'), T0), 0);
  assert.equal(expiring(plan('acc_old', 'codex', { limits: limits(win('weekly', 10, T0 - 1)) }), T0), 0);
  assert.equal(expiringRank(plan('acc_small', 'codex', { limits: limits(win('weekly', 50, T0 + 5 * DAY)) }), T0), 0, `below ${EXPIRING_MIN} it does not rank`);
});

test('the login whose quota resets soonest with some left goes first; priority still first; deterministic', () => {
  // Headroom alone would pick B (90 % left); A's 60 % are lost in 10 h.
  const a = plan('acc_a', 'codex', { limits: limits(win('5h', 10, T0 + 4 * HOUR), win('weekly', 40, T0 + 10 * HOUR)) });
  const b = plan('acc_b', 'codex', { createdAt: T0 + 1, limits: limits(win('5h', 0, T0 + 4 * HOUR), win('weekly', 10, T0 + 6 * DAY)) });
  assert.deepEqual(ids(selectCandidates([b, a], 'codex', T0)), ['acc_a', 'acc_b']);
  for (let i = 0; i < 3; i++) assert.deepEqual(ids(selectCandidates([a, b], 'codex', T0)), ['acc_a', 'acc_b'], 'same input, same order');
  assert.deepEqual(ids(selectCandidates([a, { ...b, priority: -1 }], 'codex', T0)), ['acc_b', 'acc_a'], 'the person’s priority first');

  // A's 5h window nearly used up while the week has more: the guard – headroom decides again.
  const drained = { ...a, limits: limits(win('5h', 95, T0 + 4 * HOUR), win('weekly', 40, T0 + 10 * HOUR)) };
  assert.deepEqual(ids(selectCandidates([drained, b], 'codex', T0)), ['acc_b', 'acc_a']);

  // Two days later B's reset is near and A's window has reset (its old reading expired): B first.
  const later = T0 + 5.5 * DAY;
  assert.deepEqual(ids(selectCandidates([a, b], 'codex', later)), ['acc_b', 'acc_a']);

  // Inside one step of EXPIRING_TIE the remaining share decides (transitive order).
  const c = plan('acc_c', 'codex', { createdAt: T0 + 2, limits: limits(win('weekly', 40, T0 + 10 * HOUR)) });
  const d = plan('acc_d', 'codex', { createdAt: T0 + 3, limits: limits(win('weekly', 38, T0 + 10 * HOUR)) });
  assert.deepEqual(ids(selectCandidates([c, d], 'codex', T0)), ['acc_d', 'acc_c'], '0.62 and 0.6 share a step: more left first');
});
