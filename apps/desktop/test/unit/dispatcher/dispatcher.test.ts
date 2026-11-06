import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import { compareGroups, defaultMaxConcurrent, groupWakes, nextUtcMonthStart } from '../../../src/runtime/agents/dispatch-groups.ts';
import { flush, openWakes, setup } from './fakes.ts';

function withAgents(options: { maxConcurrent?: number } = {}) {
  const h = setup(options);
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  h.org.add(agent('ag_max', 'Max'));
  return h;
}

test('immediate wakes reach the dispatcher without polling; one turn per agent at a time', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'first', authorId: 'human' });
  h.clock.advance(1000);
  h.chats.send({ conversationId: b.id, body: 'second', authorId: 'human' });
  await flush(); // no scheduler timer is fired: due wakes are announced in a microtask batch
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.last().request.conversationId, a.id);
  assert.equal(h.executor.last().request.reason, 'message');
  // The other chat's wake was released, not lost.
  assert.deepEqual(openWakes(h.db).map((row) => [row.conversation_id, row.claimed_at !== null]), [[a.id, true], [b.id, false]]);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2);
  assert.equal(h.executor.last().request.conversationId, b.id);
  assert.equal(h.executor.maxRunning, 1);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2);
  assert.equal(openWakes(h.db).length, 0);
});

test('global cap: agents wait in a FIFO; a finishing agent queues behind the waiting ones', async () => {
  const h = withAgents({ maxConcurrent: 1 });
  const chats = ['ag_tom', 'ag_lea', 'ag_max'].map((id) => h.chats.create({ agentIds: [id], createdBy: 'human' }));
  h.dispatcher.start();
  for (const chat of chats) { h.chats.send({ conversationId: chat.id, body: 'go', authorId: 'human' }); h.clock.advance(10); }
  await flush();
  assert.deepEqual(h.executor.calls.map((call) => call.request.agentId), ['ag_tom']);
  // Tom gets more work while running; Lea and Max waited longer.
  h.chats.send({ conversationId: chats[0].id, body: 'and this', authorId: 'human' });
  await flush();
  for (let i = 0; i < 3; i++) { h.executor.last().finish(); await flush(); }
  assert.deepEqual(h.executor.calls.map((call) => call.request.agentId), ['ag_tom', 'ag_lea', 'ag_max', 'ag_tom']);
  assert.equal(h.executor.maxRunning, 1);
});

test('global cap: an important message moves its agent to the front of the FIFO', async () => {
  const h = withAgents({ maxConcurrent: 1 });
  const chats = ['ag_tom', 'ag_lea', 'ag_max'].map((id) => h.chats.create({ agentIds: [id], createdBy: 'human' }));
  h.dispatcher.start();
  h.chats.send({ conversationId: chats[0].id, body: 'go', authorId: 'human' });
  h.chats.send({ conversationId: chats[1].id, body: 'go', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: chats[2].id, body: 'now please', authorId: 'human', priority: 'important' });
  await flush();
  for (let i = 0; i < 2; i++) { h.executor.last().finish(); await flush(); }
  assert.deepEqual(h.executor.calls.map((call) => call.request.agentId), ['ag_tom', 'ag_max', 'ag_lea']);
  assert.equal(h.executor.calls[0].request.signal.aborted, false, 'other agents are not interrupted');
});

test('groups by chat/task: the most important group runs first, the others are released', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: a.id, body: 'hello', authorId: 'human' }); // message wake for chat A
  h.clock.advance(1000);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'schedule', conversationId: a.id, taskId: 'task_x', note: 'Check the upload' });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'answer', conversationId: 'ch_other', note: '[ui-answer] yes' });
  h.dispatcher.start();
  await flush();
  const first = h.executor.last().request;
  assert.equal(first.reason, 'answer');
  assert.equal(first.conversationId, 'ch_other');
  assert.deepEqual(first.notes, [{ text: '[ui-answer] yes', at: h.clock.now(), reason: 'answer' }]);
  assert.equal(first.control.lastSeq, 0);
  assert.equal(typeof first.admit, 'function');
  const open = openWakes(h.db).filter((row) => row.claimed_at === null);
  assert.equal(open.length, 2, 'message and schedule groups wait unclaimed');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.reason, 'message');
  assert.equal(h.executor.last().request.taskId, undefined);
  h.executor.last().finish();
  await flush();
  const third = h.executor.last().request;
  assert.equal(third.reason, 'schedule');
  assert.equal(third.taskId, 'task_x');
  assert.deepEqual(third.notes.map((note) => note.text), ['Check the upload']);
  third.signal.throwIfAborted();
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 3);
});

