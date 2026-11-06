// B-057 S13 – a task's splits stop with its turns: when the person ends a task (cancel, finish, remove – tasks/owners.ts
// stopRuns) or takes it back ("Give to me" – tasks/human.ts makeMine), SplitService.stop({ taskId }) stops exactly
// the groups split by a turn on that task – running parts aborted on their lanes, waiting ones and a group whose turn
// still runs stopped, no parent wake – while the groups of other tasks and chats run on. An agent's own end of a task,
// or the end of a step of it, stops nothing (like the task's turns).
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { stopRuns } from '../../../src/runtime/tasks/owners.ts';
import { makeMine } from '../../../src/runtime/tasks/human.ts';
import { quickCreate } from '../../../src/runtime/tasks/quick.ts';
import type { RuntimeServices, SplitService } from '../../../src/runtime/contracts.ts';
import type { TaskServiceImpl } from '../../../src/runtime/tasks/service.ts';
import type { Task } from '../../../src/shared/model/tasks.ts';
import { agent, harness } from '../chat/harness.ts';
import { part, world, type World } from './fixture.ts';

/** Four groups: two split on task_A (one still waiting for its turn's end), one on task_B, one in a chat. */
function groups(w: World) {
  const onTask = (agentId: string, runId: string, taskId: string, title: string, end = true) => {
    const view = w.splits.create(w.ctx({ agentId, runId, taskId, thread: taskId, conversationId: undefined }), { goal: `Work on ${taskId}`, parts: [part(`${title} 1`), part(`${title} 2`, { after: [1] })] });
    if (end) w.splits.afterParentTurn(runId, 'done');
    return view.id;
  };
  const a = onTask('ag_ava', 'run_a', 'task_A', 'A');
  const b = onTask('ag_ava', 'run_b', 'task_B', 'B');
  const waiting = onTask('ag_ben', 'run_a2', 'task_A', 'A again', false);
  const chat = w.splits.create(w.ctx({ agentId: 'ag_ben', runId: 'run_chat' }), { goal: 'Chat work', parts: [part('C')] }).id;
  w.splits.afterParentTurn('run_chat', 'done');
  return { a, b, waiting, chat };
}

const statusOf = (w: World, groupId: string) => w.splits.list({ groupId })[0]?.status;

test('stop({ taskId }) stops exactly the groups split on that task; other tasks and chats run on', () => {
  const w = world();
  const g = groups(w);
  const running = (groupId: string) => w.splits.list({ groupId })[0].splits.filter((split) => split.status === 'running').map((split) => split.id);
  const aRunning = running(g.a);
  assert.equal(aRunning.length, 1, 'part 1 runs, part 2 waits for it');
  assert.equal(w.splits.stop({ taskId: '' }, HUMAN_ID), 0, 'an empty task id is no wildcard');
  assert.equal(w.splits.stop({ taskId: 'task_none' }, HUMAN_ID), 0);
  assert.equal(w.splits.stop({ taskId: 'task_A' }, HUMAN_ID), 4, 'both parts of each task_A group');
  assert.deepEqual(w.lanes.stopped, aRunning.map((splitId) => ({ splitId, why: 'human' })), 'the running part is aborted on its lane');
  assert.equal(statusOf(w, g.a), 'stopped');
  assert.equal(statusOf(w, g.waiting), 'stopped', 'a group whose turn still runs never starts');
  assert.ok(w.splits.list({ groupId: g.a })[0].splits.every((split) => split.status === 'stopped' && split.error === 'Stopped by the person.'));
  assert.equal(statusOf(w, g.b), 'running', 'another task\'s group runs on');
  assert.equal(statusOf(w, g.chat), 'running', 'a chat\'s group runs on');
  w.splits.afterParentTurn('run_a2', 'done');
  assert.equal(statusOf(w, g.waiting), 'stopped', 'its turn\'s end does not start it');
  w.lanes.end(aRunning[0], 'stopped');
  assert.equal(w.wakes.list('ag_ava').length, 0, 'the person ended the task: nobody is woken for its splits');
});

test('tasks/owners.ts stopRuns: the person ending a task stops its splits; an agent\'s end or a step\'s end stops nothing', () => {
  const w = world();
  const g = groups(w);
  const t = { s: w.services } as unknown as TaskServiceImpl;
  const task = (over: Partial<Task> = {}) => ({ id: 'task_A', ...over }) as Task;
  stopRuns(t, task(), 'ag_ava');
  stopRuns(t, task({ parentId: 'task_parent' }), HUMAN_ID);
  assert.equal(statusOf(w, g.a), 'running', 'the agent finished its own task, or a step ended: its splits go on');
  stopRuns(t, task(), HUMAN_ID);
  assert.deepEqual([statusOf(w, g.a), statusOf(w, g.waiting), statusOf(w, g.b), statusOf(w, g.chat)], ['stopped', 'stopped', 'running', 'running']);
  // A failing split service never breaks the task's end.
  const broken = { s: { ...w.services, splits: { stop: () => { throw new Error('db gone'); } } } } as unknown as TaskServiceImpl;
  assert.doesNotThrow(() => stopRuns(broken, task({ id: 'task_B' }), HUMAN_ID));
});

test('the person cancelling a task and "Give to me" both stop that task\'s splits (tasks/lifecycle.ts, tasks/human.ts)', () => {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager', createdAt: 1 }));
  const services = h.services as RuntimeServices;
  const stops: Array<{ q: Parameters<SplitService['stop']>[0]; by: string }> = [];
  services.splits = { stop: (q, by) => { stops.push({ q, by }); return 0; } } as SplitService;
  Object.assign(services.dispatcher, { interrupt: async () => {} });

  const cancelled = quickCreate(services, { text: 'Write the newsletter for Friday' }, HUMAN_ID).task;
  stops.length = 0;
  h.tasks.setStatus(cancelled.id, 'cancelled', HUMAN_ID);
  assert.deepEqual(stops, [{ q: { taskId: cancelled.id }, by: HUMAN_ID }]);

  const taken = quickCreate(services, { text: 'Draft a blog post about the launch' }, HUMAN_ID).task;
  stops.length = 0;
  makeMine(services, taken.id);
  assert.deepEqual(stops, [{ q: { taskId: taken.id }, by: HUMAN_ID }]);

  // A failing split service never fails "Give to me".
  services.splits = { stop: () => { throw new Error('db gone'); } } as unknown as SplitService;
  const other = quickCreate(services, { text: 'Draft the summer post' }, HUMAN_ID).task;
  assert.equal(makeMine(services, other.id).assigneeKind, 'human');
});
