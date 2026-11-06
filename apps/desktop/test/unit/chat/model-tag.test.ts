// B-050 K6 – the model tag on human messages (chat/sticky-model.ts modelTag via ChatService.send): a human
// text message carries the addressed agent's current choice (the pin with pinned: true, else the hint,
// with the chat's effort); Auto carries none; the addressed agent is the first @mention, else the agent
// replied to, else the lead; agents' lines, status lines and a client's own meta.modelHint never count.
// K2: the default 1:1 keeps its empty title after the first message. K4: an agent's answer carries the
// priority it was given (chat/publish-message.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { addressedAgents, modelTag } from '../../../src/runtime/chat/sticky-model.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mara' }));
  return h;
}

const OPUS = 'claude:claude-opus-5-5';
const LUNA = 'codex:gpt-6-luna';

test('a human message carries the addressed agent\'s choice: hint, pin (pinned), effort; Auto carries nothing', () => {
  const h = setup();
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_mara', 'ag_tom'], createdBy: 'human' });
  assert.equal(h.chats.lead(chat.id), 'ag_mara');
  const plain = h.chats.send({ conversationId: chat.id, body: 'Hello', authorId: 'human' });
  assert.equal(plain.meta.modelHint, undefined, 'Auto: no tag');

  const hinted = h.chats.send({ conversationId: chat.id, body: 'Draft it', authorId: 'human', model: LUNA, effort: 'high' });
  assert.deepEqual(hinted.meta.modelHint, { modelId: LUNA, effort: 'high' }, 'the lead is addressed: its new hint');
  assert.deepEqual(h.chats.message(hinted.id)!.meta.modelHint, { modelId: LUNA, effort: 'high' }, 'stored with the message');
  const next = h.chats.send({ conversationId: chat.id, body: 'And the intro', authorId: 'human' });
  assert.deepEqual(next.meta.modelHint, { modelId: LUNA, effort: 'high' }, 'the chat\'s choice stays until changed');

  h.chats.update(chat.id, { settings: { models: { ag_tom: OPUS } } }, 'human'); // "Always use this model" (chats.update)
  const toTom = h.chats.send({ conversationId: chat.id, body: '@Tom check it', authorId: 'human' });
  assert.deepEqual(toTom.meta.modelHint, { modelId: OPUS, pinned: true }, 'the first mention: Tom\'s pin');

  const answer = h.chats.send({ conversationId: chat.id, body: 'Checked.', authorId: 'ag_tom' });
  assert.equal(answer.meta.modelHint, undefined, 'an agent\'s line carries no tag');
  const reply = h.chats.send({ conversationId: chat.id, body: 'Thanks', authorId: 'human', replyTo: answer.id });
  assert.deepEqual(reply.meta.modelHint, { modelId: OPUS, pinned: true }, 'a reply addresses the agent replied to');

  const forged = h.chats.send({ conversationId: chat.id, body: 'x', authorId: 'human', meta: { modelHint: { modelId: 'evil' } } });
  assert.deepEqual(forged.meta.modelHint, { modelId: LUNA, effort: 'high' }, 'the tag is always the server\'s');
  h.chats.send({ conversationId: chat.id, body: 'back', authorId: 'human', model: 'auto', effort: 'auto' });
  const auto = h.chats.send({ conversationId: chat.id, body: 'now', authorId: 'human' });
  assert.equal(auto.meta.modelHint, undefined, 'Auto again: no tag');
  assert.equal(h.chats.status(chat.id, { type: 'note', text: 'x' }).meta.modelHint, undefined);
});

test('the sent model is the tag at once: a hint, or with pin: true the pin', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const hint = h.chats.send({ conversationId: chat.id, body: 'Plan it', authorId: 'human', model: OPUS });
  assert.deepEqual(hint.meta.modelHint, { modelId: OPUS });
  const pinned = h.chats.send({ conversationId: chat.id, body: 'Always', authorId: 'human', model: LUNA, pin: true });
  assert.deepEqual(pinned.meta.modelHint, { modelId: LUNA, pinned: true });
  const back = h.chats.send({ conversationId: chat.id, body: 'Suggest', authorId: 'human', model: OPUS });
  assert.deepEqual(back.meta.modelHint, { modelId: OPUS }, 'a hint drops the pin');
  assert.equal(h.chats.get(chat.id)!.settings.models, undefined);
});

test('addressedAgents and modelTag: mentions, else the lead, else the first agent; no agents, no tag', () => {
  const members = [
    { conversationId: 'c', memberId: 'human', kind: 'human', role: 'owner', readSeq: 0, joinedAt: 0 },
    { conversationId: 'c', memberId: 'ag_a', kind: 'agent', role: 'member', readSeq: 0, joinedAt: 0 },
    { conversationId: 'c', memberId: 'ag_b', kind: 'agent', role: 'lead', readSeq: 0, joinedAt: 0 },
  ] as const;
  assert.deepEqual(addressedAgents({ mentions: ['human', 'ag_a'] }, [...members]), ['ag_a']);
  assert.deepEqual(addressedAgents({ mentions: [] }, [...members]), ['ag_b']);
  assert.deepEqual(addressedAgents({ mentions: [] }, [members[0], { ...members[1] }]), ['ag_a']);
  assert.deepEqual(addressedAgents({ mentions: [] }, [members[0]]), []);
  assert.equal(modelTag({ models: { ag_a: 'auto' }, modelHints: { ag_a: 'auto' } }, 'ag_a'), undefined);
  assert.equal(modelTag({ efforts: { ag_a: 'high' } }, 'ag_a'), undefined, 'an effort alone is no tag');
  assert.equal(modelTag({ modelHints: { ag_a: OPUS } }, undefined), undefined);
});

test('K2: the default 1:1 keeps its empty title after the first message; another unnamed chat still takes one', () => {
  const h = setup();
  const direct = findOrCreateDirect(h.services, 'human', 'ag_tom');
  h.chats.send({ conversationId: direct, body: 'Plan the launch video', authorId: 'human' });
  assert.equal(h.chats.get(direct)!.title, '');
  assert.equal(h.chats.get(direct)!.titleNamed, false);
  const group = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], createdBy: 'human' });
  h.chats.send({ conversationId: group.id, body: 'Plan the launch video', authorId: 'human' });
  assert.equal(h.chats.get(group.id)!.title, 'Plan the launch video');
});

test('K4: an answer finished or posted with priority important is stored and announced so; default normal', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const streaming = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_1');
  const finished = h.chats.finishAgentMessage(streaming.id, { body: 'The server is down', state: 'final', priority: 'important' });
  assert.equal(finished.priority, 'important');
  assert.equal(h.chats.message(finished.id)!.priority, 'important');
  const posted = h.chats.postAgentMessage(chat.id, 'ag_tom', 'run_2', { body: 'Back up', priority: 'important' });
  assert.equal(h.chats.message(posted.id)!.priority, 'important');
  const plain = h.chats.postAgentMessage(chat.id, 'ag_tom', 'run_3', { body: 'Fine' });
  assert.equal(plain.priority, 'normal');
  assert.equal(h.chats.summary(chat.id).importantUnread, 2);
  assert.ok(h.notified.some((note) => note.kind === 'important' && note.conversationId === chat.id), 'the owner is notified as important');
});
