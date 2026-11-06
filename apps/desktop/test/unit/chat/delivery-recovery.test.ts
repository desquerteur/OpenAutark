// Tests for delivery crash safety (C3, F-44): the lead's provisional durable wake while the
// decision model picks responders (src/runtime/chat/delivery.ts), its withdrawal through
// WakeQueue.cancelKey (src/runtime/wakes/queue.ts), a simulated restart on the same database,
// and the startup sweep that delivers unanswered human/external messages once more
// (src/runtime/chat/delivery-recovery.ts) – but not a message whose turn the person stopped.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionResult, DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DeliveryServiceImpl, PROVISIONAL_WAKE_MS } from '../../../src/runtime/chat/delivery.ts';
import { RECOVER_WINDOW_MS } from '../../../src/runtime/chat/delivery-recovery.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { agent, harness, tick } from './harness.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

/** A decision service whose answers the test hands out one by one (or never). */
function pending() {
  const waiting: Array<(result: DecisionResult) => void> = [];
  const service: DecisionService = { available: () => true, decide: () => new Promise((resolve) => { waiting.push(resolve); }) };
  const answer = async (choice: string) => { waiting.shift()!({ choice, confidence: 0.9, by: 'fake' }); await tick(); };
  return { service, waiting, answer };
}

/** Tom (lead), Mara and Lin in a group with the person. */
function team(decisions?: DecisionService) {
  const h = harness({ decisions });
  for (const [id, name] of [['ag_tom', 'Tom'], ['ag_mara', 'Mara'], ['ag_lin', 'Lin']]) h.org.add(agent(id, name));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin'], createdBy: HUMAN_ID, lead: 'ag_tom' });
  const say = (body: string) => h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body });
  const rows = () => h.wakeRows().map((row) => [row.agent_id, row.due_at]);
  return { ...h, chat, say, rows };
}

test('a decision that never returns leaves a durable provisional lead wake, due in 15 s', () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('Who has the invoice?');
  assert.deepEqual(t.rows(), [['ag_tom', T0 + PROVISIONAL_WAKE_MS]]);
  assert.equal(t.wakeRows()[0].conversation_id, t.chat.id);
  assert.deepEqual(t.wakes.claim('ag_tom', T0 + 1000), [], 'not due before the decision had its time');

  // Simulated restart: a new queue on the same database still holds it, and it fires.
  const restarted = new WakeQueueImpl({ db: t.db, clock: t.clock });
  assert.equal(restarted.reconcile(), 0);
  assert.deepEqual(restarted.list('ag_tom').map((wake) => [wake.conversationId, wake.dueAt]), [[t.chat.id, T0 + PROVISIONAL_WAKE_MS]]);
  const delivery = new DeliveryServiceImpl({ ...t.services, wakes: restarted } as RuntimeServices);
  assert.equal(delivery.recover(), 0, 'the sweep sees the wake and adds nothing');
  assert.equal(restarted.claim('ag_tom', T0 + PROVISIONAL_WAKE_MS).length, 1, 'the lead answers as the fallback');
});

test('resolving with another agent wakes it now and withdraws the lead\'s unclaimed wake', async () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('Who has the invoice?');
  await fake.answer('Mara');
  assert.deepEqual(t.rows(), [['ag_mara', T0]]);
});

test('resolving with the lead keeps exactly one wake for it, due now', async () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('Who has the invoice?');
  await fake.answer('Tom');
  assert.deepEqual(t.rows(), [['ag_tom', T0]]);
  t.say('And the receipts?');
  await fake.answer('Tom and Lin');
  assert.deepEqual(t.rows(), [['ag_tom', T0]], 'B-078 D8: a person\'s line wakes one – the lead, named first, keeps its one wake');
});

test('a provisional wake the lead already claimed keeps running; the picked agent is woken too', async () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('Who has the invoice?');
  t.clock.advance(PROVISIONAL_WAKE_MS);
  const claimed = t.wakes.claim('ag_tom');
  assert.equal(claimed.length, 1);
  await fake.answer('Mara');
  assert.deepEqual(t.rows(), [['ag_mara', T0 + PROVISIONAL_WAKE_MS], ['ag_tom', T0 + PROVISIONAL_WAKE_MS]]);
  assert.ok(t.wakes.list('ag_tom')[0].claimedAt !== undefined, 'the claimed row is not withdrawn');
});

test('two decisions for one chat: the provisional wake stays until the last one returned', async () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('First question');
  t.clock.advance(1000);
  t.say('Second question');
  assert.deepEqual(t.rows(), [['ag_tom', T0 + PROVISIONAL_WAKE_MS]], 'the second provisional wake merges (earliest due kept)');
  await fake.answer('Mara');
  assert.deepEqual(t.rows(), [['ag_mara', T0 + 1000], ['ag_tom', T0 + PROVISIONAL_WAKE_MS]]);
  await fake.answer('Lin');
  assert.deepEqual(t.rows(), [['ag_lin', T0 + 1000], ['ag_mara', T0 + 1000]]);
});

