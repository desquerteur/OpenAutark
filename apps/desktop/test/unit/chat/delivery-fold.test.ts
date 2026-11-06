// Tests for normal messages that reach running work (21.10. 17:09, chat/delivery.ts fold): the
// person's normal message asks the dispatcher to fold it into the addressed agents' running turn
// (dispatcher.steer) – never urgent(); an important one still goes through urgent(); agents' normal
// messages, messages from a bridged messenger and the provisional lead wake of a responder decision
// are never folded; an unaddressed group agent is not asked.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionResult, DecisionService } from '../../../src/runtime/contracts.ts';
import { agent, harness, tick } from './harness.ts';

function withFold(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const folded: Array<{ agentId: string; conversationId: string }> = [];
  Object.assign(h.services.dispatcher, { steer: async (agentId: string, conversationId: string) => { folded.push({ agentId, conversationId }); return true; } });
  for (const [id, name] of [['ag_tom', 'Tom'], ['ag_mara', 'Mara']]) h.org.add(agent(id, name));
  return { ...h, folded };
}

test("1:1: the person's normal message is folded into the agent's running turn; an important one is urgent, not folded", () => {
  const h = withFold();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'also add the FAQ' });
  assert.deepEqual(h.folded, [{ agentId: 'ag_tom', conversationId: chat.id }]);
  assert.deepEqual(h.urgent, []);
  assert.equal(h.wakeRows().length, 1, 'the wake stays: without a running turn it starts the next one');
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Stop the upload!', priority: 'important' });
  assert.equal(h.folded.length, 1, 'important goes through urgent()');
  assert.deepEqual(h.urgent, [{ agentId: 'ag_tom', conversationId: chat.id }]);
});

test("group: only the addressed agent is folded; agents' normal messages and the provisional lead wake never are", async () => {
  const decisions: DecisionService = { available: () => true, decide: async (): Promise<DecisionResult> => ({ choice: 'Mara', confidence: 0.9, by: 'fake' }) };
  const h = withFold({ decisions });
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], createdBy: HUMAN_ID, lead: 'ag_tom' });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: '@Mara the numbers please', mentions: ['ag_mara'] });
  assert.deepEqual(h.folded.map((item) => item.agentId), ['ag_mara']);
  h.chats.send({ conversationId: chat.id, authorId: 'ag_tom', authorKind: 'agent', body: '@Mara FYI', mentions: ['ag_mara'] });
  assert.deepEqual(h.folded.map((item) => item.agentId), ['ag_mara'], "an agent's normal message is not folded");
  h.folded.length = 0;
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'who has time?' });
  assert.equal(h.folded.length, 0, 'the provisional lead wake is not folded');
  await tick();
  await tick();
  assert.deepEqual(h.folded.map((item) => item.agentId), ['ag_mara'], 'the picked responder is');
});