test('status, activity and keep-awake follow the run; wakes are done afterwards', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'build it', authorId: 'human' });
  await flush();
  const { request } = h.executor.last();
  assert.equal(h.org.get('ag_tom')!.status, 'working');
  assert.equal(h.awake.acquired, 1);
  request.onStatus!('running tests');
  assert.deepEqual(h.dispatcher.activity().map((item) => [item.agentId, item.conversationId, item.note, item.runId]), [['ag_tom', a.id, 'running tests', request.runId]]);
  assert.equal(h.org.get('ag_tom')!.statusNote, 'running tests');
  const events = h.of('agent.activity');
  assert.ok(events.some((event) => event.active.some((item) => item.agentId === 'ag_tom')));
  h.executor.last().finish();
  await flush();
  assert.equal(h.org.get('ag_tom')!.status, 'idle');
  assert.deepEqual(h.dispatcher.activity(), []);
  assert.deepEqual(h.of('agent.activity').at(-1), { active: [] });
  assert.equal(h.awake.released, 1);
  assert.equal(openWakes(h.db).length, 0);
});

test('interrupt aborts only the matching running turn; its wakes are finished', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'long job', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  await h.dispatcher.interrupt('ag_tom', 'ch_elsewhere');
  assert.equal(call.request.signal.aborted, false);
  await h.dispatcher.interrupt('ag_tom', a.id);
  assert.equal(call.request.signal.aborted, true);
  assert.equal(call.done, true);
  await flush();
  assert.deepEqual(h.dispatcher.activity(), []);
  assert.equal(openWakes(h.db).length, 0);
  assert.equal(h.executor.calls.length, 1, 'a stopped turn is not re-run');
});

test('urgent with steer: unseen lines are steered into the running turn, no abort, no extra turn', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  const first = h.chats.send({ conversationId: a.id, body: 'make the intro', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  const steered: Array<{ runId: string; text: string }> = [];
  call.request.control.engine = { steer: async (runId: string, text: string) => { steered.push({ runId, text }); return true; } } as unknown as Engine;
  call.request.control.lastSeq = first.seq;
  const urgent = h.chats.send({ conversationId: a.id, body: 'Use the blue logo!', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(steered.length, 1);
  assert.equal(steered[0].runId, call.request.runId);
  assert.match(steered[0].text, /^\[\d\d:\d\d\] Lena: \(important\) Use the blue logo!$/m, 'in the delta form');
  assert.doesNotMatch(steered[0].text, /make the intro/);
  assert.equal(call.request.control.steeredSeq, urgent.seq);
  assert.equal(call.request.signal.aborted, false);
  assert.ok(h.runItems.some((item) => item.kind === 'note' && 'steered' in item.data));
  // turn-finish advances the cursor to max(lastSeq, steeredSeq); the pending message wake is stale.
  h.chats.markRead(a.id, 'ag_tom', call.request.control.steeredSeq);
  call.finish();
  await flush();
  assert.equal(h.executor.calls.length, 1);
  assert.equal(openWakes(h.db).length, 0);
});

test('urgent without steer: the running turn is interrupted, keeps its wakes, and the urgent chat runs next', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: b.id, body: 'long research', authorId: 'human' });
  await flush();
  const running = h.executor.last();
  assert.equal(running.request.conversationId, b.id);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'answer', conversationId: 'ch_c', note: 'answer' });
  h.clock.advance(1000);
  h.chats.send({ conversationId: a.id, body: 'Stop, call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(running.request.signal.aborted, true);
  assert.deepEqual(h.executor.calls.map((call) => call.request.conversationId), [b.id, a.id]);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, 'ch_c');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.conversationId, b.id, 'the interrupted work resumes');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 4);
  assert.equal(openWakes(h.db).length, 0);
});

