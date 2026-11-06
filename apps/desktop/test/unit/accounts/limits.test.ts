// Usage-limit normalizers (accounts/limits.ts): Codex rateLimits payloads, Claude get_usage and the
// stream's rate_limit_event (fraction vs percent, an ambiguous 100 % vs a rejection), window names
// and the models a suffixed window binds, merging and the weekly window. Invalid windows are
// dropped, never read as 0 %. B-044: Codex banked resets (rateLimitResetCredits) and how merging keeps them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexLimitReached, mergeLimits, normalizeClaudeUsage, normalizeCodexLimits, normalizeCodexResets, parseClaudeRateLimitEvent, weeklyWindow, windowApplies, windowScope,
} from '../../../src/runtime/accounts/limits.ts';

const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);
const SEC = Math.floor(NOW / 1000);

test('normalizeCodexLimits: the main bucket unsuffixed, other buckets by name; seconds become ms; bad windows dropped', () => {
  const single = normalizeCodexLimits({ rateLimits: { primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: SEC + 3600 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } }, NOW);
  assert.deepEqual(single, {
    windows: [
      { name: '5h', windowMinutes: 300, usedPercent: 12.5, resetsAt: (SEC + 3600) * 1000 },
      { name: 'weekly', windowMinutes: 10080, usedPercent: 40, resetsAt: undefined },
    ],
    readAt: NOW,
  });
  const byId = normalizeCodexLimits({
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 5, windowDurationMins: 1440 } },
      'gpt-5-3-codex-spark': { limitName: 'GPT-5.3 Codex Spark', primary: { usedPercent: 70, windowDurationMins: 10080 }, secondary: { usedPercent: 1, windowDurationMins: 90 } },
      'bad id!': { primary: { usedPercent: 1, windowDurationMins: 300 } },
      broken: { primary: { usedPercent: 101, windowDurationMins: 300 }, secondary: { usedPercent: -1, windowDurationMins: 300 } },
      odd: { primary: { usedPercent: 10, windowDurationMins: 1.5 }, secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: -5 } },
    },
  }, NOW);
  assert.deepEqual(byId?.windows.map((window) => [window.name, window.usedPercent]), [['1d', 5], ['weekly-gpt-5-3-codex-spark', 70], ['90m-gpt-5-3-codex-spark', 1]]);
  assert.equal(normalizeCodexLimits({ rateLimits: { primary: { usedPercent: '40', windowDurationMins: 300 } } }, NOW), undefined, 'nothing valid: no reading');
  assert.equal(normalizeCodexLimits(null, NOW), undefined);
  assert.equal(normalizeCodexLimits([], NOW), undefined);
});

test('codexLimitReached: a rateLimitReachedType on any bucket', () => {
  assert.equal(codexLimitReached({ rateLimits: { rateLimitReachedType: 'primary' } }), true);
  assert.equal(codexLimitReached({ rateLimitsByLimitId: { spark: { rateLimitReachedType: 'secondary' } } }), true);
  assert.equal(codexLimitReached({ rateLimits: { primary: { usedPercent: 100 } } }), false);
  assert.equal(codexLimitReached('limit'), false);
});

test('normalizeClaudeUsage: 5h, weekly and model windows with their reset; a plan only from the known list', () => {
  const usage = normalizeClaudeUsage({
    rate_limits_available: true, subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 22, resets_at: '2026-10-21T12:00:00Z' },
      seven_day: { utilization: 61.5, resets_at: 'not a date' },
      seven_day_opus: { utilization: 90, resets_at: '2026-10-25T00:00:00Z' },
      seven_day_sonnet: { utilization: 140 },
      seven_day_oauth_apps: { utilization: '3' },
    },
  }, NOW);
  assert.deepEqual(usage, {
    limits: {
      windows: [
        { name: '5h', windowMinutes: 300, usedPercent: 22, resetsAt: Date.parse('2026-10-21T12:00:00Z') },
        { name: 'weekly', windowMinutes: 10080, usedPercent: 61.5, resetsAt: undefined },
        { name: 'weekly-opus', windowMinutes: 10080, usedPercent: 90, resetsAt: Date.parse('2026-10-25T00:00:00Z') },
      ],
      readAt: NOW,
    },
    plan: 'max',
  });
  assert.deepEqual(normalizeClaudeUsage({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 1 } } }, NOW), {});
  assert.deepEqual(normalizeClaudeUsage({ rate_limits_available: true, subscription_type: 'ultra', rate_limits: {} }, NOW), { limits: undefined, plan: undefined });
});

test('parseClaudeRateLimitEvent: fractions and percents, an ambiguous 100 % stays below 100, only a rejection uses the window up', () => {
  const event = (info: Record<string, unknown>) => parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: info }, NOW);
  const used = (info: Record<string, unknown>) => event(info).limits?.windows[0]?.usedPercent;
  assert.equal(used({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42 }), 42, 'a fraction');
  assert.equal(used({ status: 'allowed', rateLimitType: 'five_hour', utilization: 42 }), 42, 'a percent');
  assert.equal(used({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 100 }), 99, 'not rejected: never shuts the plan out');
  assert.equal(used({ status: 'allowed', rateLimitType: 'seven_day', utilization: 1 }), 99, '1 reads as the whole fraction – still below 100');
  assert.equal(used({ status: 'rejected', rateLimitType: 'seven_day', utilization: 0.5 }), 100);
  assert.equal(used({ status: 'allowed', rateLimitType: 'seven_day', utilization: 250 }), undefined, 'out of range: no window');

  const rejected = event({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: SEC + 7200 });
  assert.deepEqual(rejected, {
    rejected: true, resetsAt: (SEC + 7200) * 1000,
    limits: { windows: [{ name: 'weekly-opus', windowMinutes: 10080, usedPercent: 100, resetsAt: (SEC + 7200) * 1000 }], readAt: NOW },
  });
  assert.equal(event({ status: 'rejected', resetsAt: NOW + 5000 }).resetsAt, NOW + 5000, 'a reset already in ms stays');
  assert.equal(event({ status: 'rejected', resetsAt: NOW }).limits, undefined, 'no window type: no reading');
  assert.equal(event({ status: 'allowed', rateLimitType: 'seven_day_new_model', utilization: 0.3 }).limits?.windows[0]?.name, 'weekly', 'an unknown seven-day type is weekly');
  assert.deepEqual(parseClaudeRateLimitEvent({ type: 'rate_limit_event' }, NOW), { rejected: false });
  assert.deepEqual(parseClaudeRateLimitEvent('nope', NOW), { rejected: false });
});

