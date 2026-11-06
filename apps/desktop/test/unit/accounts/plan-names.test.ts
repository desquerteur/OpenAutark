// B-078 (D17): the plans' short names in the rail (shared/model/plan-names.ts, filled into UsageSummary.name by
// accounts/monitor.ts): a label of the person's own wins; else the e-mail's local part; plans whose local parts share the
// first word before the dot show the part after it; without an e-mail the label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDefaultLabel, planNames } from '../../../src/shared/model/plan-names.ts';
import { usageSummaries } from '../../../src/runtime/accounts/monitor.ts';
import type { Account, ProviderId } from '../../../src/shared/model/providers.ts';

const DEFAULTS = { codex: 'Codex', claude: 'Claude Code' };

test('default labels: "<default>" and "<default> n" are the app\'s, anything else is the person\'s', () => {
  assert.equal(isDefaultLabel('Codex', 'Codex'), true);
  assert.equal(isDefaultLabel('Claude Code 2', 'Claude Code'), true);
  assert.equal(isDefaultLabel('', 'Codex'), true);
  assert.equal(isDefaultLabel('Codex work', 'Codex'), false);
  assert.equal(isDefaultLabel('Firma', 'Codex'), false);
});

test('the e-mail\'s local part; a shared first word gives the part after the dot; a custom label wins; no e-mail: the label', () => {
  const names = planNames([
    { id: 'a', provider: 'codex', label: 'Codex', email: 'alex.work@example.com' },
    { id: 'b', provider: 'codex', label: 'Codex 2', email: 'alex.private@example.org' },
    { id: 'c', provider: 'claude', label: 'Claude Code', email: 'office@example.com' },
    { id: 'd', provider: 'claude', label: 'Lab plan', email: 'alex.lab@example.com' },
    { id: 'e', provider: 'claude', label: 'Claude Code 3' },
    { id: 'f', provider: 'codex', label: 'Codex 3', email: 'alex@example.net' },
  ], DEFAULTS);
  assert.equal(names.get('a'), 'work');
  assert.equal(names.get('b'), 'private');
  assert.equal(names.get('c'), 'office');
  assert.equal(names.get('d'), 'Lab plan', 'the person\'s own label wins (and does not count for the shared first word)');
  assert.equal(names.get('e'), 'Claude Code 3');
  assert.equal(names.get('f'), 'alex', 'no dot: the whole local part');
  const alone = planNames([{ id: 'x', provider: 'codex', label: 'Codex', email: 'alex.work@example.com' }], DEFAULTS);
  assert.equal(alone.get('x'), 'alex.work', 'no other plan shares the first word: the whole local part');
});

test('usageSummaries carries the name; the domain never shows', () => {
  const plan = (id: string, provider: ProviderId, patch: Partial<Account>): Account => ({ id, provider, label: provider === 'codex' ? 'Codex' : 'Claude Code', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0, ...patch });
  const list = usageSummaries([plan('acc_a', 'codex', { email: 'max.one@example.com' }), plan('acc_b', 'claude', { email: 'max.two@example.org' })], Date.UTC(2026, 10, 6));
  assert.deepEqual(list.map((entry) => entry.name), ['one', 'two']);
  assert.ok(list.every((entry) => !entry.name?.includes('@')));
});
