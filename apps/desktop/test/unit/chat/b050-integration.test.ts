// B-050 integration of the verification round's cross-area fixes in the chat core and delivery:
// K4 – a quiet reply to an agent's line mentions nobody by itself (no wake, no steer; that agent picks it up
// later), a quiet owner line never ends the owner's pause, and an important line past the brake is stored as
// normal (its badge agrees with the push it does not get); K8 e – a sender behind a connector is an outside
// contact, not an external agent (its line wakes the room's agent, its back-and-forth is no agent ping-pong);
// K2 – a notification of a room of two carries its topic, a chat started without a title stays untitled, and a
// default 1:1 its partner left keeps the partner's name.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { isConnectorSender, isExternalAgent } from '../../../src/shared/model/external-agents.ts';
import { isPaused } from '../../../src/shared/model/task-pause.ts';
import { findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { pickUpQuiet } from '../../../src/runtime/chat/quiet-pickup.ts';
import { chatTitleFor } from '../../../src/runtime/chat/titles.ts';
import { agent, harness } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_mara', 'Mara'));
  return h;
}

test('K4: a quiet reply to an agent\'s line mentions nobody – no wake, no steer; only that agent picks it up later', () => {
  const h = setup();
  const group = h.chats.create({ title: 'Launch', agentIds: ['ag_tom', 'ag_mara'], createdBy: HUMAN_ID, lead: 'ag_mara' });
  const line = h.chats.send({ conversationId: group.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Draft is ready' });
  h.db.run('DELETE FROM wakes');
  const quiet = h.chats.send({ conversationId: group.id, authorId: HUMAN_ID, body: 'looks fine', silent: true, replyTo: line.id });
  assert.deepEqual(quiet.mentions, [], 'the quote alone mentions nobody');
  assert.deepEqual(h.wakeRows(), [], 'nobody is woken');
  assert.deepEqual(h.urgent, [], 'nobody is steered');
  assert.deepEqual(pickUpQuiet(h.services, 'ag_mara'), [], 'the lead leaves a reply to Tom\'s line to Tom');
  assert.deepEqual(pickUpQuiet(h.services, 'ag_tom'), [group.id]);
  const normal = h.chats.send({ conversationId: group.id, authorId: HUMAN_ID, body: 'one more thing', replyTo: line.id });
  assert.deepEqual(normal.mentions, ['ag_tom'], 'a normal reply still addresses the replied agent');
});

test('K4: a quiet owner line never ends the owner\'s pause; a normal one does', () => {
  const h = setup();
  const chat = findOrCreateDirect(h.services, HUMAN_ID, 'ag_tom', { createdBy: HUMAN_ID });
  const task = h.tasks.create({ conversationId: chat, title: 'Cut the launch video', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  h.tasks.pause(task.id, HUMAN_ID);
  h.db.run('DELETE FROM wakes');
  h.chats.send({ conversationId: chat, authorId: HUMAN_ID, body: 'note for later: blue logo', silent: true });
  assert.ok(isPaused(h.tasks.get(task.id)!), 'still paused');
  assert.deepEqual(h.wakeRows().filter((row) => row.task_id === task.id), [], 'no task wake');
  h.chats.send({ conversationId: chat, authorId: HUMAN_ID, body: 'go on' });
  assert.ok(!isPaused(h.tasks.get(task.id)!), 'a normal line resumes it');
});

test('K4: an important line past the brake is stored as normal – red badge and push agree', () => {
  const h = setup();
  const chat = findOrCreateDirect(h.services, HUMAN_ID, 'ag_tom', { createdBy: HUMAN_ID });
  const sent = Array.from({ length: 6 }, (_, index) => h.chats.send({ conversationId: chat, authorId: 'ag_tom', authorKind: 'agent', body: `Alert ${index + 1}`, priority: 'important' }));
  assert.deepEqual(sent.map((message) => h.chats.message(message.id)!.priority), ['important', 'important', 'important', 'important', 'important', 'normal']);
  assert.equal(h.chats.summary(chat).importantUnread, 5);
  const kinds = h.notified.filter((note) => note.conversationId === chat).map((note) => note.kind);
  assert.deepEqual(kinds, ['important', 'important', 'important', 'important', 'important', 'reply']);
});

test('K8 e: a sender behind a connector is an outside contact – its line wakes the agent, its back-and-forth is no agent ping-pong', () => {
  const h = setup();
  const bridge = 'ext:api:0123456789:Bridge';
  const anna = 'ext:api:0123456789:abcdef0123456789:Anna';
  assert.deepEqual([isExternalAgent(bridge), isConnectorSender(bridge)], [true, false]);
  assert.deepEqual([isExternalAgent(anna), isConnectorSender(anna)], [false, true]);
  assert.equal(isExternalAgent('ext:tg:42:Anna (Telegram)'), false);
  const room = h.chats.create({ title: 'WhatsApp', agentIds: ['ag_tom'], humans: false, createdBy: 'ag_tom' });
  h.chats.setMembers(room.id, { add: [bridge, anna] }, SYSTEM_ID);
  h.db.run('DELETE FROM wakes');
  h.chats.send({ conversationId: room.id, authorId: anna, authorKind: 'external', body: 'Is my order on its way?' });
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason]), [['ag_tom', 'message']], 'woken once, like by a bridged contact');
  for (let index = 0; index < 6; index++) {
    h.clock.advance(20_000);
    h.chats.send({ conversationId: room.id, authorId: 'ag_tom', authorKind: 'agent', body: `@Anna answer ${index}`, mentions: [anna] });
    h.clock.advance(20_000);
    h.chats.send({ conversationId: room.id, authorId: anna, authorKind: 'external', body: `and then ${index}?` });
  }
  const guards = h.chats.messages(room.id, { limit: 200 }).filter((message) => message.meta.status?.details?.guard !== undefined);
  assert.deepEqual(guards.map((message) => message.body), [], 'never paused as back-and-forth');
});

test('K2: a notification of a room of two carries its topic; the default 1:1 is named by its author', () => {
  const h = setup();
  const direct = findOrCreateDirect(h.services, HUMAN_ID, 'ag_tom', { createdBy: HUMAN_ID });
  const topic = h.chats.create({ title: 'Video schneiden', agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: direct, authorId: 'ag_tom', authorKind: 'agent', body: 'Hi' });
  h.chats.send({ conversationId: topic.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Cut done' });
  assert.deepEqual(h.notified.map((note) => note.title), ['Tom', 'Tom · Video schneiden']);
});

test('K2: a chat started without a title stays untitled (each viewer sees the others\' names); a default 1:1 its partner left keeps the name', () => {
  const h = setup();
  const group = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], createdBy: HUMAN_ID });
  assert.equal(h.chats.get(group.id)!.title, '');
  assert.equal(chatTitleFor(h.services, group.id, HUMAN_ID), 'Mara, Tom');
  assert.equal(chatTitleFor(h.services, group.id, 'ag_tom'), 'Mara', 'never the viewer\'s own name');
  h.chats.send({ conversationId: group.id, authorId: HUMAN_ID, body: 'Plan the launch event' });
  assert.equal(h.chats.get(group.id)!.title, 'Plan the launch event', 'the first line still names it');

  const direct = findOrCreateDirect(h.services, HUMAN_ID, 'ag_tom', { createdBy: HUMAN_ID });
  h.chats.setMembers(direct, { remove: ['ag_tom'] }, HUMAN_ID);
  const left = h.chats.get(direct)!;
  assert.deepEqual([left.title, left.titleNamed, left.settings.direct], ['Tom', false, undefined]);
  assert.equal(chatTitleFor(h.services, direct, HUMAN_ID), 'Tom', 'never an untitled chat');
});
