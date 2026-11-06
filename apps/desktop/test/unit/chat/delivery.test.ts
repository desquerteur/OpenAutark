// Tests for the chat delivery rules (src/runtime/chat/delivery.ts, C3): who a committed message
// wakes (1:1, @mentions, the lead, the decision model's pick with its fallbacks and the two-
// responder cap, agent messages, external bridge messages with their own rate guard), urgent
// delivery, the wake for a task that waits on the person, kinds that never wake, B-050 K3/K4
// (a room of two addresses the other member for any author, a line to people only wakes no agent,
// a quiet line of any author wakes only the agents it mentions), and when the person is notified
// (agent-only and team rooms never; the chat's level applied centrally).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DecisionRequest, DecisionResult, DecisionService } from '../../../src/runtime/contracts.ts';
import { Notifications } from '../../../src/runtime/notify/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { HUMAN_WROTE_NOTE } from '../../../src/runtime/tasks/transitions.ts';
import { setReplyMode } from '../../../src/runtime/chat/reply-modes.ts';
import { NOBODY, PICKED_NOTE } from '../../../src/runtime/chat/responders.ts';
import { agent, harness, tick } from './harness.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

function decisions(answer: (request: DecisionRequest) => Promise<DecisionResult>, available = true) {
  const calls: DecisionRequest[] = [];
  const service: DecisionService = { available: () => available, decide: (request) => { calls.push(request); return answer(request); } };
  return { service, calls };
}
const choose = (choice: string, confidence = 0.9) => async (): Promise<DecisionResult> => ({ choice, confidence, by: 'fake' });

/** Tom (lead), Mara and Lin in a group with the person. */
function team(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  for (const [id, name] of [['ag_tom', 'Tom'], ['ag_mara', 'Mara'], ['ag_lin', 'Lin']]) h.org.add(agent(id, name));
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin'], createdBy: HUMAN_ID, lead: 'ag_tom' });
  const say = (body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body, ...extra });
  const woken = () => h.wakeRows().map((row) => row.agent_id).sort();
  const clear = () => h.db.run('DELETE FROM wakes');
  return { ...h, chat, say, woken, clear };
}

test('1:1: a human message wakes that agent now, keyed to the chat; a second one merges', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Hello' });
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Are you there?' });
  assert.deepEqual(h.wakeRows().map((row) => ({ ...row })), [{ agent_id: 'ag_tom', reason: 'message', conversation_id: chat.id, task_id: null, note: null, due_at: T0 }]);
});

test('group: @mentions wake only the mentioned agents; an un-addressed message wakes the lead', () => {
  const t = team();
  t.say('@Mara and @Lin, please check the numbers');
  assert.deepEqual(t.woken(), ['ag_lin', 'ag_mara']);
  t.clear();
  t.say('Anyone around?');
  assert.deepEqual(t.woken(), ['ag_tom']);
});

test('without a decision model agent messages wake only the agents they mention, never the author', () => {
  const t = team();
  t.clear();
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: 'Draft is done.' });
  assert.deepEqual(t.woken(), []);
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: '@Mara over to you, @Tom notes myself' });
  assert.deepEqual(t.woken(), ['ag_mara']);
});

test('decision: the picked responder is woken instead of the lead; names parse with "and", commas; a line of the person wakes one (D8)', async () => {
  for (const [choice, expected] of [
    ['Mara', ['ag_mara']],
    ['Mara and Lin', ['ag_mara']],
    ['Lin, Mara, Tom', ['ag_lin']],
    ['Tom & Mara', ['ag_tom']],
  ] as const) {
    const fake = decisions(choose(choice));
    const t = team({ decisions: fake.service });
    t.say('Who can take the invoice question?');
    await tick();
    assert.deepEqual(t.woken(), expected, choice);
    assert.ok(t.wakeRows().every((row) => row.due_at === T0), `${choice}: woken now`);
    assert.ok(t.wakeRows().every((row) => row.note === PICKED_NOTE), `${choice}: C4-live – a picked agent is told the line is its to answer`);
    assert.equal(fake.calls[0].purpose, 'responder');
    assert.deepEqual(fake.calls[0].options, ['Lin', 'Mara', 'Tom', NOBODY], 'round 4: "nobody needs to reply" is an answer too');
  }
});

