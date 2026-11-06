// Advanced schedule options end to end in the runtime (T11) against the real chat/task/schedule
// services and RPC table: messages.schedule with Important (posted as important, the agent is
// steered) and Post as task (a routine posting a team task with steps and High priority each
// time; refused without the 'tasks' tier), schedules.preview (next three runs, window, skips,
// maxRuns with runs made, a late one-off, never, refusals), schedules.update rewording only the
// person's own message and task posts (agents' schedules keep their words; timing still
// changes), the schedules.message tool's urgent flag, and task templates kept within
// tasks.create's limits (task posts refused when scheduled, stored routine templates bounded
// at every run, the schedules.routine tool's nested task schema).
// Owns: these assertions only. Never: real timers, network or a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import { localParts } from '../../../src/runtime/schedules/spec.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';

const MIN = 60_000;
const H = 60 * MIN;
const CHAT_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_chat', capabilities: ['todo', 'chat'] };
const TODO_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_todo', capabilities: ['todo'] };

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const now = f.clock.now();
  return { ...f, chat, now, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('messages.schedule: Important is posted as important and steers the agent', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const schedule = await f.phone.call<Schedule>('messages.schedule', {
    conversationId: f.chat.id, body: 'Status please @Ava', spec: { at: f.now + H }, mentions: ['ag_ava'], priority: 'important',
  });
  assert.equal(schedule.kind, 'message');
  assert.deepEqual(schedule.payload, { body: 'Status please @Ava', mentions: ['ag_ava'], priority: 'important' });
  const normal = await f.phone.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Later', spec: { at: f.now + H }, priority: 'normal' });
  assert.deepEqual(normal.payload, { body: 'Later' }, "'normal' stores nothing extra");
  f.scheduler.start();
  f.clock.advance(H);
  f.timers.fire();
  const posted = f.chats.messages(f.chat.id).find((message) => message.kind === 'text' && message.body === 'Status please @Ava');
  assert.equal(posted?.priority, 'important');
  assert.equal(posted?.authorKind, 'human');
  assert.equal(posted?.meta.via, 'schedule');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(f.dispatcher.urgents.some((entry) => entry.agentId === 'ag_ava' && entry.conversationId === f.chat.id), 'the important post steers Ava');
  assert.equal((await f.phone.request('messages.schedule', { conversationId: f.chat.id, body: 'x', spec: { at: f.now + H }, priority: 'urgent' })).error?.code, 'bad_request');
});

test('messages.schedule asTask: every run posts a team task with steps and High priority', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const body = 'Check the video comments\n- Answer questions\n- Flag spam\nKeep it friendly.';
  const schedule = await f.phone.call<Schedule>('messages.schedule', {
    conversationId: f.chat.id, body, spec: { everyMs: 53 * MIN, at: f.now + H }, asTask: true, priority: 'important',
  });
  assert.equal(schedule.kind, 'routine');
  assert.equal(schedule.ownerId, 'human');
  assert.equal(schedule.title, 'Check the video comments');
  assert.deepEqual(schedule.payload, {
    body, priority: 'important',
    taskTemplate: { title: 'Check the video comments', notes: 'Keep it friendly.', steps: ['Answer questions', 'Flag spam'] },
  });
  f.scheduler.start();
  f.clock.advance(H);
  f.timers.fire();
  f.clock.advance(53 * MIN);
  f.timers.fire();
  const posted = f.tasks.list({ conversationId: f.chat.id }).filter((task) => task.title === 'Check the video comments');
  assert.equal(posted.length, 2, 'one task per run');
  for (const task of posted) {
    assert.equal(task.assigneeKind, 'team');
    assert.equal(task.createdBy, 'human');
    assert.equal(task.priority, 1, 'Important → High');
    assert.equal(task.notes, 'Keep it friendly.');
    assert.deepEqual(task.steps.map((step) => step.title), ['Answer questions', 'Flag spam']);
    assert.ok(task.messageId, 'anchored by a task post in the chat');
  }
  assert.equal(f.chats.messages(f.chat.id).filter((message) => message.kind === 'task' && message.authorId === 'human').length, 2);
  assert.equal(f.scheduler.get(schedule.id)?.runs, 2);
  // Team work needs the 'tasks' tier, like tasks.create; plain scheduled messages do not.
  const chatOnly = new TestClient(f.server, CHAT_ONLY);
  assert.equal((await chatOnly.request('messages.schedule', { conversationId: f.chat.id, body, spec: { at: f.now + 3 * H }, asTask: true })).error?.code, 'forbidden');
  assert.equal((await chatOnly.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Plain', spec: { at: f.now + 3 * H } })).kind, 'message');
});

test('schedules.preview: the next runs as the scheduler takes them', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const at = f.now + H;
  const preview = (params: unknown, client = f.phone) => client.call<{ times: number[] }>('schedules.preview', params).then((result) => result.times);
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at } }), [at, at + 53 * MIN, at + 106 * MIN]);
  assert.equal((await preview({ spec: { everyMs: 53 * MIN, at }, count: 5 })).length, 5);
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at, maxRuns: 4 }, runs: 3 }), [at], 'maxRuns counts the runs already made');
  assert.deepEqual(await preview({ spec: { everyMs: 53 * MIN, at, maxRuns: 2 }, runs: 2 }), []);
  const windowed = await preview({ spec: { everyMs: 53 * MIN, at, tz: 'UTC', window: { from: '10:00', to: '11:00' } }, count: 4 });
  assert.equal(windowed.length, 4);
  for (const time of windowed) assert.ok(localParts(time, 'UTC').minutes >= 600 && localParts(time, 'UTC').minutes < 660, new Date(time).toISOString());
  const day = localParts(at, 'UTC').date;
  const skipped = await preview({ spec: { cron: '0 10 * * *', tz: 'UTC', except: [day] } });
  assert.ok(skipped.every((time) => localParts(time, 'UTC').date !== day) && skipped.length === 3);
  assert.deepEqual(await preview({ spec: { at: f.now - MIN } }), [f.now - MIN], 'a missed one-off still runs once, late');
  assert.deepEqual(await preview({ spec: { at, tz: 'UTC', except: [day] } }), [], 'never runs');
  assert.equal((await f.phone.request('schedules.preview', { spec: { everyMs: 5 } })).error?.code, 'bad_request');
  assert.equal((await f.phone.request('schedules.preview', {})).error?.code, 'bad_request');
  assert.equal((await f.phone.request('schedules.preview', { spec: { at }, count: 11 })).error?.code, 'bad_request');
  assert.equal((await new TestClient(f.server, CHAT_ONLY).request('schedules.preview', { spec: { at } })).error, undefined, 'the chat tier may preview');
  assert.equal((await new TestClient(f.server, TODO_ONLY).request('schedules.preview', { spec: { at } })).error?.code, 'forbidden');
});

