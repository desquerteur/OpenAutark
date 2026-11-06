// B-044 accounts.useReset (accounts/resets.ts): one idempotency key per attempt – reused, with the
// attempt's credit, when the account tries again after Codex did not answer (unknown effect), new after any answer – the
// limits read again after an answer (never computed here), Codex plans only, and the outcome checked.
// Also through AccountServiceImpl and its RPC handler with a fake Codex engine.
// Owns: nothing in production. Never starts a real CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resets } from '../../../src/runtime/accounts/resets.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { account } from '../engines/fakes.ts';

function rig(answers: Array<unknown | Error>, accounts: Account[] = [account({ id: 'acc_codex' })]) {
  const sent: Array<{ id: string; key: string; creditId?: string }> = [];
  const checks: string[] = [];
  let keys = 0;
  const resets = new Resets({
    get: (id) => accounts.find((entry) => entry.id === id),
    engine: () => ({
      consumeReset: async (target: Account, key: string, creditId?: string) => {
        sent.push({ id: target.id, key, ...(creditId ? { creditId } : {}) });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
    check: async (id) => { checks.push(id); },
    newKey: () => `key-${++keys}`,
  });
  return { resets, sent, checks };
}

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;

test('resets: an attempt without an answer keeps its key – trying again sends the same key; an answer ends the attempt', async () => {
  const { resets, sent, checks } = rig([new Error('timeout'), 'alreadyRedeemed', 'reset']);
  await assert.rejects(resets.use('acc_codex', 'rc_1'), code('unknown_effect'), 'the effect is unknown: the person may try again');
  assert.deepEqual(checks, [], 'no answer, nothing to read yet');
  assert.equal(await resets.use('acc_codex', 'rc_1'), 'alreadyRedeemed', 'the retry of the same attempt');
  assert.equal(await resets.use('acc_codex', 'rc_1'), 'reset', 'a new attempt after the answer');
  assert.deepEqual(sent.map((entry) => [entry.key, entry.creditId]), [['key-1', 'rc_1'], ['key-1', 'rc_1'], ['key-2', 'rc_1']]);
  assert.deepEqual(checks, ['acc_codex', 'acc_codex'], 'the limits are read again after every answer');
});

test('resets: an open attempt is sent again as it was, whatever credit the retry names; after its answer the next credit is a new attempt', async () => {
  // rc_1 may have been redeemed by the unanswered attempt (the monitor then drops it and the row names rc_2):
  // a new key for rc_2 could redeem a second reset, so the retry repeats rc_1 with its key.
  const { resets, sent } = rig([new Error('timeout'), 'alreadyRedeemed', 'reset']);
  await assert.rejects(resets.use('acc_codex', 'rc_1'), code('unknown_effect'));
  assert.equal(await resets.use('acc_codex', 'rc_2'), 'alreadyRedeemed');
  assert.equal(await resets.use('acc_codex'), 'reset');
  assert.deepEqual(sent, [
    { id: 'acc_codex', key: 'key-1', creditId: 'rc_1' }, { id: 'acc_codex', key: 'key-1', creditId: 'rc_1' }, { id: 'acc_codex', key: 'key-2' },
  ]);
});

test('resets: attempts are per account', async () => {
  const accounts = [account({ id: 'acc_codex' }), account({ id: 'acc_codex_2' })];
  const { resets, sent } = rig([new Error('timeout'), 'reset'], accounts);
  await assert.rejects(resets.use('acc_codex', 'rc_1'), code('unknown_effect'));
  assert.equal(await resets.use('acc_codex_2', 'rc_9'), 'reset');
  assert.deepEqual(sent.map((entry) => [entry.id, entry.key, entry.creditId]), [['acc_codex', 'key-1', 'rc_1'], ['acc_codex_2', 'key-2', 'rc_9']]);
});

test('resets: every provider outcome passes through; an unknown answer is refused after the limits were read', async () => {
  const { resets, checks } = rig(['nothingToReset', 'noCredit', 'surprise']);
  assert.equal(await resets.use('acc_codex'), 'nothingToReset');
  assert.equal(await resets.use('acc_codex'), 'noCredit');
  await assert.rejects(resets.use('acc_codex'), code('internal'));
  assert.equal(checks.length, 3);
});

test('resets: only an enabled Codex plan; a missing account or engine says so', async () => {
  const accounts = [
    account({ id: 'acc_codex' }), account({ id: 'acc_off', enabled: false }), account({ id: 'acc_claude', provider: 'claude' }),
    account({ id: 'acc_key', provider: 'codex', auth: 'api_key' }),
  ];
  const { resets, sent } = rig([], accounts);
  await assert.rejects(resets.use('acc_none'), code('not_found'));
  await assert.rejects(resets.use('acc_claude'), code('bad_request'), 'Claude has no resets');
  await assert.rejects(resets.use('acc_key'), code('bad_request'));
  await assert.rejects(resets.use('acc_off'), code('bad_request'));
  assert.equal(sent.length, 0);
  const missing = new Resets({ get: () => accounts[0], engine: () => ({}), check: async () => {} });
  await assert.rejects(missing.use('acc_codex'), code('unavailable'));
});

test('resets: a removed account forgets its open attempts', async () => {
  const { resets, sent } = rig([new Error('timeout'), 'reset']);
  await assert.rejects(resets.use('acc_codex'), code('unknown_effect'));
  resets.forget('acc_codex');
  await resets.use('acc_codex');
  assert.deepEqual(sent.map((entry) => entry.key), ['key-1', 'key-2']);
});

test('resets: a refusal while an attempt is open keeps it open – its earlier send may have gone through', async () => {
  const unavailable = new WorkforceError('unavailable', 'Codex is not installed or could not start.');
  const { resets, sent } = rig([new Error('timeout'), unavailable, 'alreadyRedeemed']);
  await assert.rejects(resets.use('acc_codex', 'rc_1'), code('unknown_effect'));
  await assert.rejects(resets.use('acc_codex', 'rc_1'), code('unavailable'), 'Codex could not start this time');
  assert.equal(await resets.use('acc_codex', 'rc_2'), 'alreadyRedeemed');
  assert.deepEqual(sent.map((entry) => [entry.key, entry.creditId]), [['key-1', 'rc_1'], ['key-1', 'rc_1'], ['key-1', 'rc_1']]);
});

test('resets: a plain refusal (this Codex cannot redeem) ends the attempt – nothing was redeemed', async () => {
  const { resets, sent, checks } = rig([new WorkforceError('unavailable', 'This Codex version cannot use resets.'), 'reset']);
  await assert.rejects(resets.use('acc_codex'), code('unavailable'));
  assert.equal(await resets.use('acc_codex'), 'reset');
  assert.deepEqual(sent.map((entry) => entry.key), ['key-1', 'key-2']);
  assert.deepEqual(checks, ['acc_codex']);
});