test('decision fallbacks: low confidence, unknown names, no choice and a failing decision wake the lead', async () => {
  const answers: Array<() => Promise<DecisionResult>> = [
    choose('Mara', 0.3), choose('Nobody'), async () => ({ confidence: 0.9, by: 'fake' }), async () => { throw new Error('backend down'); },
  ];
  for (const [index, answer] of answers.entries()) {
    const t = team({ decisions: decisions(answer).service });
    t.say('Status?');
    await tick();
    assert.deepEqual(t.wakeRows().map((row) => [row.agent_id, row.due_at]), [['ag_tom', T0]], `answer ${index}`);
  }
});

test('without an available decision backend the lead is woken at once and nothing is asked', () => {
  const fake = decisions(choose('Mara'), false);
  const t = team({ decisions: fake.service });
  t.say('Status?');
  assert.deepEqual(t.woken(), ['ag_tom']);
  assert.equal(fake.calls.length, 0);
});

test('external messages wake like the person, pass their own rate guard and never interrupt', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const ext = 'ext:tg:42:Ana (Telegram)';
  h.chats.send({ conversationId: chat.id, authorId: ext, authorKind: 'external', body: 'Hi, is the shop open?', priority: 'important' });
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_tom']);
  assert.deepEqual(h.urgent, [], 'an external author never interrupts a turn');
  for (let i = 0; i < 9; i++) h.chats.send({ conversationId: chat.id, authorId: ext, authorKind: 'external', body: `again ${i}` });
  h.db.run('DELETE FROM wakes');
  h.chats.send({ conversationId: chat.id, authorId: ext, authorKind: 'external', body: 'eleventh within a minute' });
  assert.deepEqual(h.wakeRows(), [], 'the 11th external message in a minute wakes nobody');
  assert.ok(h.chats.messages(chat.id).some((message) => message.kind === 'status' && message.body.includes('message rate limit')));
});

test('external messages never clear the agent loop guard; the person does', () => {
  const t = team({ maxPerMinute: 2 });
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: '@Mara a' });
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_mara', body: '@Tom b' });
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: '@Mara c' }); // rate → paused
  t.chats.send({ conversationId: t.chat.id, authorId: 'ext:tg:7:Ben (Telegram)', authorKind: 'external', body: 'hello' });
  t.clear();
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_mara', body: '@Tom d' });
  assert.deepEqual(t.woken(), [], 'still paused after the external message');
  t.say('go on');
  t.clear();
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_mara', body: '@Tom e' });
  assert.deepEqual(t.woken(), ['ag_tom'], 'the person resets the guard');
});

test('priority important asks the dispatcher to interrupt the woken agents – after the decision, not for the provisional wake', async () => {
  const t = team({ decisions: decisions(choose('Lin')).service });
  t.say('@Mara stop the upload', { priority: 'important' });
  assert.deepEqual(t.urgent, [{ agentId: 'ag_mara', conversationId: t.chat.id }]);
  t.say('Everyone: stop!', { priority: 'important' });
  assert.equal(t.urgent.length, 1, 'nothing urgent while the decision runs');
  await tick();
  assert.deepEqual(t.urgent.at(-1), { agentId: 'ag_lin', conversationId: t.chat.id });
});

test('a message to an agent whose task waits on the person wakes it for that task with a note', () => {
  const t = team();
  const task = t.tasks.create({ conversationId: t.chat.id, title: 'Book the venue', assigneeKind: 'agent', assigneeId: 'ag_mara', createdBy: HUMAN_ID });
  t.tasks.setStatus(task.id, 'needs_you', 'ag_mara', 'Which date?');
  t.clear();
  t.say('@Mara Friday works');
  assert.deepEqual(t.wakeRows().map((row) => [row.agent_id, row.task_id, row.note]), [['ag_mara', task.id, HUMAN_WROTE_NOTE]]);
});

test('status lines, answers, silent and streaming messages wake nobody', () => {
  const t = team();
  t.clear();
  t.chats.status(t.chat.id, { type: 'note', text: 'Switched model' });
  t.say('quiet', { silent: true });
  t.say('my answer', { kind: 'answer' });
  t.chats.beginAgentMessage(t.chat.id, 'ag_tom', 'run_1');
  assert.deepEqual(t.woken(), []);
});

