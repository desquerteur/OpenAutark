// Routing score headroom (PR2 carry-over): the plan discount and the headroom bonus use the
// windows that limit the scored model on its account (5h, weekly, the model's own window such as
// weekly-opus) – not the first account's plain weekly window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFactor, scoreModel } from '../../../src/runtime/routing/score.ts';
import type { Account, LimitWindow, ModelInfo } from '../../../src/shared/model/providers.ts';

const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const DAY = 24 * 60 * 60_000;

function plan(windows: LimitWindow[]): Account {
  return {
    id: 'acc_claude', provider: 'claude', label: 'Claude Code', auth: 'cli', state: 'ok', priority: 0, rotation: false,
    enabled: true, detected: false, createdAt: NOW, limits: { windows, readAt: NOW },
  };
}

function model(id: string): ModelInfo {
  return {
    id: `claude:${id}`, provider: 'claude', model: id, name: id, engine: 'claude', efforts: ['medium'], caps: {},
    tier: 'frontier', strengths: { coding: 0.5 }, available: true, accounts: ['acc_claude'],
  } as ModelInfo;
}

const weekly = (usedPercent: number): LimitWindow => ({ name: 'weekly', windowMinutes: 10080, usedPercent, resetsAt: NOW + 3 * DAY });
const opus = (usedPercent: number): LimitWindow => ({ name: 'weekly-opus', windowMinutes: 10080, usedPercent, resetsAt: NOW + 3 * DAY });
const fiveHour = (usedPercent: number): LimitWindow => ({ name: '5h', windowMinutes: 300, usedPercent, resetsAt: NOW + 2 * 60 * 60_000 });

test('costFactor: the model\'s own window counts – Opus nearly used up costs full price, Sonnet stays discounted', () => {
  const account = plan([weekly(20), opus(95)]);
  assert.equal(costFactor(account, NOW, 'claude-opus-5-5'), 1, '5 % left for Opus');
  assert.equal(costFactor(account, NOW, 'claude-sonnet-5'), 0.15, 'the Opus window does not limit Sonnet');
  assert.equal(costFactor(account, NOW), 0.15, 'without a model only account-wide windows count');
  assert.equal(costFactor(plan([weekly(10), fiveHour(80)]), NOW, 'claude-sonnet-5'), 0.5, 'the 5-hour window binds too');
  assert.equal(costFactor(plan([]), NOW, 'claude-sonnet-5'), 0.3, 'unknown headroom');
  const expired = plan([{ ...weekly(99), resetsAt: NOW - 1 }]);
  assert.equal(costFactor(expired, NOW, 'claude-sonnet-5'), 0.3, 'a passed reset is unknown, not used up');
});

test('scoreModel: less headroom for the scored model means a lower score on the same account', () => {
  const account = plan([weekly(20), opus(90)]);
  const base = { category: 'coding', costMode: 'balanced' as const, aa: 0.5, preferred: false, now: NOW, account };
  const opusModel = model('claude-opus-5-5');
  const sonnetModel = model('claude-sonnet-5');
  const roomy = scoreModel({ ...base, model: opusModel, account: plan([weekly(20)]) });
  const tight = scoreModel({ ...base, model: opusModel });
  assert.ok(tight < roomy, `Opus with its own window at 90 % (${tight}) scores below Opus without it (${roomy})`);
  assert.equal(scoreModel({ ...base, model: sonnetModel }), scoreModel({ ...base, model: sonnetModel, account: plan([weekly(20)]) }), 'Sonnet ignores the Opus window');
});