test('cancelKey withdraws only the unclaimed row under its key and reports a change', () => {
  const h = harness();
  const changes: string[] = [];
  h.wakes.onChange((change) => changes.push(change.agentId));
  h.wakes.wake({ agentId: 'ag_tom', reason: 'message', conversationId: 'ch_1', coalesceKey: 'pick:ch_1', dueAt: T0 + 5000 });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'message', conversationId: 'ch_1', coalesceKey: 'chat:ch_1' });
  h.wakes.wake({ agentId: 'ag_mara', reason: 'message', conversationId: 'ch_1', coalesceKey: 'pick:ch_1' });
  changes.length = 0;
  assert.equal(h.wakes.cancelKey('ag_tom', 'pick:ch_1'), true);
  assert.deepEqual(changes, ['ag_tom']);
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.due_at]), [['ag_mara', T0], ['ag_tom', T0]]);
  assert.equal(h.wakes.cancelKey('ag_tom', 'pick:ch_1'), false, 'nothing left under that key');
  h.wakes.claim('ag_mara');
  assert.equal(h.wakes.cancelKey('ag_mara', 'pick:ch_1'), false, 'a claimed wake keeps running');
  assert.equal(h.wakes.list('ag_mara').length, 1);
});

test('sweep: a human message whose wake was lost gets exactly one new wake, without a second notification', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Please send the report' });
  h.db.run('DELETE FROM wakes'); // the crash took the wake
  assert.equal(h.delivery.recover(), 1);
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.conversation_id, row.reason]), [['ag_tom', chat.id, 'message']]);
  assert.equal(h.delivery.recover(), 0, 'a second sweep adds nothing');
  assert.equal(h.wakeRows().length, 1);

  const external = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: external.id, authorId: 'ext:tg:42:Ana (Telegram)', authorKind: 'external', body: 'Hello?' });
  const notified = h.notified.length;
  h.db.run('DELETE FROM wakes');
  assert.equal(h.delivery.recover(), 2, 'both chats lost their wake');
  assert.equal(h.notified.length, notified, 'the person is not notified again');
});

test('sweep: nothing for chats an agent has seen or answered, that still have a wake or are too old; an archived chat counts (C2)', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = () => h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const say = (id: string, body: string) => h.chats.send({ conversationId: id, authorId: HUMAN_ID, body });

  const seen = chat();
  h.chats.markRead(seen.id, 'ag_tom', say(seen.id, 'seen').seq); // the agent's cursor passed it
  const answered = chat();
  say(answered.id, 'question');
  h.chats.send({ conversationId: answered.id, authorId: 'ag_tom', body: 'answer' });
  const archived = chat();
  say(archived.id, 'archived');
  h.chats.archive(archived.id);
  const quiet = chat();
  say(quiet.id, 'real');
  h.chats.send({ conversationId: quiet.id, authorId: 'ag_tom', body: 'thinking', silent: true });
  h.db.run('DELETE FROM wakes');
  const waiting = chat();
  say(waiting.id, 'has a wake');
  assert.equal(h.delivery.recover(), 2, 'the archived chat and the one whose newest visible message (under a silent line) is the person\'s');
  assert.deepEqual(h.wakeRows().map((row) => row.conversation_id).sort(), [archived.id, quiet.id, waiting.id].sort());

  h.db.run('DELETE FROM wakes');
  h.clock.advance(RECOVER_WINDOW_MS + 1);
  assert.equal(h.delivery.recover(), 0, 'older messages are not delivered again');
});

test('sweep: an un-addressed group message goes through the decision path again (provisional wake first)', async () => {
  const fake = pending();
  const t = team(fake.service);
  t.say('Who can help?');
  await fake.answer('Lin');
  t.db.run('DELETE FROM wakes');
  t.clock.advance(60_000);
  assert.equal(t.delivery.recover(), 1);
  assert.deepEqual(t.rows(), [['ag_tom', T0 + 60_000 + PROVISIONAL_WAKE_MS]]);
  await fake.answer('Lin');
  assert.deepEqual(t.rows(), [['ag_lin', T0 + 60_000]]);
});

test('sweep: a turn the person stopped before any text counts as answered; a later message does not', () => {
  const h = harness();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const say = (body: string) => h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body });
  say('Please send the report');
  const other = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: other.id, authorId: HUMAN_ID, body: 'Lost one' });
  h.db.run('DELETE FROM wakes WHERE conversation_id = ?', [other.id]); // the crash took this wake

  // The turn starts, the person presses Stop before any text: the empty bubble is removed, the
  // cursor stays, the run ends 'interrupted' and its wake is done (agents/turn-finish.ts, dispatcher).
  h.clock.advance(1000);
  const claimed = h.wakes.claim('ag_tom');
  assert.equal(claimed.length, 1);
  runs.start({ id: 'run_stopped', agentId: 'ag_tom', conversationId: chat.id, trigger: 'message' });
  const bubble = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_stopped');
  h.chats.removeMessage(bubble.id, 'ag_tom');
  runs.finish('run_stopped', { status: 'interrupted', endedAt: h.clock.now() });
  h.wakes.done(claimed.map((wake) => wake.id));
  assert.equal(h.wakeRows().length, 0);

  assert.equal(h.delivery.recover(), 1, 'only the other chat, whose message no turn took up');
  assert.deepEqual(h.wakeRows().map((row) => row.conversation_id), [other.id]);

  // A message after the stopped turn is new again: the run started before it.
  h.db.run('DELETE FROM wakes');
  h.clock.advance(1000);
  say('Are you there?');
  h.db.run('DELETE FROM wakes');
  assert.equal(h.delivery.recover(), 2);
  assert.deepEqual(h.wakeRows().map((row) => row.conversation_id).sort(), [chat.id, other.id].sort());
});