test('B-047 D4: a quiet agent message still wakes the agents it mentions, never notifies the person; one without mentions reaches nobody', () => {
  const t = team();
  t.clear();
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: 'Checked the cut, all fine', silent: true });
  assert.deepEqual(t.woken(), []);
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: '@Mara please review the grade', silent: true });
  assert.deepEqual(t.woken(), ['ag_mara'], 'the mentioned colleague is reached');
  assert.equal(t.notified.length, 0, 'the person is not notified');
  assert.equal(t.chats.summary(t.chat.id).unread, 0, 'nor is anything unread');
});

test('B-050 K4: a quiet message of the person wakes only the agents it @mentions – no 1:1, lead or reply-mode wake, never urgent, never notified', () => {
  const t = team();
  setReplyMode(t.services, t.chat.id, 'ag_lin', 'all', HUMAN_ID);
  t.clear();
  t.say('FYI the client called', { silent: true });
  assert.deepEqual(t.woken(), [], 'neither the lead nor the reply-mode "all" agent');
  t.say('@Mara have a look when you can', { silent: true, priority: 'important' });
  assert.deepEqual(t.woken(), ['ag_mara'], 'only the mentioned agent');
  assert.deepEqual(t.urgent, [], 'quiet wins over important: nothing is steered');
  assert.equal(t.notified.length, 0);

  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const solo = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: solo.id, authorId: HUMAN_ID, body: 'Noted for later', silent: true });
  assert.deepEqual(h.wakeRows(), [], 'a quiet line in a 1:1 wakes nobody');
  h.chats.send({ conversationId: solo.id, authorId: HUMAN_ID, body: '@Tom one thing', silent: true });
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_tom'], 'unless it mentions the agent');
});

test('B-050 K3: in a room of two an agent message wakes the other agent without a mention – through the loop guard; a quiet one only with a mention', () => {
  const h = harness({ maxPerMinute: 2 });
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_mara', 'Mara'));
  const room = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], humans: false, createdBy: 'ag_tom' });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: room.id, authorId, body, ...extra });
  const woken = () => h.wakeRows().map((row) => row.agent_id);
  const clear = () => h.db.run('DELETE FROM wakes');
  post('ag_tom', 'Checked the cut, all fine', { silent: true });
  assert.deepEqual(woken(), [], 'a quiet line without a mention reaches nobody');
  post('ag_tom', '@Mara please review the grade', { silent: true });
  assert.deepEqual(woken(), ['ag_mara'], 'a quiet one with a mention does');
  clear();
  post('ag_mara', 'Done, looks good.');
  assert.deepEqual(woken(), ['ag_tom'], 'the counterpart, no mention needed');
  clear();
  post('ag_tom', 'Thanks, shipping it.');
  assert.deepEqual(woken(), [], 'the third agent line within a minute: the loop guard pauses');
  assert.ok(h.chats.messages(room.id).some((message) => message.kind === 'status' && message.body.includes('message rate limit')));
  assert.equal(h.notified.length, 0, 'an agent-only room never notifies');

  // The other member of a room of two is a person: no agent to wake. An external agent's 1:1 with an agent: it is woken.
  const withOwner = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  clear();
  h.chats.send({ conversationId: withOwner.id, authorId: 'ag_tom', body: 'Report is ready.' });
  assert.deepEqual(woken(), []);
  const bot = 'ext:api:0123456789:Research-Bot';
  const linked = h.chats.create({ agentIds: ['ag_mara'], humans: false, createdBy: 'ag_mara' });
  h.db.run(`INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at) VALUES (?, ?, 'external', 'member', 0, 0)`, [linked.id, bot]);
  h.chats.send({ conversationId: linked.id, authorId: bot, authorKind: 'external', body: 'Here are the sources.' });
  assert.deepEqual(woken(), ['ag_mara']);
});

