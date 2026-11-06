// Tests for the scheduler's single timer (src/runtime/schedules/scheduler.ts): it is armed for
// the earliest due schedule or future wake, re-armed on every change, absent when nothing is
// due, capped below the setTimeout overflow, and resumed by power events. Due wakes reach the
// dispatcher through onDueWakes. Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { MAX_TIMER_MS, SchedulerImpl } from '../../../src/runtime/schedules/scheduler.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const due: string[][] = [];
  h.scheduler.onDueWakes(ids => due.push(ids));
  const reminder = (at: number, title = 'Check') =>
    h.scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title, spec: { at }, payload: { note: title } });
  return { ...h, chat, due, reminder };
}

test('no timer when nothing is due', () => {
  const h = setup();
  h.scheduler.start();
  assert.equal(h.timers.pending.length, 0);
});

test('one timer for the earliest schedule; re-armed on create, update and remove', () => {
  const h = setup();
  h.scheduler.start();
  const late = h.reminder(h.clock.now() + H);
  assert.equal(h.timers.only().ms, H);
  const early = h.reminder(h.clock.now() + 30 * M);
  assert.equal(h.timers.only().ms, 30 * M, 'still one timer, now for the earlier one');
  h.scheduler.remove(early.id);
  assert.equal(h.timers.only().ms, H);
  h.scheduler.update(late.id, { spec: { at: h.clock.now() + 2 * H } });
  assert.equal(h.timers.only().ms, 2 * H);
  h.scheduler.update(late.id, { active: false });
  assert.equal(h.timers.pending.length, 0, 'paused schedules do not arm the timer');
  h.scheduler.update(late.id, { active: true });
  assert.equal(h.timers.only().ms, 2 * H);
});

test('the timer fires the due schedule and re-arms for the next one', () => {
  const h = setup();
  h.scheduler.start();
  const first = h.reminder(h.clock.now() + 10 * M, 'First');
  h.reminder(h.clock.now() + 40 * M, 'Second');
  h.clock.advance(10 * M);
  h.timers.fire();
  assert.deepEqual(h.wakeRows().map(w => w.note), ['First']);
  assert.equal(h.scheduler.get(first.id)!.active, false, 'a one-off is done after firing');
  assert.equal(h.timers.only().ms, 30 * M);
});

test('a future wake arms the same timer; it is announced when it becomes due', async () => {
  const h = setup();
  h.scheduler.start();
  h.reminder(h.clock.now() + H);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'retry', taskId: 'task_1', dueAt: h.clock.now() + 10 * M });
  assert.equal(h.timers.only().ms, 10 * M, 'the wake is earlier than the schedule');
  await flush();
  assert.deepEqual(h.due, [], 'not due yet');
  h.clock.advance(10 * M);
  h.timers.fire();
  await flush();
  assert.deepEqual(h.due, [['ag_tom']]);
  assert.equal(h.timers.only().ms, 50 * M, 'back to the schedule');
});

test('wakes due now are announced at once in one microtask batch (no timer)', async () => {
  const h = setup();
  h.scheduler.start();
  h.org.add(agent('ag_lea', 'Lea'));
  h.wakes.wake({ agentId: 'ag_tom', reason: 'message', conversationId: h.chat.id });
  h.wakes.wake({ agentId: 'ag_lea', reason: 'message', conversationId: h.chat.id });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', taskId: 'task_1' });
  assert.deepEqual(h.due, [], 'batched, not synchronous');
  await flush();
  assert.deepEqual(h.due, [['ag_tom', 'ag_lea']]);
  assert.equal(h.timers.pending.length, 0);
});

test('on start: wakes left due from before a restart are announced', async () => {
  const h = setup();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'retry', taskId: 'task_1', dueAt: h.clock.now() - H });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'review', taskId: 'task_2', dueAt: h.clock.now() + H });
  h.scheduler.start();
  await flush();
  assert.deepEqual(h.due, [['ag_tom']]);
  assert.equal(h.timers.only().ms, H);
  h.scheduler.start(); // idempotent
  assert.equal(h.timers.pending.length, 1);
});

test('timer delay is capped below the setTimeout overflow; an early wake-up just re-arms', () => {
  const h = setup();
  h.scheduler.start();
  const far = h.reminder(h.clock.now() + 40 * D, 'Far');
  assert.equal(h.timers.only().ms, MAX_TIMER_MS);
  h.clock.advance(MAX_TIMER_MS);
  h.timers.fire();
  assert.equal(h.wakeRows().length, 0, 'not due yet');
  assert.equal(h.timers.only().ms, 40 * D - MAX_TIMER_MS);
  assert.equal(h.scheduler.get(far.id)!.active, true);
});

test('power resume and unlock process what became due while the PC slept', () => {
  const h = setup();
  h.scheduler.start();
  h.reminder(h.clock.now() + 10 * M, 'After sleep');
  h.clock.advance(3 * H); // the PC slept; the old timer has not fired
  for (const listener of h.powerListeners) listener('suspend');
  assert.equal(h.wakeRows().length, 0, 'suspend does nothing');
  for (const listener of h.powerListeners) listener('resume');
  assert.deepEqual(h.wakeRows().map(w => w.note), ['After sleep']);
  assert.equal(h.timers.pending.length, 0);
});

test('a clock jump is logged; a clock that went backwards still arms correctly', () => {
  const h = setup();
  const log = new MemoryLogger();
  const scheduler = new SchedulerImpl({ ...h.services, log }, { timers: h.timers });
  scheduler.start();
  scheduler.create({ ownerId: 'ag_tom', kind: 'reminder', title: 'X', spec: { at: h.clock.now() + 10 * M }, payload: {} });
  h.clock.advance(5 * H);
  h.timers.fire();
  assert.ok(log.entries.some(e => e.message === 'scheduler: clock jump detected'));
  h.clock.advance(-2 * H);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'retry', taskId: 'task_1', dueAt: h.clock.now() + 15 * M });
  assert.equal(h.timers.only().ms, 15 * M);
  scheduler.stop();
});

test('stop clears the timer and unsubscribes from wakes and power events', async () => {
  const h = setup();
  h.scheduler.start();
  h.reminder(h.clock.now() + H);
  h.scheduler.stop();
  assert.equal(h.timers.pending.length, 0);
  h.wakes.wake({ agentId: 'ag_tom', reason: 'message', conversationId: h.chat.id });
  h.wakes.wake({ agentId: 'ag_tom', reason: 'retry', taskId: 'task_1', dueAt: h.clock.now() + M });
  await flush();
  assert.deepEqual(h.due, []);
  assert.equal(h.timers.pending.length, 0);
  h.scheduler.arm();
  assert.equal(h.timers.pending.length, 0, 'a stopped scheduler never arms');
});

test('a failing onDueWakes listener is logged and does not starve the others', async () => {
  const h = setup();
  const log = new MemoryLogger();
  const scheduler = new SchedulerImpl({ ...h.services, log }, { timers: h.timers });
  const got: string[][] = [];
  scheduler.onDueWakes(() => { throw new Error('boom'); });
  const off = scheduler.onDueWakes(ids => got.push(ids));
  scheduler.start();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'message', conversationId: h.chat.id });
  await flush();
  assert.deepEqual(got, [['ag_tom']]);
  assert.ok(log.entries.some(e => e.level === 'error' && e.message === 'onDueWakes listener failed'));
  off();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', taskId: 'task_9' });
  await flush();
  assert.equal(got.length, 1, 'unsubscribed');
  scheduler.stop();
});