test("schedules.update rewords the person's own posts; an agent's schedule keeps its words", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const message = await f.owner.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Recap @Ava', spec: { at: f.now + H }, mentions: ['ag_ava'] });
  const reworded = await f.owner.call<Schedule>('schedules.update', { id: message.id, body: 'Weekly recap', priority: 'important', mentions: [], spec: { cron: '0 9 * * 1', tz: 'UTC' } });
  assert.equal(reworded.title, 'Weekly recap');
  assert.deepEqual(f.scheduler.get(message.id)!.payload, { body: 'Weekly recap', priority: 'important' }, 'mentions dropped with the new text');
  assert.equal(reworded.spec.cron, '0 9 * * 1');
  assert.ok(reworded.nextAt! > f.now);
  await f.owner.call<Schedule>('schedules.update', { id: message.id, priority: 'normal' });
  assert.deepEqual(f.scheduler.get(message.id)!.payload, { body: 'Weekly recap' });

  const post = await f.owner.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Review drafts\n- Intro', spec: { at: f.now + H }, asTask: true });
  const rewordedPost = await f.owner.call<Schedule>('schedules.update', { id: post.id, body: 'Review the final cut\n- Audio\n- Colour' });
  assert.equal(rewordedPost.kind, 'routine', 'the kind stays');
  assert.equal(rewordedPost.title, 'Review the final cut');
  assert.deepEqual(rewordedPost.payload.taskTemplate, { title: 'Review the final cut', steps: ['Audio', 'Colour'] });

  const agents = f.scheduler.create({ ownerId: 'ag_ava', conversationId: f.chat.id, kind: 'message', title: 'Daily standup', spec: { cron: '0 9 * * *', tz: 'UTC' }, payload: { body: 'Standup!' } });
  assert.equal((await f.owner.request('schedules.update', { id: agents.id, body: 'Something else' })).error?.code, 'forbidden');
  assert.equal((await f.owner.request('schedules.update', { id: agents.id, priority: 'important' })).error?.code, 'forbidden');
  const retimed = await f.owner.call<Schedule>('schedules.update', { id: agents.id, spec: { cron: '30 9 * * 1-5', tz: 'UTC' } });
  assert.equal(retimed.spec.cron, '30 9 * * 1-5', 'timing of an agent schedule may change');
  assert.deepEqual(retimed.payload, { body: 'Standup!' });
  const timer = f.scheduler.create({ ownerId: 'human', conversationId: f.chat.id, kind: 'timer', title: 'Tea', spec: { at: f.now + H }, payload: {} });
  assert.equal((await f.owner.request('schedules.update', { id: timer.id, body: 'Coffee' })).error?.code, 'bad_request');
  assert.equal((await f.phone.request('schedules.update', { id: message.id, body: 'x' })).error?.code, 'forbidden', "rewording needs 'manage'");
  assert.equal((await f.owner.request('schedules.update', { id: message.id, colour: 'red' })).error?.code, 'bad_request');
});

