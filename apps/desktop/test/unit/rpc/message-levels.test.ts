// B-050 K4 – the three message levels over RPC: messages.send takes `silent` from the owner, a phone and a
// person of the organisation (a silent line lands in the history, wakes no agent it does not @mention, is
// never unread); silent together with priority important is refused; a scheduled post can be silent too
// (payload.silent), a task post never; rewording keeps or changes the level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { peopleRig } from '../people/rig.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { rewordPost, scheduledPost } from '../../../src/runtime/schedules/post.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  return { ...f, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('messages.send silent: stored quiet, wakes no agent, never both silent and important', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const quiet = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: 'For later', silent: true });
  assert.equal(f.chats.message(quiet.id)!.silent, true);
  assert.equal(f.chats.message(quiet.id)!.priority, 'normal');
  assert.equal(f.wakeRows().length, 0, 'a quiet line wakes nobody it does not @mention');
  const phone = await f.phone.call<Message>('messages.send', { conversationId: chat.id, body: 'Also later', silent: true });
  assert.equal(f.chats.message(phone.id)!.silent, true, 'a phone may send quietly too');
  const both = await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', silent: true, priority: 'important' });
  assert.equal(both.error?.code, 'bad_request');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', silent: 'yes' })).error?.code, 'bad_request');
  const loud = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Now please', silent: false, priority: 'important' });
  assert.deepEqual([loud.silent, loud.priority], [false, 'important']);
  assert.ok(f.wakeRows().some((row) => row.agent_id === 'ag_ava'), 'a normal or important line wakes as before');
});

test('messages.schedule: a silent post stores payload.silent; a task post is never silent', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const at = f.clock.now() + 3_600_000;
  const schedule = await f.owner.call<Schedule>('messages.schedule', { conversationId: chat.id, body: 'Recap', spec: { at }, priority: 'silent' });
  assert.deepEqual(schedule.payload, { body: 'Recap', silent: true });
  const task = await f.owner.request('messages.schedule', { conversationId: chat.id, body: 'Recap', spec: { at }, priority: 'silent', asTask: true });
  assert.equal(task.error?.code, 'bad_request');
});

test('scheduledPost and rewordPost: the level moves between normal, important and silent', () => {
  assert.deepEqual(scheduledPost('Hi', { priority: 'silent' }).payload, { body: 'Hi', silent: true });
  assert.deepEqual(scheduledPost('Hi', { priority: 'important' }).payload, { body: 'Hi', priority: 'important' });
  const stored = { id: 'sch_1', ownerId: 'human', kind: 'message', title: 'Hi', spec: { at: 1 }, payload: { body: 'Hi', silent: true }, runs: 0, active: true, createdAt: 0 } as Schedule;
  assert.deepEqual(rewordPost(stored, { body: 'Hello' }).payload, { body: 'Hello', priority: undefined, silent: true, mentions: undefined }, 'rewording keeps quiet');
  assert.deepEqual(rewordPost(stored, { priority: 'important' }).payload, { body: 'Hi', priority: 'important', silent: undefined, mentions: undefined });
});

test('a person sends quietly too; silent and important together are refused', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Launch' });
  r.db.run('DELETE FROM wakes');
  const sent = await anna.client.call<Message>('messages.send', { conversationId: chat.id, body: 'Noted for later', silent: true });
  assert.equal(r.chats.message(sent.id)!.silent, true);
  assert.equal(r.wakeRows().filter((row) => row.agent_id === 'ag_research').length, 0);
  await assert.rejects(anna.client.call('messages.send', { conversationId: chat.id, body: 'x', silent: true, priority: 'important' }), /either silent or priority important/);
});
