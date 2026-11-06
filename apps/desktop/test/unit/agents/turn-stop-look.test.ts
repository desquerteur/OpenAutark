// A stop while the turn waits for the subconscious's look (agents/turn-prepare.ts subconsciousTrace): the emergency stop ends
// the turn now, not when the look's wait runs out, and what the look still hands over waits for the thread's next turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import type { SubconsciousTrace } from '../../../src/shared/model/subconscious.ts';
import { setup } from './fixture.ts';

const TRACE: SubconsciousTrace = { calls: [{ tool: 'agent.tell', args: {}, output: 'Eine Notiz.' }] };

function waiting() {
  const h = setup();
  let finish!: (trace: SubconsciousTrace | undefined) => void;
  let fail!: (error: Error) => void;
  const asked: unknown[] = [];
  const back: Array<[string, string, SubconsciousTrace]> = [];
  h.services.subconscious.beforeTurn = (input) => { asked.push(input); return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); };
  h.services.subconscious.putBack = (agentId, thread, trace) => { back.push([agentId, thread, trace]); };
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Wie heißt unser Steuerberater?' });
  return { h, asked, back, finish: (trace?: SubconsciousTrace) => finish(trace), fail: (error: Error) => fail(error) };
}

test('a stop ends the wait for the look at once; the trace it hands over later goes back for the next turn', async () => {
  const { h, back, finish } = waiting();
  const stop = new AbortController();
  const planned = planTurn(h.services, h.request({ signal: stop.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  const plan = await planned; // the look has not ended: this would hang without the stop
  assert.ok(plan);
  assert.equal(plan.trace, undefined);
  assert.deepEqual(back, []);
  finish(TRACE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(back, [[plan.agent.id, plan.thread, TRACE]]);
});

test('a look that fails or finds nothing after the stop leaves nothing behind', async () => {
  for (const end of ['nothing', 'fails'] as const) {
    const { h, back, finish, fail } = waiting();
    const stop = new AbortController();
    const planned = planTurn(h.services, h.request({ signal: stop.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    await planned;
    if (end === 'nothing') finish(); else fail(new Error('boom'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(back, [], end);
  }
});

test('stopped before it asked: no look at all, the kept trace stays kept', async () => {
  const { h, asked } = waiting();
  const stop = new AbortController();
  stop.abort();
  const plan = await planTurn(h.services, h.request({ signal: stop.signal }));
  assert.ok(plan);
  assert.equal(plan.trace, undefined);
  assert.deepEqual(asked, []);
});

test('without a stop the turn takes what the look hands over', async () => {
  const { h, back, finish } = waiting();
  const planned = planTurn(h.services, h.request());
  await new Promise((resolve) => setImmediate(resolve));
  finish(TRACE);
  assert.deepEqual((await planned)!.trace, TRACE);
  assert.deepEqual(back, []);
});
