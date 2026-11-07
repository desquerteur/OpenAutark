// AF-016 – the chats' prompt queues (runtime/prompt-queue/service.ts) over the real chat service, wake queue, run journal
// and RPC handlers (queue.*, messages.stop) with a fake dispatcher. Three prompts lined up while the agent works stay
// queued; edited and reordered, they go out one after another, each once the agent's run ended; a failed run, a run
// that asked the person and the person's Stop pause the queue until queue.resume; the queue survives a restart (a new
// service over the same database) and goes on after it; the emergency stop pauses every queue; a removed chat drops it.
// Owns: these assertions only. Never: an engine or a window (test/e2e/runtime-prompt-queue.test.mjs, test/ui).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { agent } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { PromptQueue } from '../../../src/shared/model/prompt-queue.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { PromptQueues } from '../../../src/runtime/prompt-queue/service.ts';
import { register as registerQueue } from '../../../src/runtime/rpc/handlers/prompt-queue.ts';
import { OWNER, TestClient, rpcFixture, s1Table } from '../rpc/s1-helpers.ts';

function setup() {
  const table = s1Table();
  registerQueue(table);
  const f = rpcFixture({ table });
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const make = () => new PromptQueues({ services: () => f.services, settleMs: 0, graceMs: 0, startMs: 0 });
  const queues = make();
  f.services.promptQueue = queues;
  const offs = [queues.watch()];
  const owner = new TestClient(f.server, OWNER);
  const sent = () => f.chats.messages(chat.id, { limit: 100 }).filter((message) => message.authorKind === 'human').map((message) => message.body);
  let n = 0;
  /** The agent is at work: a running run in the chat and its claimed wake. */
  const working = () => {
    const runId = `run_q${++n}`;
    f.services.runs.start({ id: runId, agentId: 'ag_ava', conversationId: chat.id, trigger: 'message' });
    f.dispatcher.active = [{ agentId: 'ag_ava', runId, conversationId: chat.id, note: '', startedAt: f.clock.now() }];
    return runId;
  };
  /** The run ends (`answer` posted as its row), its wakes are done – what the dispatcher does at a turn's end. */
  const ends = async (runId: string, status: Run['status'] = 'done', answer = 'Done.', error?: string) => {
    const row = f.chats.beginAgentMessage(chat.id, 'ag_ava', runId);
    f.chats.finishAgentMessage(row.id, { body: answer, state: status === 'failed' ? 'failed' : 'final' });
    f.dispatcher.active = [];
    f.db.run('DELETE FROM wakes');
    f.clock.advance(10);
    f.services.runs.finish(runId, { status, endedAt: f.clock.now(), ...(error ? { error } : {}) });
    await sleep(20);
  };
  return { f, chat, queues, make, offs, owner, sent, working, ends, cleanup: () => { for (const off of offs) off(); f.cleanup(); } };
}

const bodies = (queue: PromptQueue) => queue.items.map((item) => item.body);

test('three prompts while the agent works: edited and reordered, then sent one after another as each run ends', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  const first = h.working();
  for (const body of ['One', 'Two', 'Three']) await h.owner.call('queue.add', { conversationId: h.chat.id, body });
  await sleep(20);
  let queue = await h.owner.call<PromptQueue>('queue.get', { conversationId: h.chat.id });
  assert.deepEqual(bodies(queue), ['One', 'Two', 'Three'], 'nothing went out while the agent works');
  assert.deepEqual(h.sent(), []);
  queue = await h.owner.call<PromptQueue>('queue.update', { conversationId: h.chat.id, id: queue.items[1].id, body: 'Two, edited' });
  queue = await h.owner.call<PromptQueue>('queue.move', { conversationId: h.chat.id, id: queue.items[2].id, index: 0 });
  assert.deepEqual(bodies(queue), ['Three', 'One', 'Two, edited']);

  await h.ends(first);
  assert.deepEqual(h.sent(), ['Three'], 'the top one went out when the run ended');
  assert.deepEqual(bodies(h.queues.get(h.chat.id)), ['One', 'Two, edited']);
  assert.ok(h.f.wakeRows().some((wake) => wake.agent_id === 'ag_ava'), 'as the person\'s message it wakes the agent');
  h.queues.kick(h.chat.id);
  assert.deepEqual(h.sent(), ['Three'], 'the agent has not answered yet (its wake waits): nothing more');

  await h.ends(h.working());
  assert.deepEqual(h.sent(), ['Three', 'One']);
  await h.ends(h.working());
  assert.deepEqual(h.sent(), ['Three', 'One', 'Two, edited']);
  assert.deepEqual(bodies(h.queues.get(h.chat.id)), [], 'empty');
  await h.ends(h.working());
  assert.equal(h.sent().length, 3, 'nothing is sent twice');
});

