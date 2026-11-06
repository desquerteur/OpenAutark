// A snoozed to-do's recorded end (waitingOn.until, INT-1) stays in step with its ring: when the
// person pauses, resumes or deletes the snooze schedule through schedules.update/delete (Chat
// details › Scheduled), the end follows – none while paused or gone, the next ring once resumed –
// so the surfaces without schedules.list (offline list, wf CLI) never show a stale
// "Snoozed until …". Other schedules and to-dos that are not snoozed are left alone.
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Schedule, TaskView } from '../../../src/shared/model/tasks.ts';
import { snoozeEnd, snoozedUntil } from '../../../src/shared/model/todo-later.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const M = 60_000;

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const todo = f.tasks.create({
    conversationId: chat.id, title: 'Take the bread out', assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_ava',
    widget: { type: 'timer', label: 'Bread', duration: 'PT5M' },
  });
  const end = f.clock.now() + 30 * M;
  f.tasks.snooze(todo.id, end);
  const ring = f.scheduler.list({ taskId: todo.id }).find((schedule) => schedule.kind === 'timer' && schedule.spec.at === end)!;
  return { ...f, chat, todo, end, ring, owner: new TestClient(f.server, OWNER) };
}

test('pausing, resuming and deleting the snooze ring keeps the recorded end in step', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  assert.ok(f.ring, 'the snooze has its one-shot ring');
  assert.equal(f.tasks.get(f.todo.id)!.waitingOn?.until, f.end, 'the snooze records its end');
  const listed = async () => (await f.owner.call<TaskView[]>('todos.list')).find((todo) => todo.id === f.todo.id)!;

  await f.owner.call<Schedule>('schedules.update', { id: f.ring.id, active: false });
  assert.equal(f.tasks.get(f.todo.id)!.waitingOn?.until, undefined, 'paused: no end to show');
  assert.equal(snoozedUntil(await listed()), undefined);

  await f.owner.call<Schedule>('schedules.update', { id: f.ring.id, active: true });
  const resumed = await listed();
  assert.equal(snoozedUntil(resumed), f.end, 'resumed: it rings at the snooze end again');
  assert.deepEqual([resumed.status, resumed.waitingOn?.reason], ['waiting', 'Snoozed'], 'still snoozed');

  await f.owner.call('schedules.delete', { id: f.ring.id });
  const gone = f.tasks.get(f.todo.id)!;
  assert.equal(gone.waitingOn?.until, undefined, 'deleted: no stale "Snoozed until …"');
  assert.deepEqual([gone.status, gone.waitingOn?.reason], ['waiting', 'Snoozed']);
});

test('other schedules and to-dos that are not snoozed are left as they are', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  await f.owner.call<Schedule>('schedules.update', { id: f.ring.id, active: true }); // records the end
  const rev = f.tasks.get(f.todo.id)!.rev;
  const recap = f.scheduler.create({ ownerId: HUMAN_ID, conversationId: f.chat.id, taskId: f.todo.id, kind: 'message', title: 'Recap', spec: { cron: '0 9 * * 1' }, payload: { body: 'Recap please' } });
  await f.owner.call<Schedule>('schedules.update', { id: recap.id, active: false });
  await f.owner.call('schedules.delete', { id: recap.id });
  assert.equal(f.tasks.get(f.todo.id)!.rev, rev, 'a message schedule does not touch the to-do');
  assert.equal(f.tasks.get(f.todo.id)!.waitingOn?.until, f.end);

  const open = f.tasks.create({ conversationId: f.chat.id, title: 'Water the plants', assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_ava', widget: { type: 'timer', label: 'Plants', duration: 'PT2H' } });
  const ring = f.scheduler.list({ taskId: open.id }).find((schedule) => schedule.kind === 'timer')!;
  const before = f.tasks.get(open.id)!.rev;
  await f.owner.call<Schedule>('schedules.update', { id: ring.id, active: false });
  assert.equal(f.tasks.get(open.id)!.rev, before, 'pausing a to-do\'s own timer ring (not snoozed) changes nothing on it');
});

test('snoozeEnd: the soonest active one-shot timer of the to-do; none while paused', () => {
  const at = Date.UTC(2026, 9, 20, 15, 0, 0);
  const base = { ownerId: HUMAN_ID, conversationId: 'ch_a', kind: 'timer' as const, title: 'Bread', payload: {}, runs: 0, createdAt: at };
  const list = [
    { ...base, id: 'sc_1', taskId: 'todo_x', spec: { at: at + 10 * M }, nextAt: at + 10 * M, active: true },
    { ...base, id: 'sc_2', taskId: 'todo_x', spec: { cron: '0 9 * * *' }, nextAt: at + 5 * M, active: true },
    { ...base, id: 'sc_3', taskId: 'todo_y', spec: { at: at + M }, nextAt: at + M, active: true },
  ] as Schedule[];
  assert.equal(snoozeEnd(list, 'todo_x'), at + 10 * M);
  assert.equal(snoozeEnd(list.map((schedule) => ({ ...schedule, active: false })), 'todo_x'), undefined);
});
