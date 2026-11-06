// Tests for the dispatcher's idle moment (src/runtime/agents/dispatcher.ts, B-050 K4): when an agent's
// turn ended and nothing else is due for it, a person's quiet lines it has not seen get one 'review'
// turn per chat (chat/quiet-pickup.ts) – after the work that was due, never after the person's Stop of
// that turn, and a review turn that leaves the cursor where it was is not repeated; merged with a normal
// line of the person it runs as that message turn, without the quiet note. Round 3: an agent with nothing
// to do picks a quiet line up QUIET_DELAY_MS after it arrived (a burst is one turn) or after a start, never
// at once; a waiting pickup whose lines another turn read is withdrawn or settled without a turn.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { QUIET_DELAY_MS, QUIET_NOTE } from '../../../src/runtime/chat/quiet-pickup.ts';
import { flush, openWakes, setup } from './fakes.ts';

function scene() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  const work = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const side = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  return { ...h, work, side };
}

test('a quiet line that arrived while the agent worked is picked up once nothing else is due – once', async () => {
  const h = scene();
  h.dispatcher.start();
  h.chats.send({ conversationId: h.work.id, body: 'Please draft the offer', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1);
  h.chats.send({ conversationId: h.side.id, body: 'FYI: the client prefers blue', authorId: 'human', silent: true });
  const other = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: other.id, body: 'And the invoice?', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1, 'the quiet line woke nobody');
  h.executor.last().finish();
  await flush();
  assert.deepEqual([h.executor.last().request.conversationId, h.executor.last().request.reason], [other.id, 'message'], 'the due work first');
  h.executor.last().finish();
  await flush();
  const review = h.executor.last().request;
  assert.deepEqual([review.agentId, review.conversationId, review.reason], ['ag_tom', h.side.id, 'review']);
  assert.deepEqual(review.notes.map((note) => note.text), [QUIET_NOTE]);
  h.executor.last().finish(); // the fake turn leaves the cursor where it was – like a failed review turn
  await flush();
  assert.equal(h.executor.calls.length, 3, 'no second pickup of the same lines');
});

test('a pending quiet review merged with a normal line of the person runs as a message turn without the quiet note', async () => {
  const h = scene();
  const third = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: h.work.id, body: 'Please draft the offer', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: h.side.id, body: 'fyi a', authorId: 'human', silent: true });
  h.clock.advance(1000);
  h.chats.send({ conversationId: third.id, body: 'fyi b', authorId: 'human', silent: true });
  h.executor.last().finish();
  await flush();
  const first = h.executor.last().request;
  assert.equal(first.reason, 'review');
  const other = first.conversationId === h.side.id ? third : h.side; // its review wake still waits
  h.chats.send({ conversationId: other.id, body: 'Quick question: what is the price?', authorId: 'human' });
  await flush();
  h.executor.last().finish();
  await flush();
  const next = h.executor.last().request;
  assert.deepEqual([next.conversationId, next.reason], [other.id, 'message']);
  assert.ok(!next.notes.some((note) => note.text === QUIET_NOTE), 'the question is answered like any other – no "end with [[internal]]"');
  h.executor.last().finish();
  await flush();
  await h.dispatcher.stop();
});

test("round 3: after a start an open quiet line is picked up a little later, never at once; never after the person's Stop", async () => {
  const h = scene();
  h.chats.send({ conversationId: h.side.id, body: 'Quiet note from yesterday', authorId: 'human', silent: true });
  h.dispatcher.start();
  await flush();
  assert.equal(h.executor.calls.length, 0, 'nothing runs at once at startup');
  assert.deepEqual(openWakes(h.db).map((wake) => [wake.reason, wake.conversation_id, wake.due_at - h.clock.now()]), [['review', h.side.id, QUIET_DELAY_MS]]);
  h.chats.send({ conversationId: h.work.id, body: 'Go', authorId: 'human' });
  await flush();
  await h.dispatcher.interrupt('ag_tom');
  await flush();
  assert.equal(h.executor.calls.length, 1, "the end of a turn the person stopped is no idle moment");
  h.chats.send({ conversationId: h.work.id, body: 'Go on', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 2);
  h.executor.last().finish();
  await flush();
  assert.deepEqual([h.executor.last().request.conversationId, h.executor.last().request.reason], [h.side.id, 'review'], 'the next finished turn makes the waiting pickup due now');
});

test('round 3: an agent with nothing to do picks a quiet line up a little later – a burst of them is one review turn', async () => {
  const h = scene();
  h.dispatcher.start();
  await flush();
  h.chats.send({ conversationId: h.side.id, body: 'FYI: the client prefers blue', authorId: 'human', silent: true });
  await flush();
  assert.equal(h.executor.calls.length, 0, 'not at once – nobody is interrupted or woken now');
  h.clock.advance(60_000);
  h.chats.send({ conversationId: h.side.id, body: 'and the logo bigger', authorId: 'human', silent: true });
  h.scheduler.tick();
  await flush();
  assert.equal(h.executor.calls.length, 0);
  h.clock.advance(QUIET_DELAY_MS - 60_000);
  h.scheduler.tick();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'one review turn for the burst, without any unrelated work before it');
  const review = h.executor.last().request;
  assert.deepEqual([review.agentId, review.conversationId, review.reason], ['ag_tom', h.side.id, 'review']);
  assert.deepEqual(review.notes.map((note) => note.text), [QUIET_NOTE]);
  h.executor.last().finish();
  await flush();
  h.clock.advance(QUIET_DELAY_MS);
  h.scheduler.tick();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'the same lines are not picked up again');
  // An agent's own quiet line (a closing note) is no pickup.
  h.chats.send({ conversationId: h.side.id, body: 'Checked it', authorId: 'ag_tom', authorKind: 'agent', silent: true });
  await flush();
  assert.deepEqual(openWakes(h.db), []);
});

test('round 3: a waiting pickup whose lines a turn in that chat read is withdrawn – or, due already, settled without a turn', async () => {
  const h = scene();
  const read = () => h.db.run(`UPDATE members SET read_seq = (SELECT last_seq FROM conversations WHERE id = ?) WHERE conversation_id = ? AND member_id = 'ag_tom'`, [h.side.id, h.side.id]);
  h.dispatcher.start();
  h.chats.send({ conversationId: h.side.id, body: 'For later: the client prefers blue', authorId: 'human', silent: true });
  await flush();
  h.chats.send({ conversationId: h.side.id, body: 'What did I say about the colour?', authorId: 'human' });
  await flush();
  assert.deepEqual([h.executor.calls.length, h.executor.last().request.reason], [1, 'message']);
  read(); // that turn read both lines
  h.executor.last().finish();
  await flush();
  assert.deepEqual(openWakes(h.db), [], 'the waiting pickup was withdrawn');

  h.chats.send({ conversationId: h.side.id, body: 'And the logo bigger', authorId: 'human', silent: true });
  await flush();
  h.chats.send({ conversationId: h.side.id, body: 'Draft the mail please', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 2);
  h.clock.advance(QUIET_DELAY_MS); // the pickup falls due while the turn runs
  h.scheduler.tick();
  await flush();
  read();
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2, 'no review turn for lines already read');
  assert.deepEqual(openWakes(h.db), []);
});