test('a failed run pauses with its error; a question pauses; resume sends once the chat is free', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  const run = h.working();
  await h.owner.call('queue.add', { conversationId: h.chat.id, body: 'Next' });
  await h.ends(run, 'failed', 'half', 'Rate limited');
  let queue = h.queues.get(h.chat.id);
  assert.deepEqual(queue.paused && [queue.paused.reason, queue.paused.note], ['error', 'Rate limited']);
  assert.deepEqual(h.sent(), [], 'held after the error');
  await h.owner.call('queue.resume', { conversationId: h.chat.id });
  await sleep(20);
  assert.deepEqual(h.sent(), ['Next'], 'resumed: the chat is free, so it goes');

  const asking = h.working();
  await h.owner.call('queue.add', { conversationId: h.chat.id, body: 'After the question' });
  await h.ends(asking, 'done', 'I can do it two ways.\n\nShould I use the staging server?');
  queue = h.queues.get(h.chat.id);
  assert.equal(queue.paused?.reason, 'ask', 'the agent asked the person something');
  assert.deepEqual(h.sent(), ['Next']);
  await h.owner.call('queue.pause', { conversationId: h.chat.id });
  assert.equal(h.queues.get(h.chat.id).paused?.reason, 'manual');
});

test('the person\'s Stop (messages.stop) pauses the queue before the run ends; it waits until resumed', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  const run = h.working();
  await h.owner.call('queue.add', { conversationId: h.chat.id, body: 'Later' });
  await h.owner.call('messages.stop', { conversationId: h.chat.id });
  assert.deepEqual(h.f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: h.chat.id }]);
  await h.ends(run, 'interrupted');
  assert.equal(h.queues.get(h.chat.id).paused?.reason, 'stop');
  assert.deepEqual(h.sent(), [], 'Stop holds the queue');
  await h.owner.call('queue.resume', { conversationId: h.chat.id });
  await sleep(20);
  assert.deepEqual(h.sent(), ['Later']);
});

test('send now, delete; the emergency stop pauses; a removed chat drops its queue; an empty queue forgets its pause', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  h.working();
  let queue = await h.owner.call<PromptQueue>('queue.add', { conversationId: h.chat.id, body: 'A', priority: 'important' });
  queue = await h.owner.call<PromptQueue>('queue.add', { conversationId: h.chat.id, body: 'B' });
  const now = await h.owner.call<{ queue: PromptQueue }>('queue.sendNow', { conversationId: h.chat.id, id: queue.items[1].id });
  assert.deepEqual(bodies(now.queue), ['A']);
  assert.deepEqual(h.sent(), ['B'], 'sent now, into the running work');
  h.f.bus.emit('work.state', { stopped: true, at: h.f.clock.now() });
  assert.equal(h.queues.get(h.chat.id).paused?.reason, 'stop', 'the emergency stop holds every queue');
  queue = await h.owner.call<PromptQueue>('queue.remove', { conversationId: h.chat.id, id: now.queue.items[0].id });
  assert.deepEqual(queue.items, []);
  assert.equal(queue.paused, undefined, 'an empty queue forgets its pause');
  assert.equal((await h.owner.request('queue.remove', { conversationId: h.chat.id, id: 'pq_gone0000000000' })).error?.code, 'not_found');
  assert.equal((await h.owner.request('queue.add', { conversationId: h.chat.id, body: '  ' })).error?.code, 'bad_request');
  await h.owner.call('queue.add', { conversationId: h.chat.id, body: 'C' });
  h.f.bus.emit('conversation.removed', { id: h.chat.id });
  assert.deepEqual(h.queues.get(h.chat.id).items, []);
});

test('restart: the queue is in the database – a new service finds it and goes on once the chat is free', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  const run = h.working();
  for (const body of ['First', 'Second']) await h.owner.call('queue.add', { conversationId: h.chat.id, body });
  for (const off of h.offs.splice(0)) off(); // the app stops
  const again = h.make();
  h.f.services.promptQueue = again;
  assert.deepEqual(bodies(again.get(h.chat.id)), ['First', 'Second'], 'kept across the restart');
  h.f.dispatcher.active = []; // the run did not survive the restart
  h.f.services.runs.finish(run, { status: 'interrupted', endedAt: h.f.clock.now() });
  h.f.db.run('DELETE FROM wakes');
  h.offs.push(again.watch());
  await sleep(20);
  assert.deepEqual(h.sent(), ['First'], 'after the start the top one goes once the chat is free');
  assert.equal(HUMAN_ID, h.f.chats.messages(h.chat.id, { limit: 5 }).find((message) => message.body === 'First')?.authorId, 'as the person');
});
