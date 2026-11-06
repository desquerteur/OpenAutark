// B-044 Codex banked resets on the engine (engines/codex/engine.ts) against a scripted app server in
// the shape of codex-cli 0.162's generated schema: account/rateLimits/read carries
// rateLimitResetCredits (count + available credits), account/rateLimits/updated pushes do not (the
// stored count stays), and account/rateLimitResetCredit/consume takes {idempotencyKey, creditId?}
// and answers {outcome}; B-044 integration: a background account check asks without the credit details
// (excludeResetCreditDetails), a check with `details` asks for them, and a Codex that refuses the parameter is
// asked again without it (and from then on) – a read that got no answer (timeout) is no refusal.
// Owns: nothing in production. Never starts a real Codex.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { readRateLimits } from '../../../src/runtime/engines/codex/limits-read.ts';
import { RpcError } from '../../../src/runtime/engines/codex/rpc.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { AccountLimits } from '../../../src/shared/model/providers.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, tick, type FakeChild } from './fakes.ts';

const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;
const CREDITS = {
  availableCount: 2,
  credits: [
    { id: 'rc_late', title: 'Reset', grantedAt: SEC - 100, expiresAt: SEC + 20 * 86_400, resetType: 'codexRateLimits', status: 'available' },
    { id: 'rc_soon', grantedAt: SEC - 200, expiresAt: SEC + 86_400, resetType: 'codexRateLimits', status: 'available' },
    { id: 'rc_used', grantedAt: SEC - 300, resetType: 'codexRateLimits', status: 'redeemed' },
  ],
};

function appServer() {
  const state: { consumed: any[]; reads: any[]; outcome: string; noMethod?: boolean; refuseExclude?: boolean; child?: FakeChild } = { consumed: [], reads: [], outcome: 'reset' };
  const { spawn } = fakeSpawn(({ child }) => {
    state.child = child;
    child.onLine = (msg) => {
      if (msg.id === undefined || !msg.method) return;
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'account/read') child.send({ id: msg.id, result: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true } });
      else if (msg.method === 'account/rateLimits/read' && state.refuseExclude && msg.params?.excludeResetCreditDetails !== undefined) {
        state.reads.push(msg.params);
        child.send({ id: msg.id, error: { code: -32602, message: 'unknown field `excludeResetCreditDetails`' } });
      } else if (msg.method === 'account/rateLimits/read') {
        state.reads.push(msg.params);
        child.send({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: SEC + 3600 }, secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: SEC + 86_400 } }, rateLimitResetCredits: CREDITS } });
      } else if (msg.method === 'account/rateLimitResetCredit/consume' && !state.noMethod) {
        state.consumed.push(msg.params);
        child.send({ id: msg.id, result: { outcome: state.outcome } });
      } else child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return { spawn, state };
}

test('codex resets: the account check reads the count and the available credits, soonest expiry first', async () => {
  const fake = appServer();
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW });
  const check = await engine.checkAccount(account());
  assert.deepEqual(check.limits?.resets, {
    available: 2,
    credits: [{ id: 'rc_soon', expiresAt: (SEC + 86_400) * 1000 }, { id: 'rc_late', title: 'Reset', expiresAt: (SEC + 20 * 86_400) * 1000 }],
  });
  await engine.dispose();
});

test('codex limits read: background checks skip the reset details, a details check asks for them; an older Codex is asked plainly', async () => {
  const fake = appServer();
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW });
  await engine.checkAccount(account());
  await engine.checkAccount(account(), { details: true });
  assert.deepEqual(fake.state.reads, [{ excludeResetCreditDetails: true }, {}]);
  await engine.dispose();

  const old = appServer();
  old.state.refuseExclude = true;
  const legacy = new CodexEngine({ supervisor: testSupervisor(old.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW });
  const check = await legacy.checkAccount(account());
  assert.equal(check.limits?.resets?.available, 2, 'the plain read answered');
  await legacy.checkAccount(account());
  assert.deepEqual(old.state.reads, [{ excludeResetCreditDetails: true }, {}, {}], 'refused once, then asked plainly');
  await legacy.dispose();
});

test('codex resets: consumeReset sends the attempt key and the credit, and returns the outcome as sent', async () => {
  const fake = appServer();
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW });
  assert.equal(await engine.consumeReset(account(), 'key-1', 'rc_soon'), 'reset');
  fake.state.outcome = 'alreadyRedeemed';
  assert.equal(await engine.consumeReset(account(), 'key-1'), 'alreadyRedeemed');
  assert.deepEqual(fake.state.consumed, [{ idempotencyKey: 'key-1', creditId: 'rc_soon' }, { idempotencyKey: 'key-1' }], 'no creditId when none is chosen: the provider picks the next one');
  await engine.dispose();
});

test('codex resets: a sparse account/rateLimits/updated push has no resets, so the stored count stays', async () => {
  const fake = appServer();
  const pushed: AccountLimits[] = [];
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW, onLimits: (_id, limits) => pushed.push(limits) });
  await engine.checkAccount(account());
  fake.state.child!.send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: SEC + 18_000 } } } });
  for (let i = 0; i < 20 && !pushed.length; i++) await tick();
  assert.equal(pushed.length, 1);
  assert.equal(Object.hasOwn(pushed[0], 'resets'), false, 'the push says nothing about resets (mergeLimits keeps the stored ones)');
  await engine.dispose();
});

test('codex resets: a Codex without the method refuses plainly (nothing was redeemed)', async () => {
  const fake = appServer();
  fake.state.noMethod = true;
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', now: () => NOW });
  await assert.rejects(engine.consumeReset(account(), 'key-1'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /Update Codex/.test(error.message));
  await engine.dispose();
});

test('codex limits read: only an error answer counts as a refusal of excludeResetCreditDetails, never a timeout', async () => {
  const sent: unknown[] = [];
  const rpc = (fail: Error) => ({ request: async (_method: string, params: unknown) => { sent.push(params); if (sent.length === 1) throw fail; return { ok: true }; } }) as never;
  const plain = { value: false };
  await assert.rejects(readRateLimits(rpc(new RpcError(-32000, 'codex did not answer account/rateLimits/read')), false, plain), RpcError);
  assert.deepEqual([sent, plain.value], [[{ excludeResetCreditDetails: true }], false], 'no second read, the parameter stays');
  sent.length = 0;
  assert.deepEqual(await readRateLimits(rpc(new RpcError(-32600, 'Invalid request')), false, plain), { ok: true });
  assert.deepEqual([sent, plain.value], [[{ excludeResetCreditDetails: true }, {}], true]);
});