test('stop(): stops pumping, aborts running turns and hands their wakes back to the queue', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'work', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  await h.dispatcher.stop();
  assert.equal(call.request.signal.aborted, true);
  assert.deepEqual(openWakes(h.db).map((row) => [row.conversation_id, row.claimed_at]), [[a.id, null]]);
  h.chats.send({ conversationId: a.id, body: 'more', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1);
  // Restart picks the kept wake up again.
  h.dispatcher.start();
  await flush();
  assert.equal(h.executor.calls.length, 2);
  await h.dispatcher.stop();
});

test('paused agents keep their wakes until un-paused; archived agents lose them', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.org.get('ag_tom')!.status = 'paused';
  h.org.get('ag_lea')!.archivedAt = h.clock.now();
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'hi', authorId: 'human' });
  h.chats.send({ conversationId: b.id, body: 'hi', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 0);
  assert.deepEqual(openWakes(h.db).map((row) => [row.agent_id, row.claimed_at]), [['ag_tom', null]]);
  h.org.setStatus('ag_tom', 'idle');
  await flush();
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.last().request.agentId, 'ag_tom');
});

test('a crashing executor closes the run, finishes the wakes and the agent continues', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.executor.throwNext = true;
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'x', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 0);
  assert.equal(openWakes(h.db).length, 0);
  assert.equal(h.org.get('ag_tom')!.status, 'idle');
  h.chats.send({ conversationId: a.id, body: 'again', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1);
});

test('pure rules: grouping, ordering, capacity default', () => {
  const base = { agentId: 'ag', dueAt: 10, createdAt: 10, attempts: 1 };
  const groups = groupWakes([
    { ...base, id: 'w1', reason: 'retry', conversationId: 'c1', taskId: 't1' },
    { ...base, id: 'w2', reason: 'task', conversationId: 'c1', taskId: 't1', dueAt: 5 },
    { ...base, id: 'w3', reason: 'message', conversationId: 'c2' },
    { ...base, id: 'w4', reason: 'handoff', conversationId: 'c3' },
  ]);
  assert.equal(groups.length, 3);
  const task = groups.find((group) => group.taskId === 't1')!;
  assert.equal(task.reason, 'task');
  assert.equal(task.dueAt, 5);
  const sorted = [...groups].sort((x, y) => compareGroups(x, y));
  assert.deepEqual(sorted.map((group) => group.conversationId), ['c3', 'c2', 'c1']);
  const urgentFirst = [...groups].sort((x, y) => compareGroups(x, y, 'c1'));
  assert.equal(urgentFirst[0].conversationId, 'c1');
  assert.equal(defaultMaxConcurrent(1), 2);
  assert.equal(defaultMaxConcurrent(6), 4);
  assert.equal(defaultMaxConcurrent(32), 6);
});

test('urgent under a full global cap: the interrupted agent keeps its slot for the urgent chat', async () => {
  const h = withAgents({ maxConcurrent: 1 });
  const research = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const call = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const lea = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: research.id, body: 'long research', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: lea.id, body: 'go', authorId: 'human' }); // Lea waits for the slot
  await flush();
  h.chats.send({ conversationId: call.id, body: 'Call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(h.executor.calls[0].request.signal.aborted, true);
  assert.deepEqual(h.executor.calls.map((item) => [item.request.agentId, item.request.conversationId]), [['ag_tom', research.id], ['ag_tom', call.id]]);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.agentId, 'ag_lea', 'then the agent that waited');
  h.executor.last().finish();
  await flush();
  assert.deepEqual([h.executor.last().request.agentId, h.executor.last().request.conversationId], ['ag_tom', research.id]);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.maxRunning, 1);
  assert.equal(openWakes(h.db).length, 0);
});

