// B-044 integration: the Codex reset credits' details only when the person asks. The account monitor's
// background reads (startup, its 15 s timer, activity, turn ends) ask without the details; checkNow (a
// sign-in, a used reset) and refreshAll (the quota card or Settings › Models opened) ask with
// them – refreshAll also reads a Codex plan whose count is known but whose details never came, even when it
// is not due; mergeLimits keeps the stored details on a count-only reading while they match its count.
// Owns: these assertions only. Never: a real Codex or provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountMonitor } from '../../../src/runtime/accounts/monitor.ts';
import { mergeLimits, normalizeCodexLimits } from '../../../src/runtime/accounts/limits.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { Account, AccountLimits } from '../../../src/shared/model/providers.ts';

const T0 = Date.UTC(2026, 9, 25, 12);
const SEC = T0 / 1000;

function rig(limits: AccountLimits) {
  const clock = new ManualClock(T0);
  let account: Account = { id: 'acc_codex', provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: T0, checkedAt: T0, limits };
  const reads: Array<{ background: boolean; details: boolean }> = [];
  const monitor = new AccountMonitor({
    clock, bus: new Bus((error) => { throw error; }), schedule: () => () => {},
    accounts: {
      list: () => [account], get: () => account,
      check: async (_id, background, details) => {
        reads.push({ background, details });
        account = { ...account, checkedAt: clock.now(), limits: { ...account.limits!, readAt: clock.now() } };
        return account;
      },
    },
  });
  return { clock, monitor, reads };
}

const withCount = (credits?: AccountLimits['resets']) => ({ windows: [], readAt: T0, ...(credits ? { resets: credits } : {}) });

test('background reads skip the reset details; checkNow and refreshAll ask for them', async () => {
  const h = rig(withCount({ available: 1, credits: [{ id: 'rc_1' }] }));
  h.monitor.start();
  await h.monitor.idle();
  assert.deepEqual(h.reads, [{ background: true, details: false }], 'the startup read');
  h.clock.advance(20_000);
  h.monitor.activity();
  await h.monitor.idle();
  assert.deepEqual(h.reads.at(-1), { background: true, details: false }, 'the cadence read');
  await h.monitor.checkNow('acc_codex');
  assert.deepEqual(h.reads.at(-1), { background: false, details: true }, 'after a used reset or a sign-in');
  h.clock.advance(20_000);
  await h.monitor.refreshAll();
  assert.deepEqual(h.reads.at(-1), { background: true, details: true }, 'the person opened the limits');
  const count = h.reads.length;
  await h.monitor.refreshAll();
  assert.equal(h.reads.length, count, 'not due and its details are there: no extra read');
  h.monitor.stop();
});

test('refreshAll reads a Codex plan at once whose count is known but whose details never came', async () => {
  const h = rig(withCount({ available: 2 }));
  await h.monitor.refreshAll();
  assert.deepEqual(h.reads, [{ background: true, details: true }], 'checked just now, still read for the details');
  const none = rig(withCount({ available: 0 }));
  await none.monitor.refreshAll();
  assert.deepEqual(none.reads, [], 'no reset available: nothing to fetch');
  h.monitor.stop(); none.monitor.stop();
});

test('mergeLimits: a count-only reading keeps the stored credit details while they match its count (minus expired ones; none at a count of 0)', () => {
  const windows = { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: SEC + 3600 } };
  const full = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 2, credits: [
    { id: 'rc_soon', grantedAt: SEC, expiresAt: SEC + 60, status: 'available', resetType: 'codexRateLimits' },
    { id: 'rc_late', grantedAt: SEC, expiresAt: SEC + 86_400, status: 'available', resetType: 'codexRateLimits' },
  ] } }, T0)!;
  const countOnly = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 2, credits: null } }, T0 + 1000)!;
  assert.deepEqual(countOnly.resets, { available: 2 });
  assert.deepEqual(mergeLimits(full, countOnly).resets, { available: 2, credits: full.resets!.credits });
  const later = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 1, credits: null } }, T0 + 120_000)!;
  assert.deepEqual(mergeLimits(full, later).resets, { available: 1, credits: [{ id: 'rc_late', expiresAt: (SEC + 86_400) * 1000 }] }, 'an expired credit goes');
  const used = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 0, credits: null } }, T0 + 2000)!;
  assert.deepEqual(mergeLimits(full, used).resets, { available: 0, credits: [] });
  const fresh = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 1, credits: [] } }, T0 + 3000)!;
  assert.deepEqual(mergeLimits(full, fresh).resets, { available: 1, credits: [] }, 'a detail read replaces them');
  assert.deepEqual(mergeLimits(withCount(), countOnly).resets, { available: 2 }, 'no stored details: the count only');
  const usedElsewhere = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 1, credits: null } }, T0 + 2000)!;
  assert.deepEqual(mergeLimits(full, usedElsewhere).resets, { available: 1 }, 'a reset used in another app: which credit went is unknown, the count only');
  const granted = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 3, credits: null } }, T0 + 2000)!;
  assert.deepEqual(mergeLimits(full, granted).resets, { available: 3 }, 'a new credit: its expiry is unknown, the count only');
});
