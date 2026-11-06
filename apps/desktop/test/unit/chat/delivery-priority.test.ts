// Tests for priority in chat delivery (T10: src/runtime/chat/delivery.ts, loop-guard.ts
// ImportantBrake): an agent's important message without mentions reaches the other agent of a
// two-agent room or else the lead (wake plus urgent) – a run's final answer marked [[important]]
// is for the person and reaches no agent unless it mentions one – while a normal one still wakes nobody,
// mentions win, a message that mentions only the person addresses no agent and the lead's own
// reaches nobody; the person's important message also steers agents already running in that chat
// (at once, also while the decision model picks, never twice; a normal one does not); the brake:
// the 6th important message of one agent in one chat within 10 minutes counts as normal (no wake
// without mention, no urgent, notified as a reply) with exactly one status line, per author and
// chat, until the window has room again; the owner is never braked; a person of the organisation
// (F-52, 'per_…') is braked with the same limits over all their chats together; the loop guard still applies.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionResult, DecisionService } from '../../../src/runtime/contracts.ts';
import { ImportantBrake } from '../../../src/runtime/chat/loop-guard.ts';
import { agent, harness, tick } from './harness.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
const MIN = 60_000;

function decide(choice: string): DecisionService {
  return { available: () => true, decide: async (): Promise<DecisionResult> => ({ choice, confidence: 0.9, by: 'fake' }) };
}

/** Tom (lead), Mara and Lin in a group with the person. */
function team(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  for (const [id, name] of [['ag_tom', 'Tom'], ['ag_mara', 'Mara'], ['ag_lin', 'Lin']]) h.org.add(agent(id, name));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin'], createdBy: HUMAN_ID, lead: 'ag_tom' });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: chat.id, authorId, body, ...extra });
  const woken = () => h.wakeRows().map((row) => row.agent_id).sort();
  const clear = () => { h.db.run('DELETE FROM wakes'); h.urgent.length = 0; };
  const runs = (...items: Array<[string, string]>) => {
    for (const [agentId, conversationId] of items) h.running.push({ agentId, runId: `run_${agentId}`, conversationId, note: '', startedAt: T0 });
  };
  return { ...h, chat, post, woken, clear, runs };
}

/** The manager Mia and her report Tom in their 1:1 (the person follows it). */
function pair() {
  const h = harness();
  h.org.add(agent('ag_mia', 'Mia'));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mia' }));
  const chat = h.chats.create({ agentIds: ['ag_mia', 'ag_tom'], createdBy: HUMAN_ID, lead: 'ag_mia' });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: chat.id, authorId, body, ...extra });
  const statusLines = () => h.chats.messages(chat.id).filter((message) => message.kind === 'status').map((message) => message.body);
  return { ...h, chat, post, statusLines };
}

test("a manager's urgent message in a 1:1 with its report wakes and steers the report; a normal one wakes nobody", () => {
  const p = pair();
  p.post('ag_mia', 'How is the upload going?');
  assert.deepEqual(p.wakeRows(), [], 'a normal agent message without a mention still wakes nobody');
  assert.deepEqual(p.urgent, []);
  p.post('ag_mia', 'Stop the upload, the file is wrong.', { priority: 'important' });
  assert.deepEqual(p.wakeRows().map((row) => [row.agent_id, row.reason, row.conversation_id]), [['ag_tom', 'message', p.chat.id]]);
  assert.deepEqual(p.urgent, [{ agentId: 'ag_tom', conversationId: p.chat.id }]);
});

test('a two-agent room without the person works the same way', () => {
  const h = harness();
  h.org.add(agent('ag_mia', 'Mia'));
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_mia', 'ag_tom'], humans: false, createdBy: 'ag_mia', lead: 'ag_mia' });
  h.chats.send({ conversationId: chat.id, authorId: 'ag_tom', body: 'Blocked: the key expired.', priority: 'important' });
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_mia']);
  assert.deepEqual(h.urgent, [{ agentId: 'ag_mia', conversationId: chat.id }]);
  assert.deepEqual(h.notified, [], 'an agent-only room never notifies');
});

test("group: an agent's important message without mentions reaches the lead; mentions win; the lead's own and one to the person reach no agent", () => {
  const t = team();
  t.clear();
  t.post('ag_mara', 'The build is broken for everyone.', { priority: 'important' });
  assert.deepEqual(t.woken(), ['ag_tom'], 'the lead');
  assert.deepEqual(t.urgent, [{ agentId: 'ag_tom', conversationId: t.chat.id }]);
  t.clear();
  t.post('ag_mara', '@Lin the build is broken, please revert.', { priority: 'important' });
  assert.deepEqual(t.woken(), ['ag_lin'], 'the mentioned agent, not the lead');
  assert.deepEqual(t.urgent, [{ agentId: 'ag_lin', conversationId: t.chat.id }]);
  t.clear();
  t.post('ag_tom', 'Everyone stop deploying.', { priority: 'important' });
  assert.deepEqual(t.woken(), [], 'the lead itself addresses nobody without mentions');
  assert.deepEqual(t.urgent, []);
  t.post('ag_mara', 'Please approve the payment.', { priority: 'important', mentions: [HUMAN_ID] });
  assert.deepEqual(t.woken(), [], 'a message to the person wakes no agent');
  assert.deepEqual(t.urgent, []);
  assert.equal(t.notified.at(-1)?.kind, 'important');
  t.post('ag_mara', 'The build is green again.');
  assert.deepEqual(t.woken(), [], 'a normal message without mentions stays mention-only');
});