test('B-050 K3: a message that @mentions only people wakes no agent; one that also names an agent wakes it', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const lisa = 'per_lisa0000000';
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lisa Berg', 'active', 0, 0)`, [lisa]);
  const chat = h.chats.create({ agentIds: ['ag_tom'], people: [lisa], createdBy: HUMAN_ID });
  const woken = () => h.wakeRows().map((row) => row.agent_id);
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Lisa, what do you think?', mentions: [lisa] });
  assert.deepEqual(woken(), [], "the owner's line to a colleague");
  h.chats.send({ conversationId: chat.id, authorId: lisa, authorKind: 'human', body: 'Agreed, go ahead.', mentions: [HUMAN_ID], priority: 'important' });
  assert.deepEqual(woken(), [], "the colleague's answer to the owner");
  assert.deepEqual(h.urgent, [], 'and nobody is steered');
  h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: 'Lisa and Tom, please prepare the slides', mentions: [lisa, 'ag_tom'] });
  assert.deepEqual(woken(), ['ag_tom']);
  h.db.run('DELETE FROM wakes');
  h.chats.send({ conversationId: chat.id, authorId: lisa, authorKind: 'human', body: 'Numbers please' });
  assert.deepEqual(woken(), ['ag_tom'], 'an unaddressed line still reaches the one agent');
});

test('the person is notified for agent replies; @mentions and important as important; never for own or system lines; a group names its chat', () => {
  const t = team();
  t.say('Hello @Tom');
  t.chats.status(t.chat.id, { type: 'note', text: 'Renamed' });
  assert.equal(t.notified.length, 0);
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: 'On it.' });
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_mara', body: '@CEO please sign this' });
  t.chats.send({ conversationId: t.chat.id, authorId: 'ag_lin', body: 'Server is down', priority: 'important' });
  // B-050 K2: in a room of more than two the title is "Author · chat" (the chat as the owner sees it – here derived from the first line).
  assert.deepEqual(t.notified.map((note) => [note.kind, note.title, note.conversationId]), [
    ['reply', 'Tom · Hello @Tom', t.chat.id], ['important', 'Mara · Hello @Tom', t.chat.id], ['important', 'Lin · Hello @Tom', t.chat.id],
  ]);
});

test('agent-only rooms never notify; external messages notify as replies titled with the sender label', () => {
  const t = team();
  const room = t.chats.create({ agentIds: ['ag_tom', 'ag_mara'], humans: false, createdBy: 'ag_tom' });
  t.chats.send({ conversationId: room.id, authorId: 'ag_tom', body: '@Mara sync?', priority: 'important' });
  assert.equal(t.notified.length, 0);
  t.chats.send({ conversationId: t.chat.id, authorId: 'ext:tg:42:Ana (Telegram)', authorKind: 'external', body: 'urgent!', priority: 'important' });
  assert.deepEqual(t.notified.map((note) => [note.kind, note.title]), [['reply', 'Ana (Telegram) · Lin, Mara, Tom']], 'an untitled group by its other members, in member order (B-050 K2)');
});

test('a failing notification never costs the wake', () => {
  const t = team();
  Object.assign(t.services, { notifications: { notify: () => { throw new Error('host gone'); } } });
  t.clear();
  assert.doesNotThrow(() => t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body: '@Mara your turn' }));
  assert.deepEqual(t.woken(), ['ag_mara']);
});

test('with the real notifications: the chat level decides pushes and toasts of messages', () => {
  const t = team();
  const settings = new SettingsStore({ db: t.db, bus: t.bus, clock: t.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Gerd' } });
  const pushed: string[] = [];
  const host = { notify: async (input: { title: string; body: string }) => { pushed.push(input.body); return false; } };
  Object.assign(t.services, {
    settings,
    notifications: new Notifications({ bus: t.bus, host, settings, clock: t.clock, log: new MemoryLogger(), chat: (id) => t.chats.get(id) }),
  });
  const reply = (body: string) => { t.clock.advance(5000); t.chats.send({ conversationId: t.chat.id, authorId: 'ag_tom', body }); };
  const level = (notifications: 'all' | 'mentions' | 'off' | undefined) => t.chats.update(t.chat.id, { settings: { notifications } }, HUMAN_ID);

  reply('plain default');
  reply('@Gerd default mention');
  level('all');
  reply('plain all');
  level('mentions');
  reply('plain mentions');
  reply('@Gerd mentions mention');
  level('off');
  reply('@Gerd off mention');
  assert.deepEqual(pushed, ['@Gerd default mention', 'plain all', '@Gerd mentions mention']);
  const toasts = t.of('notify').map((note) => [note.body, note.toast]);
  assert.deepEqual(toasts, [
    ['plain default', false], ['@Gerd default mention', true], ['plain all', true],
    ['plain mentions', false], ['@Gerd mentions mention', true], ['@Gerd off mention', false],
  ]);
});
