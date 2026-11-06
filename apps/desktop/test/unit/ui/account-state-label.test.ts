// Settings › Accounts state chip (PR2 carry-over): "Limit reached" only while a limit window is used
// up; a cooling without one is the short pause after an overloaded or unanswered provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliRowView, FREE_PLAN_LABEL, FREE_PLAN_ROW, SHORT_PAUSE_LABEL, STATE_LABELS, stateLabel } from '../../../src/ui/settings/providers.ts';
import type { Account, LimitWindow } from '../../../src/shared/model/providers.ts';

const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);

function cooling(windows: LimitWindow[], patch: Partial<Account> = {}): Account {
  return {
    id: 'acc_codex', provider: 'codex', label: 'Codex', auth: 'cli', state: 'cooling', coolingUntil: NOW + 60_000, priority: 0,
    rotation: false, enabled: true, detected: false, createdAt: NOW, limits: { windows, readAt: NOW - 60_000 }, ...patch,
  };
}

test('state chip: a used-up window says "Limit reached", an overload pause says so briefly', () => {
  const used: LimitWindow = { name: 'weekly', windowMinutes: 10080, usedPercent: 100, resetsAt: NOW + 3600_000 };
  assert.equal(stateLabel(cooling([used]), NOW), STATE_LABELS.cooling);
  assert.equal(stateLabel(cooling([{ ...used, usedPercent: 40 }]), NOW), SHORT_PAUSE_LABEL);
  assert.equal(stateLabel(cooling([{ ...used, resetsAt: NOW - 1 }]), NOW), SHORT_PAUSE_LABEL, 'a passed reset no longer limits');
  assert.equal(stateLabel(cooling([], { limits: undefined }), NOW), SHORT_PAUSE_LABEL);
  assert.equal(stateLabel(cooling([used], { state: 'ok' }), NOW), STATE_LABELS.ok, 'other states keep their labels');
  assert.equal(stateLabel(cooling([], { state: 'error' }), NOW), 'Error');
});

test('B-051 L5: a Claude Free login says it needs Pro or Max – on its chip and on its PC row, never "Signed in"', () => {
  const free = cooling([], { id: 'acc_claude', provider: 'claude', label: 'Claude Code', state: 'error', plan: 'Free', coolingUntil: undefined, limits: undefined });
  assert.equal(stateLabel(free, NOW), FREE_PLAN_LABEL);
  const row = cliRowView({ provider: 'claude', path: '/home/p/.local/bin/claude', loggedIn: true, method: 'claude.ai', version: '2.1.0' }, [free]);
  assert.equal(row.hint, `${FREE_PLAN_ROW} · 2.1.0`);
  assert.equal(row.action, undefined);
  assert.equal(stateLabel({ ...free, plan: 'pro' }, NOW), 'Error', 'another error keeps its label');
  assert.equal(stateLabel({ ...free, provider: 'codex', plan: 'free' }, NOW), 'Error', 'Codex is not blocked by plan');
  assert.match(cliRowView({ provider: 'claude', path: '/bin/claude', loggedIn: true, method: 'claude.ai' }, [{ ...free, state: 'ok', plan: 'max' }]).hint, /^Signed in · claude\.ai$/);
});