test("a run's final answer marked [[important]] is for the person: it neither wakes nor steers the lead; a chat.send post of the run still does", () => {
  const t = team();
  t.clear();
  t.chats.postAgentMessage(t.chat.id, 'ag_mara', 'run_mara', { body: 'The server is down, decide today.', priority: 'important' });
  assert.deepEqual(t.woken(), [], 'no agent is addressed by an answer to the person');
  assert.equal(t.urgent.length, 0, 'the lead keeps working');
  assert.equal(t.notified.at(-1)?.kind, 'important', 'the person gets it as important');
  t.chats.postAgentMessage(t.chat.id, 'ag_mara', 'run_mara', { body: '@Lin please restart it.', priority: 'important' });
  assert.deepEqual([t.woken(), t.urgent.map((item) => item.agentId)], [['ag_lin'], ['ag_lin']], 'a mention still reaches that agent');
  t.clear();
  t.post('ag_mara', 'The build is broken for everyone.', { priority: 'important', runId: 'run_mara', meta: { sentDuringRun: true } });
  assert.deepEqual([t.woken(), t.urgent.map((item) => item.agentId)], [['ag_tom'], ['ag_tom']], 'chat.send important: the lead (T10)');
});

test("the person's important message also steers agents already running in that chat – after the addressed ones, never twice", () => {
  const t = team();
  const other = t.chats.create({ agentIds: ['ag_lin'], createdBy: HUMAN_ID });
  t.clear();
  t.runs(['ag_mara', t.chat.id], ['ag_lin', other.id]);
  t.post(HUMAN_ID, 'Stop, the client cancelled!', { priority: 'important' });
  assert.deepEqual(t.woken(), ['ag_tom'], 'the lead answers');
  assert.deepEqual(t.urgent, [{ agentId: 'ag_tom', conversationId: t.chat.id }, { agentId: 'ag_mara', conversationId: t.chat.id }],
    'Mara works in this chat and is steered; Lin works elsewhere and is not');
  t.clear();
  t.post(HUMAN_ID, 'Just so you know: the meeting is at 3.');
  assert.deepEqual(t.urgent, [], 'a normal message steers nobody');
  t.post(HUMAN_ID, '@Mara stop the upload', { priority: 'important' });
  assert.deepEqual(t.urgent, [{ agentId: 'ag_mara', conversationId: t.chat.id }], 'an addressed running agent is asked once');
});

test("with a responder decision the person's important message steers running agents at once and the picked one after (D8: one)", async () => {
  const t = team({ decisions: decide('Tom and Mara') });
  t.clear();
  t.runs(['ag_mara', t.chat.id], ['ag_lin', t.chat.id]);
  t.post(HUMAN_ID, 'Everyone: stop!', { priority: 'important' });
  assert.deepEqual(t.urgent.map((item) => item.agentId), ['ag_mara', 'ag_lin'], 'before the decision returns');
  await tick();
  assert.deepEqual(t.urgent.map((item) => item.agentId), ['ag_mara', 'ag_lin', 'ag_tom'], 'the picked Tom; Mara was steered already');
});

test('important brake: the 6th important message of one agent in a chat within 10 minutes counts as normal, with one status line', () => {
  const p = pair();
  for (let i = 0; i < 5; i++) { p.post('ag_mia', `Now ${i}`, { priority: 'important' }); p.clock.advance(MIN); }
  assert.equal(p.urgent.length, 5);
  assert.deepEqual(p.notified.map((item) => item.kind), ['important', 'important', 'important', 'important', 'important']);
  p.db.run('DELETE FROM wakes');
  p.post('ag_mia', 'Now 5', { priority: 'important' });
  assert.equal(p.urgent.length, 5, 'no steering');
  assert.deepEqual(p.wakeRows(), [], 'treated as a normal agent message: no mention, nobody woken');
  assert.equal(p.notified.at(-1)?.kind, 'reply', 'the person is notified as for a normal reply');
  assert.deepEqual(p.statusLines(), ['Important messages from Mia count as normal for now: more than 5 in 10 minutes']);
  p.post('ag_mia', '@Tom now 6', { priority: 'important' });
  assert.deepEqual(p.wakeRows().map((row) => row.agent_id), ['ag_tom'], 'a mention still wakes like a normal message');
  assert.equal(p.urgent.length, 5);
  assert.equal(p.statusLines().length, 1, 'the line is said once');

  p.post('ag_tom', 'Need the new key now.', { priority: 'important' });
  assert.deepEqual(p.urgent.at(-1), { agentId: 'ag_mia', conversationId: p.chat.id }, 'another author is not braked');
  const other = p.chats.create({ agentIds: ['ag_mia', 'ag_tom'], createdBy: HUMAN_ID, lead: 'ag_mia' });
  p.chats.send({ conversationId: other.id, authorId: 'ag_mia', body: 'Here: stop.', priority: 'important' });
  assert.deepEqual(p.urgent.at(-1), { agentId: 'ag_tom', conversationId: other.id }, 'nor the same author in another chat');

  p.clock.advance(10 * MIN); // the window has room again
  const before = p.urgent.length;
  p.post('ag_mia', 'Stop again', { priority: 'important' });
  assert.equal(p.urgent.length, before + 1, 'important again');
});

