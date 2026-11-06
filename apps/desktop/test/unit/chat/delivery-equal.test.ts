// Tests for B-050 round 4, equal waking in groups (src/runtime/chat/delivery-route.ts, chat/responders.ts): the owner's
// "kein Unterschied, ob der CEO da dabei ist oder nicht" – an agent's normal line in a room of three or more that
// @mentions nobody goes through the same responder pick as a person's (the author never an option, reply modes apply),
// the pick may answer that nobody needs to reply for every author, and the one asymmetry is the fallback without a
// decision model (or when it is unsure): a person's line wakes the lead, an agent's nobody. An agent's important
// chat.send line keeps T10's lead; a run's important answer goes through the pick, never urgent; at most two are woken.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionRequest, DecisionResult, DecisionService } from '../../../src/runtime/contracts.ts';
import { setReplyMode } from '../../../src/runtime/chat/reply-modes.ts';
import { agent, harness, tick } from './harness.ts';

/** chat/responders.ts NOBODY, spelled out so these tests also run against the code before round 4. */
const NOBODY = 'Nobody needs to reply';

/** A decision model that answers from `answers` in order (the last one repeats); its requests. */
function decisions(answers: Array<[string | undefined, number] | Error>, available = true) {
  const calls: DecisionRequest[] = [];
  const service: DecisionService = {
    available: () => available,
    decide: async (request): Promise<DecisionResult> => {
      const answer = answers[Math.min(calls.length, answers.length - 1)];
      calls.push(request);
      if (answer instanceof Error) throw answer;
      return { ...(answer[0] === undefined ? {} : { choice: answer[0] }), confidence: answer[1], by: 'fake' };
    },
  };
  return { service, calls };
}

/** Tom (lead), Mara and Lin with the person – or, `agentsOnly`, a work group of the three. */
function team(fake?: DecisionService, agentsOnly = false) {
  const h = harness({ decisions: fake });
  for (const [id, name] of [['ag_tom', 'Tom'], ['ag_mara', 'Mara'], ['ag_lin', 'Lin'], ['ag_ada', 'Ada']]) h.org.add(agent(id, name));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin'], createdBy: agentsOnly ? 'ag_tom' : HUMAN_ID, lead: 'ag_tom', ...(agentsOnly ? { humans: false } : {}) });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) =>
    h.chats.send({ conversationId: chat.id, authorId, authorKind: authorId === HUMAN_ID ? 'human' : 'agent', body, ...extra });
  const woken = () => h.wakeRows().map((row) => row.agent_id).sort();
  const clear = () => h.db.run('DELETE FROM wakes');
  return { ...h, chat, post, woken, clear };
}

test("round 4: an agent's line that @mentions nobody goes through the same pick as a person's – never its author, no provisional wake", async () => {
  const fake = decisions([['Mara', 0.9]]);
  const t = team(fake.service, true);
  t.post('ag_tom', 'Draft is done – the numbers still need a check.');
  assert.deepEqual(t.woken(), [], 'nothing before the pick: an agent\'s line has no lead to fall back to');
  await tick();
  assert.deepEqual(t.woken(), ['ag_mara'], 'the colleague the pick names');
  assert.deepEqual(t.wakeRows().map((row) => [row.reason, row.conversation_id]), [['message', t.chat.id]]);
  assert.equal(fake.calls[0].purpose, 'responder');
  assert.deepEqual(fake.calls[0].options, ['Lin', 'Mara', NOBODY], 'the author is no option; "nobody" is');
  assert.match(fake.calls[0].context ?? '', /^From Tom: Draft is done/);
  assert.deepEqual(t.urgent, [], 'a normal line steers nobody');
});