test('an abort that arrives after the turn finished its work does not hand the wakes back', async () => {
  const h = withAgents();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'schedule', note: 'Post the weekly report' });
  h.dispatcher.start();
  await flush();
  h.executor.last().finish(); // the work is done …
  await h.dispatcher.stop(); // … and the shutdown abort lands before the dispatcher saw the outcome
  assert.equal(openWakes(h.db).length, 0, 'finished work is not re-run after the restart');
});

test('setPaused holds new turns; resuming keeps the FIFO order of waiting agents', async () => {
  const h = withAgents({ maxConcurrent: 1 });
  const [tom, lea, max] = ['ag_tom', 'ag_lea', 'ag_max'].map((id) => h.chats.create({ agentIds: [id], createdBy: 'human' }));
  h.dispatcher.start();
  h.chats.send({ conversationId: tom.id, body: 'go', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: max.id, body: 'go', authorId: 'human' });
  await flush();
  h.chats.send({ conversationId: lea.id, body: 'go', authorId: 'human' });
  await flush();
  h.dispatcher.setPaused(true);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no new turn while paused');
  h.dispatcher.setPaused(false);
  await flush();
  assert.equal(h.executor.last().request.agentId, 'ag_max', 'the agent that waited longest goes first');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.last().request.agentId, 'ag_lea');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 3);
});

test('every abort names its kind: Stop and runs.cancel are the human, an important message is urgent, stop() is a shutdown', async () => {
  const h = withAgents();
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const c = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'long job', authorId: 'human' });
  await flush();
  const stopped = h.executor.last();
  await h.dispatcher.interrupt('ag_tom', a.id);
  assert.equal(stopped.request.control.stopKind, 'human');

  h.chats.send({ conversationId: b.id, body: 'research', authorId: 'human' });
  await flush();
  const cancelled = h.executor.last();
  assert.equal(await h.dispatcher.cancelRun(cancelled.request.runId), true);
  assert.equal(cancelled.request.control.stopKind, 'human');

  h.chats.send({ conversationId: b.id, body: 'more research', authorId: 'human' });
  await flush();
  const overtaken = h.executor.last();
  h.chats.send({ conversationId: a.id, body: 'Call me now', authorId: 'human', priority: 'important' });
  await flush();
  assert.equal(overtaken.request.control.stopKind, 'urgent');
  assert.equal(h.executor.last().request.control.stopKind, undefined, 'the urgent turn itself runs');

  h.chats.send({ conversationId: c.id, body: 'write', authorId: 'human' });
  await flush();
  const lea = h.executor.calls.find((call) => call.request.agentId === 'ag_lea' && !call.done)!;
  const tom = h.executor.calls.find((call) => call.request.agentId === 'ag_tom' && !call.done)!;
  await h.dispatcher.interrupt('ag_tom'); // the first abort decides the kind …
  await h.dispatcher.stop();
  assert.equal(tom.request.control.stopKind, 'human', '… a later shutdown does not change it');
  assert.equal(lea.request.control.stopKind, 'shutdown');
});

test('the human cancelling a task interrupts the turn running on it (human stop); an agent cancelling does not', async () => {
  const h = withAgents();
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  h.dispatcher.start();
  const task = h.tasks.create({ conversationId: chat.id, title: 'Cut the trailer', assigneeId: 'ag_tom', createdBy: 'human' });
  await flush();
  const call = h.executor.last();
  assert.equal(call.request.taskId, task.id);
  assert.deepEqual(h.dispatcher.activity().map((item) => item.taskId), [task.id]);
  const other = h.tasks.create({ conversationId: chat.id, title: 'Write the post', assigneeId: 'ag_lea', createdBy: 'human' });
  await flush();
  const leaCall = h.executor.last();
  h.tasks.setStatus(other.id, 'cancelled', 'ag_tom');
  assert.equal(leaCall.request.signal.aborted, false, 'an agent cancelling never aborts another turn');

  h.tasks.setStatus(task.id, 'cancelled', 'human');
  assert.equal(call.request.signal.aborted, true);
  assert.equal(call.request.control.stopKind, 'human');
  await flush();
  assert.equal(h.dispatcher.activity().some((item) => item.taskId === task.id), false);
  leaCall.finish();
  await flush();
});