test('a person of the organisation is braked like an agent, over all their chats together; the owner still is not', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lin', 'Lin'));
  Object.assign(h.services, { people: { nameOf: (id: string) => (id === 'per_annaberg01' ? 'Anna' : undefined) } });
  const [first, second] = [h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID }), h.chats.create({ agentIds: ['ag_lin'], createdBy: HUMAN_ID })];
  for (const chat of [first, second]) h.db.run(`INSERT INTO members (conversation_id, member_id, kind, joined_at) VALUES (?, 'per_annaberg01', 'human', 0)`, [chat.id]);
  const anna = (conversationId: string, body: string) => h.chats.send({ conversationId, authorId: 'per_annaberg01', authorKind: 'human', body, priority: 'important' });
  h.running.push({ agentId: 'ag_lin', runId: 'run_owner_work', conversationId: 'cv_owner_elsewhere', note: '', startedAt: T0 });
  for (let i = 0; i < 5; i++) { anna(first.id, `Now ${i}`); h.clock.advance(MIN); }
  assert.equal(h.urgent.length, 5, 'within the limit her important lines still steer');
  h.db.run('DELETE FROM wakes');
  anna(second.id, 'And now this');
  assert.equal(h.urgent.length, 5, 'the 6th – in another chat – no longer steers or cuts work (Lin keeps the owner\'s work)');
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_lin'], 'it still wakes like a normal message');
  const lines = (id: string) => h.chats.messages(id).filter((message) => message.kind === 'status').map((message) => message.body);
  assert.deepEqual(lines(second.id), ['Important messages from Anna count as normal for now: more than 5 in 10 minutes']);
  anna(first.id, 'Again');
  assert.equal(h.urgent.length, 5);
  assert.equal(lines(first.id).length, 0, 'the line is said once');
  h.chats.send({ conversationId: second.id, authorId: HUMAN_ID, body: 'Owner: stop', priority: 'important' });
  assert.equal(h.urgent.length, 6, 'the owner is never braked');
  h.clock.advance(10 * MIN);
  anna(first.id, 'Later');
  assert.equal(h.urgent.length, 7, 'important again once the window has room');
});

test('the owner is never braked; the loop guard still pauses important agent messages', () => {
  const p = pair();
  for (let i = 0; i < 8; i++) p.post(HUMAN_ID, `@Tom stop ${i}`, { priority: 'important' });
  assert.equal(p.urgent.filter((item) => item.agentId === 'ag_tom').length, 8);
  assert.deepEqual(p.statusLines(), []);

  const t = team({ maxPerMinute: 2 });
  t.clear();
  t.post('ag_mara', '@Lin a');
  t.post('ag_lin', '@Mara b');
  t.post('ag_mara', 'Everyone stop!', { priority: 'important' }); // third agent message in a minute: rate pause
  assert.deepEqual(t.urgent, []);
  assert.ok(t.chats.messages(t.chat.id).some((message) => message.kind === 'status' && message.body.includes('message rate limit')));
});

test('ImportantBrake: per author and chat, a sliding window, one braking verdict per episode', () => {
  const brake = new ImportantBrake({ maxImportant: 2, windowMs: 10 });
  assert.deepEqual([0, 1, 2, 3].map((at) => brake.important('c', 'a', at)), ['ok', 'ok', 'braking', 'braked']);
  assert.equal(brake.important('c', 'b', 3), 'ok', 'another author');
  assert.equal(brake.important('d', 'a', 3), 'ok', 'another chat');
  assert.equal(brake.important('c', 'a', 9), 'braked', 'still more than two within the window');
  assert.equal(brake.important('c', 'a', 30), 'ok', 'the window emptied');
  assert.deepEqual([31, 32].map((at) => brake.important('c', 'a', at)), ['ok', 'braking'], 'a new episode says so again');
});
