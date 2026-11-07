// AF-012: runs.cancel {runId} – the RPC the agent view's Stop per sub-agent uses (runtime/rpc/handlers/org.ts). A split's
// running run is the person's Stop of that one split (splits.stop {splitId} as the person – the split service ends it
// stopped and never retries it), not a dispatcher interrupt; a main-lane turn still stops through the dispatcher by its
// id; a turn the dispatcher already runs but has not journaled yet (agent.activity names it first) stops by its id too;
// an unknown id is still not_found.
// Owns: these handler checks. Never: the split lifecycle or the dispatcher (fakes here; the real path:
// test/e2e/runtime-stop.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { SplitService } from '../../../src/runtime/contracts.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const cancelled: string[] = [];
  const running = new Set<string>();
  Object.assign(f.dispatcher, { cancelRun: async (runId: string) => { if (!running.has(runId)) return false; cancelled.push(runId); return true; } });
  const stops: Array<{ q: unknown; by: string }> = [];
  f.services.splits = { stop: (q: unknown, by: string) => { stops.push({ q, by }); return 1; } } as unknown as SplitService;
  return { f, chat, cancelled, running, stops, owner: new TestClient(f.server, OWNER) };
}

test('runs.cancel: a split\'s run stops as the person\'s Stop of that split; a main turn through the dispatcher by its id', async (t) => {
  const { f, chat, cancelled, running, stops, owner } = setup();
  t.after(f.cleanup);
  const part = f.services.runs.start({ id: 'rn_part', agentId: 'ag_ava', trigger: 'split', splitId: 'sp_1' });
  running.add(part.id);
  assert.deepEqual(await owner.call('runs.cancel', { runId: part.id }), { ok: true });
  assert.deepEqual(stops, [{ q: { splitId: 'sp_1' }, by: HUMAN_ID }]);
  assert.deepEqual(cancelled, [], 'no dispatcher cut for a split – its service ends it');
  assert.deepEqual(f.dispatcher.interrupts, []);

  const turn = f.services.runs.start({ id: 'rn_main', agentId: 'ag_ava', conversationId: chat.id, trigger: 'message' });
  running.add(turn.id);
  await owner.call('runs.cancel', { runId: turn.id });
  assert.deepEqual(cancelled, ['rn_main']);
  assert.equal(stops.length, 1);
});

test('runs.cancel: a turn the dispatcher runs before it is journaled stops by its id; an unknown id is not_found', async (t) => {
  const { f, cancelled, running, owner } = setup();
  t.after(f.cleanup);
  running.add('rn_early');
  assert.deepEqual(await owner.call('runs.cancel', { runId: 'rn_early' }), { ok: true });
  assert.deepEqual(cancelled, ['rn_early']);
  assert.equal((await owner.request('runs.cancel', { runId: 'rn_nowhere' })).error?.code, 'not_found');
});