test("round 4: reply modes apply to an agent's line – 'all' hears it, only 'auto' agents are picked, also when just one is left", async () => {
  const fake = decisions([[NOBODY, 0.9]]);
  const t = team(fake.service, true);
  setReplyMode(t.services, t.chat.id, 'ag_lin', 'all', HUMAN_ID);
  t.clear();
  t.post('ag_tom', 'Pushed the new build.');
  assert.deepEqual(t.woken(), ['ag_lin'], "the 'all' agent at once");
  await tick();
  assert.deepEqual(t.woken(), ['ag_lin'], 'the pick said nobody else needs to reply');
  assert.deepEqual(fake.calls[0].options, ['Mara', NOBODY], 'one colleague left: still asked – the alternative is nobody, not her');
  setReplyMode(t.services, t.chat.id, 'ag_mara', 'mentions', HUMAN_ID);
  t.clear();
  t.post('ag_lin', 'Build looks fine.');
  await tick();
  assert.deepEqual(t.woken(), [], "Lin's line: Tom is the only 'auto' agent left – he is asked about, Mara ('mentions') never");
  assert.deepEqual(fake.calls[1].options, ['Tom', NOBODY]);
});

test('round 4: "nobody needs to reply" wakes nobody for every author – the provisional lead wake is withdrawn; an unsure "nobody" is no answer', async () => {
  const sure = team(decisions([[NOBODY, 0.9]]).service);
  sure.post(HUMAN_ID, 'Thanks, all clear!');
  assert.deepEqual(sure.woken(), ['ag_tom'], 'the provisional wake while the pick runs');
  await tick();
  assert.deepEqual(sure.wakeRows(), [], "the person's line needs no reply: the provisional wake is gone");
  sure.post('ag_mara', 'Noted, thanks.');
  await tick();
  assert.deepEqual(sure.wakeRows(), [], "neither does the colleague's");

  const unsure = team(decisions([[NOBODY, 0.45]]).service);
  unsure.post(HUMAN_ID, 'Thanks, all clear!');
  await tick();
  assert.deepEqual(unsure.wakeRows().map((row) => [row.agent_id, row.due_at - unsure.clock.now()]), [['ag_tom', 0]], 'unsure: the lead answers the person');
  unsure.clear();
  unsure.post('ag_mara', 'Noted, thanks.');
  await tick();
  assert.deepEqual(unsure.wakeRows(), [], "an agent's line: nobody");
});

test('round 4, the one asymmetry: without a decision model, or when it fails, a person\'s line wakes the lead and an agent\'s wakes nobody', async () => {
  for (const fake of [decisions([['Mara', 0.9]], false), decisions([new Error('backend down')]), decisions([[undefined, 0.9]])]) {
    const t = team(fake.service);
    t.post(HUMAN_ID, 'Status?');
    await tick();
    assert.deepEqual(t.woken(), ['ag_tom'], 'the person waits for an answer: the lead');
    t.clear();
    t.post('ag_lin', 'Status: all green.');
    await tick();
    assert.deepEqual(t.woken(), [], "an agent's statement mostly needs no reply: nobody");
  }
});

test("round 4: an agent's important chat.send line keeps T10's lead at once; a run's important answer goes through the pick, never urgent", async () => {
  const t = team(decisions([['Lin', 0.9]]).service);
  t.post('ag_mara', 'The build is broken for everyone.', { priority: 'important', runId: 'run_mara', meta: { sentDuringRun: true } });
  assert.deepEqual([t.woken(), t.urgent.map((item) => item.agentId)], [['ag_tom'], ['ag_tom']], 'the lead, at once and urgent');
  t.clear();
  t.urgent.length = 0;
  t.chats.postAgentMessage(t.chat.id, 'ag_mara', 'run_mara', { body: 'The server is down, someone has to restart it.', priority: 'important' });
  await tick();
  assert.deepEqual([t.woken(), t.urgent], [['ag_lin'], []], 'the picked colleague, never steered: the answer is for the person');
  assert.equal(t.notified.at(-1)?.kind, 'important', 'the person still gets it as important');
});

test('round 4: a line wakes at most two colleagues – never everyone of a larger group, whatever the pick names', async () => {
  const t = team(decisions([['Mara, Lin, Ada', 0.9]]).service, true);
  const four = t.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin', 'ag_ada'], humans: false, createdBy: 'ag_tom', lead: 'ag_tom' });
  t.clear();
  t.chats.send({ conversationId: four.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Which launch date works for you?' });
  await tick();
  assert.deepEqual(t.woken(), ['ag_lin', 'ag_mara'], 'two of the three others');
});