test('schedules.message tool: urgent schedules an important post', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const ctx = { agent: f.org.get('ag_ava'), runId: 'run_1', conversationId: f.chat.id, mode: 'general', services: f.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const tool = (name: string) => scheduleTools.find((entry) => entry.name === name)!;
  const urgent = await tool('schedules.message').run({ text: 'Render finished – please check', when: { once: '+1h' }, urgent: true }, ctx);
  assert.ok(!urgent.isError, JSON.stringify(urgent.content));
  const plain = await tool('schedules.message').run({ text: 'Weekly numbers', when: { repeat: { cron: '0 9 * * 1' } } }, ctx);
  const [important, normal] = [urgent, plain].map((output) => f.scheduler.get((output.structured as { scheduleId: string }).scheduleId)!);
  assert.equal(important.payload.priority, 'important');
  assert.equal(normal.payload.priority, undefined);
  f.scheduler.runNow(important.id);
  const posted = f.chats.messages(f.chat.id).find((message) => message.kind === 'text' && message.body === 'Render finished – please check');
  assert.equal(posted?.priority, 'important');
  assert.equal(posted?.authorId, 'ag_ava');
  const listed = await tool('schedules.list').run({ mine: true }, ctx);
  assert.match(String((listed.content[0] as { text: string }).text), /\[message, important\] Render finished/);
});

test('routines: stored task templates are bounded at every run; task posts keep the limits of tasks.create', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const routine = (taskTemplate: unknown) => f.scheduler.create({
    ownerId: 'ag_ava', conversationId: f.chat.id, kind: 'routine', title: 'Comments', spec: { at: f.now + H },
    payload: { taskTemplate: taskTemplate as Schedule['payload']['taskTemplate'] },
  });
  const byTitle = (title: string) => f.tasks.list({ conversationId: f.chat.id }).find((task) => task.title === title && !task.parentId);
  f.scheduler.runNow(routine({ title: 'Answer comments', steps: 'abc' }).id);
  assert.deepEqual(byTitle('Answer comments')?.steps, [], 'a non-array steps value no longer breaks every run');
  const flood = Array.from({ length: 5000 }, (_, i) => `Step ${i}`);
  f.scheduler.runNow(routine({ title: 'x'.repeat(1000), notes: 7, steps: [42, '  ', 'z'.repeat(400), ...flood] }).id);
  const bounded = byTitle('x'.repeat(300));
  assert.ok(bounded, 'the title is cut to 300 characters');
  assert.equal(bounded.notes, '');
  assert.equal(bounded.steps.length, 100, 'at most 100 steps per run');
  assert.equal(bounded.steps[0].title, 'z'.repeat(300));
  f.scheduler.runNow(routine(undefined).id);
  assert.ok(byTitle('Comments'), 'no template: the schedule title');

  const tool = scheduleTools.find((entry) => entry.name === 'schedules.routine')!;
  const routineArgs = (task: unknown) => validate({ title: 'Comments', task, when: { once: '+1h' } }, tool.inputSchema);
  assert.deepEqual(routineArgs({ title: 'Comments', steps: ['Answer', 'Flag spam'] }), []);
  for (const task of [{ title: 'C', steps: 'abc' }, { title: 'C', steps: Array(51).fill('a') }, { title: 'C', steps: ['y'.repeat(301)] }, { title: 'x'.repeat(301) }, { title: 'C', extra: 1 }]) {
    assert.ok(routineArgs(task).length > 0, JSON.stringify(task).slice(0, 60));
  }

  const schedulePost = (body: string) => f.owner.request('messages.schedule', { conversationId: f.chat.id, body, spec: { at: f.now + 2 * H }, asTask: true });
  const manySteps = ['Many steps', ...Array.from({ length: 101 }, (_, i) => `- Step ${i}`)].join('\n');
  for (const body of ['x'.repeat(301), manySteps, `Title\n- ${'y'.repeat(301)}`]) {
    assert.equal((await schedulePost(body)).error?.code, 'bad_request', body.slice(0, 40));
  }
  assert.equal((await f.owner.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'x'.repeat(301), spec: { at: f.now + 2 * H } })).kind, 'message', 'a plain message has no task limits');
  const post = await f.owner.call<Schedule>('messages.schedule', { conversationId: f.chat.id, body: 'Review drafts', spec: { at: f.now + 2 * H }, asTask: true });
  assert.equal((await f.owner.request('schedules.update', { id: post.id, body: 'x'.repeat(301) })).error?.code, 'bad_request', 'also when reworded');
});
