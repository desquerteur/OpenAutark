// B-048 E4.2 – model.set now (Dispatcher.continueNow): the agent's own turn ends at its next tool
// boundary the urgent way (a call in flight is never cut, the wakes are kept) and its chat runs again at
// once with the note; another run id or a cut turn is refused; a turn that ends before the boundary
// wakes nothing. Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, openWakes, setup } from './fakes.ts';

const NOTE = 'I switched to Claude Opus 5.5 · high (model.set now) – I continue my work where I stopped; what I did so far is kept.';

async function working() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'Refactor the parser, please.', authorId: 'human' });
  await flush();
  const first = h.executor.last();
  assert.equal(first.request.conversationId, chat.id);
  return { h, chat, first };
}

test('continueNow: cut at the next tool boundary, then the same chat runs again at once with the note', async () => {
  const { h, chat, first } = await working();
  const ctx = { agentId: 'ag_tom', runId: first.request.runId, callId: 'call_model_set' };
  h.dispatcher.setCall(ctx, true); // model.set itself is in flight
  assert.equal(h.dispatcher.continueNow('ag_tom', first.request.runId, NOTE), true);
  await flush();
  assert.equal(first.request.signal.aborted, false, 'never inside the running call');
  h.dispatcher.setCall(ctx, false); // the call returned: the boundary
  await flush();
  assert.equal(first.request.control.stopKind, 'urgent', 'the urgent interrupt path');
  const next = h.executor.last();
  assert.notEqual(next, first);
  assert.equal(next.request.conversationId, chat.id);
  assert.equal(next.request.reason, 'message', 'the wakes of the cut turn run again');
  assert.deepEqual(next.request.notes.map((note) => note.text), [NOTE]);
  next.finish();
  await flush();
  assert.equal(openWakes(h.db).length, 0);
  assert.equal(h.executor.calls.length, 2, 'one continuation, no more');
});

test('continueNow: another run or an ended turn is refused; a turn that ends before the boundary wakes nothing', async () => {
  const { h, first } = await working();
  assert.equal(h.dispatcher.continueNow('ag_tom', 'run_other', NOTE), false);
  assert.equal(h.dispatcher.continueNow('ag_nobody', first.request.runId, NOTE), false);
  const ctx = { agentId: 'ag_tom', runId: first.request.runId, callId: 'call_1' };
  h.dispatcher.setCall(ctx, true);
  assert.equal(h.dispatcher.continueNow('ag_tom', first.request.runId, NOTE), true);
  first.finish(); // the turn ended on its own before the call reported its end
  await flush();
  h.dispatcher.setCall(ctx, false);
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no continuation for a finished turn');
  assert.equal(openWakes(h.db).length, 0);
  assert.equal(h.dispatcher.continueNow('ag_tom', first.request.runId, NOTE), false, 'not running any more');
});
