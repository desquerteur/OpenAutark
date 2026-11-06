// Unit (INT-8): the dispatcher names the kind of every abort in the signal's reason
// (details.stopKind), and the fake engine reads it: after the person's Stop the stopped input
// stays history, while a turn cut off by urgent work or a shutdown runs its input again.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, setup } from '../dispatcher/fakes.ts';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineEvent, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const kindOf = (signal: AbortSignal) => (signal.reason as WorkforceError | undefined)?.details?.stopKind;

test('every abort reason names its kind: Stop is the human, an important message urgent, stop() a shutdown', async () => {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'long job', authorId: 'human' });
  await flush();
  const stopped = h.executor.last();
  await h.dispatcher.interrupt('ag_tom', a.id);
  assert.equal(kindOf(stopped.request.signal), 'human');

  h.chats.send({ conversationId: b.id, body: 'research', authorId: 'human' });
  await flush();
  const overtaken = h.executor.last();
  h.chats.send({ conversationId: a.id, body: 'Call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(kindOf(overtaken.request.signal), 'urgent');
  assert.equal((overtaken.request.signal.reason as WorkforceError).code, 'cancelled');

  const urgent = h.executor.last();
  await h.dispatcher.stop();
  assert.equal(kindOf(urgent.request.signal), 'shutdown');
});

/** A fake turn in [[hang:…]] cut off with `reason`; then the same input once more. */
async function cutOffThenAgain(reason: unknown) {
  const engine = new FakeEngine();
  const started: string[] = [];
  const text = '[09:00] Alex: Export it [[hang:bash {"command":"export"}]] [[tool:tasks.complete {"taskId":"tk_1"}]]';
  const run = (signal: AbortSignal) => engine.run({
    runId: 'run_1', agentId: 'ag_tom', input: [{ type: 'text', text }], system: { stable: '', volatile: '' }, session: { ref: 'chat_a', generation: 1 },
    signal, onEvent: (event: EngineEvent) => { if (event.type === 'tool_start') started.push(event.name); },
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as EngineTurnInput);
  const first = new AbortController();
  const hanging = run(first.signal);
  await new Promise((resolve) => setImmediate(resolve));
  first.abort(reason);
  assert.equal((await hanging).stop, 'interrupted');
  const second = new AbortController();
  const again = run(second.signal);
  await new Promise((resolve) => setImmediate(resolve));
  second.abort();
  return { result: await again, started };
}

test('fake engine: work cut off by urgent work or a shutdown runs again; the person\'s Stop stays stopped', async () => {
  for (const stopKind of ['urgent', 'shutdown']) {
    const { result, started } = await cutOffThenAgain(new WorkforceError('cancelled', 'Interrupted.', { details: { stopKind } }));
    assert.deepEqual([result.stop, started], ['interrupted', ['bash', 'bash']], `${stopKind}: the export starts again`);
  }
  for (const reason of [new WorkforceError('cancelled', 'The turn was stopped.', { details: { stopKind: 'human' } }), undefined]) {
    const { result, started } = await cutOffThenAgain(reason);
    assert.deepEqual([result.stop, result.text, started], ['done', 'Echo: (no new input)', ['bash']], 'a Stop (or an abort without a kind) is not repeated');
  }
});