test('mergeLimits, windowScope, windowApplies and weeklyWindow', () => {
  const previous = { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 10 }, { name: 'weekly', windowMinutes: 10080, usedPercent: 30, resetsAt: NOW + 1000 }], readAt: NOW - 60_000 };
  const merged = mergeLimits(previous, { windows: [{ name: 'weekly', windowMinutes: 10080, usedPercent: 35, resetsAt: NOW + 1000 }], readAt: NOW });
  assert.deepEqual(merged.windows.map((window) => [window.name, window.usedPercent]), [['5h', 10], ['weekly', 35]]);
  assert.equal(merged.readAt, NOW);
  assert.equal(mergeLimits(undefined, previous), previous);

  assert.equal(windowScope('weekly-opus'), 'opus');
  assert.equal(windowScope('90m-gpt-5-3-codex-spark'), 'gpt-5-3-codex-spark');
  assert.equal(windowScope('weekly'), undefined);
  assert.equal(windowApplies('5h'), true);
  assert.equal(windowApplies('weekly-opus', 'claude-opus-5-5'), true);
  assert.equal(windowApplies('weekly-opus', 'claude-sonnet-5-5'), false);
  assert.equal(windowApplies('weekly-opus'), false, 'without a model only account-wide windows bind');
  assert.equal(windowApplies('weekly-gpt-5-3-codex-spark', 'gpt-5.3-codex-spark'), true);
  assert.equal(windowApplies('weekly-gpt-5-3-codex-spark', 'gpt-5.3-codex'), false);

  assert.equal(weeklyWindow(previous, NOW)?.usedPercent, 30);
  assert.equal(weeklyWindow(previous, NOW + 2000), undefined, 'a passed reset is unknown, not 0 %');
  assert.equal(weeklyWindow({ windows: [{ name: 'weekly-opus', windowMinutes: 10080, usedPercent: 5 }], readAt: NOW }, NOW), undefined);
});

test('B-044 normalizeCodexResets: the count, the available credits soonest expiry first, seconds become ms; bad input is no reading', () => {
  const resets = normalizeCodexResets({
    availableCount: 3,
    credits: [
      { id: 'rc_b', grantedAt: SEC, expiresAt: SEC + 7200, resetType: 'codexRateLimits', status: 'available', title: ' Bonus ' },
      { id: 'rc_a', grantedAt: SEC, expiresAt: SEC + 3600, resetType: 'codexRateLimits', status: 'available' },
      { id: 'rc_c', grantedAt: SEC, expiresAt: null, resetType: 'unknown', status: 'available' },
      { id: 'rc_used', grantedAt: SEC, status: 'redeemed', resetType: 'codexRateLimits' },
      { id: '', grantedAt: SEC, status: 'available', resetType: 'codexRateLimits' },
      'nonsense',
    ],
  });
  assert.deepEqual(resets, {
    available: 3,
    credits: [{ id: 'rc_a', expiresAt: (SEC + 3600) * 1000 }, { id: 'rc_b', title: 'Bonus', expiresAt: (SEC + 7200) * 1000 }, { id: 'rc_c' }],
  });
  assert.deepEqual(normalizeCodexResets({ availableCount: 2, credits: null }), { available: 2 }, 'null: only the count is known');
  assert.deepEqual(normalizeCodexResets({ availableCount: 0, credits: [] }), { available: 0, credits: [] });
  for (const bad of [null, {}, { availableCount: -1 }, { availableCount: 1.5 }, { availableCount: '2' }]) assert.equal(normalizeCodexResets(bad), undefined, JSON.stringify(bad));
});

test('B-044 normalizeCodexLimits + mergeLimits: a read sets the resets (also to none), a sparse push keeps the stored ones', () => {
  const windows = { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: SEC + 3600 } };
  const read = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'rc_1', grantedAt: SEC, status: 'available', resetType: 'codexRateLimits' }] } }, NOW)!;
  assert.deepEqual(read.resets, { available: 1, credits: [{ id: 'rc_1' }] });
  const push = normalizeCodexLimits({ rateLimits: windows }, NOW + 1)!;
  assert.equal(Object.hasOwn(push, 'resets'), false, 'the push says nothing about resets');
  assert.deepEqual(mergeLimits(read, push).resets, { available: 1, credits: [{ id: 'rc_1' }] }, 'kept');
  const emptied = normalizeCodexLimits({ rateLimits: windows, rateLimitResetCredits: null }, NOW + 2)!;
  assert.equal(mergeLimits(read, emptied).resets, undefined, 'a read without resets drops the old count');
  assert.equal(Object.hasOwn(mergeLimits(undefined, push), 'resets'), false);
});
