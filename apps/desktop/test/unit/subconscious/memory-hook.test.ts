// The subconscious's hook points in a turn: agents/turn-finish.ts hands every done turn to subconscious.afterTurn once (its wake
// check decides); a failed turn or a missing hook hands nothing and the turn still finishes. agents/turn-prepare.ts puts what
// subconscious.beforeTurn returns into the plan and from there into the engine's input – no tips and no hints in any prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurn, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import type { Subconscious } from '../../../src/runtime/contracts.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { SubconsciousTrace } from '../../../src/shared/model/subconscious.ts';
import { setup } from '../agents/fixture.ts';
import { noteTurnRead } from '../../../src/runtime/chat/turn-reads.ts';

type Noted = Parameters<NonNullable<Subconscious['afterTurn']>>[0];

async function turn(result: EngineTurnResult, hook = true) {
  const h = setup();
  const noted: Noted[] = [];
  if (hook) h.services.subconscious.afterTurn = (input) => { noted.push(input); };
  const message = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Unser Steuerberater ist Jonas Weber.' });
  const request = h.request();
  const plan = (await planTurn(h.services, request))!;
  const outcome = finishTurn(h.services, plan, { ...h.routed(), lastSeq: message.seq }, request, h.attempt(result), undefined);
  return { h, noted, message, plan, outcome };
}

test('a done turn hands the exchange to the subconscious once, with what the wake check needs', async () => {
  const { h, noted, message, plan, outcome } = await turn({ text: 'Notiert: Jonas Weber.', stop: 'done' });
  assert.equal(outcome.status, 'done');
  assert.equal(noted.length, 1);
  const { agent, conversationId, thread, fromSeq, toSeq, reply, taskEnded, switchPlanned } = noted[0];
  assert.deepEqual({ agent, conversationId, thread, fromSeq, toSeq, reply, taskEnded, switchPlanned },
    { agent: plan.agent, conversationId: h.chat.id, thread: h.chat.id, fromSeq: plan.memberCursor, toSeq: message.seq, reply: 'Notiert: Jonas Weber.', taskEnded: false, switchPlanned: false });
});

test('a failed turn hands nothing; without the hook the turn still finishes', async () => {
  assert.deepEqual((await turn({ text: '', stop: 'error', error: { code: 'internal', message: 'boom' } })).noted, []);
  assert.equal((await turn({ text: 'Notiert.', stop: 'done' }, false)).outcome.status, 'done');
});

test('what the turn read of its own chat with chat.read is part of the exchange (the cursor moves that far too)', async () => {
  const h = setup();
  const noted: Noted[] = [];
  h.services.subconscious.afterTurn = (input) => { noted.push(input); };
  const first = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Unser Steuerberater ist Jonas Weber.' });
  const request = h.request();
  const plan = (await planTurn(h.services, request))!;
  const more = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Die Kanzlei sitzt in Bonn.' });
  noteTurnRead(h.services, request.runId, h.chat.id, more.seq); // chat.read showed the new line during the turn
  finishTurn(h.services, plan, { ...h.routed(), lastSeq: first.seq }, request, h.attempt({ text: 'Jonas Weber in Bonn, notiert.', stop: 'done' }), undefined);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].toSeq, more.seq);
});

test('before a turn: the subconscious hands over what it kept for the thread, its trace goes into the plan; nothing else changes', async () => {
  const h = setup();
  const trace: SubconsciousTrace = { calls: [{ tool: 'agent.tell', args: {}, output: 'Eine Notiz.' }] };
  const asked: Array<Parameters<NonNullable<Subconscious['beforeTurn']>>[0]> = [];
  h.services.subconscious.beforeTurn = async (input) => { asked.push(input); return trace; };
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Wie heißt unser Steuerberater?' });
  const plan = (await planTurn(h.services, h.request()))!;
  assert.equal(asked[0].thread, h.chat.id);
  assert.equal(asked[0].said, 'Wie heißt unser Steuerberater?', 'what the person wrote: the run before the turn decides on it');
  assert.deepEqual(plan.trace, trace);
});

test('nothing to show: no trace in the plan; a failing hook never stops the turn', async () => {
  const h = setup();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Wie heißt unser Steuerberater?' });
  h.services.subconscious.beforeTurn = async () => undefined;
  assert.equal((await planTurn(h.services, h.request()))!.trace, undefined);
  h.services.subconscious.beforeTurn = async () => { throw new Error('boom'); };
  const plan = await planTurn(h.services, h.request());
  assert.ok(plan);
  assert.equal(plan.trace, undefined);
});

test('the routed turn carries the plan\'s trace to the engine', async () => {
  assert.equal(typeof buildTurn, 'function');
  const h = setup();
  const trace: SubconsciousTrace = { calls: [{ tool: 'agent.tell', args: {}, output: 'Eine Notiz.' }] };
  h.services.subconscious.beforeTurn = async () => trace;
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Wie heißt unser Steuerberater?' });
  const request = h.request();
  const plan = (await planTurn(h.services, request))!;
  const built = await buildTurn(h.services, plan, request, h.routed().route, []);
  assert.deepEqual(built.trace, trace);
});
