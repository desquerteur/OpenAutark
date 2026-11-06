// The For-you query (F04, tasks/repo.ts todos via TaskService.todos – what todos.list returns):
// a snoozed to-do and a repeating timer waiting for its next time stay listed (status 'waiting',
// waitingOn.kind 'schedule' – the UI keeps them under "Later"); any other wait, finished to-dos
// and agent work are not listed; binding approvals come first, then what rang, then the rest by
// due, the waiting ones last – so a small limit keeps what is due now; the shared rule
// (shared/model/todo-later.ts, for the badge and the wf CLI) counts only what is due now
// (B-041: a to-do due on a later day waits under Later).
// Owns: these assertions only. Never: real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { countNow, isLater } from '../../../src/shared/model/todo-later.ts';
import { agent, harness } from '../chat/harness.ts';

const M = 60_000;
const H = 60 * M;

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  h.scheduler.start();
  const todo = (title: string, extra: Record<string, unknown> = {}) => h.tasks.create({
    conversationId: chat.id, title, assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_ava', ...extra,
  });
  const listed = (limit?: number) => h.tasks.todos(limit).map((task) => task.title);
  return { ...h, chat, todo, listed };
}

test('a snoozed to-do stays on the list as waiting for its ring, after the to-dos due now', () => {
  const h = setup();
  const bread = h.todo('Take the bread out', { widget: { type: 'timer', label: 'Bread', duration: 'PT5M' } });
  h.todo('Sign the form');
  const snoozed = h.tasks.snooze(bread.id, h.clock.now() + 10 * M);
  assert.equal(snoozed.status, 'waiting');
  const list = h.tasks.todos();
  assert.deepEqual(list.map((task) => task.title), ['Sign the form', 'Take the bread out'], 'listed, after what is due now');
  const entry = list.find((task) => task.id === bread.id)!;
  assert.equal(entry.status, 'waiting');
  assert.equal(entry.waitingOn?.kind, 'schedule', 'flagged as waiting for a ring (the UI shows it under Later)');
  assert.equal(entry.waitingOn?.reason, 'Snoozed');
});

test('a repeating timer ticked off waits for its next time and stays listed', () => {
  const h = setup();
  const nine = new Date(h.clock.now());
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= h.clock.now()) nine.setDate(nine.getDate() + 1);
  const pills = h.todo('Take the pills', { widget: { type: 'timer', label: 'Pills', at: nine.toISOString(), repeat: 'daily' } });
  h.clock.set(nine.getTime() + 1000);
  if (h.timers.pending.length) h.timers.fire();
  h.tasks.answer({ taskId: pills.id, answer: { event: 'done' }, by: HUMAN_ID });
  const entry = h.tasks.todos().find((task) => task.id === pills.id);
  assert.equal(entry?.status, 'waiting');
  assert.equal(entry?.waitingOn?.reason, 'Repeats');
});

test('other waits, finished to-dos and agent work are not listed', () => {
  const h = setup();
  const bank = h.todo('Call the bank');
  h.tasks.setStatus(bank.id, 'waiting', HUMAN_ID, 'Waiting for the bank to open');
  const done = h.todo('Water the plants');
  h.tasks.setStatus(done.id, 'done', HUMAN_ID);
  h.tasks.create({ conversationId: h.chat.id, title: 'Draft the post', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: HUMAN_ID });
  h.todo('Sign the form');
  assert.equal(h.tasks.get(bank.id)?.waitingOn?.kind, 'external');
  assert.deepEqual(h.listed(), ['Sign the form']);
});

test('order: what rang, then by due, the waiting ones last – a small limit keeps what is due now', () => {
  const h = setup();
  const now = h.clock.now();
  const nap = h.todo('Nap reminder', { widget: { type: 'timer', label: 'Nap', duration: 'PT2M' } });
  h.tasks.snooze(nap.id, now + 30 * M);
  h.todo('Soon', { dueAt: now + H });
  h.todo('No due');
  const rang = h.todo('Rang', { dueAt: now + 5 * H });
  h.tasks.setStatus(rang.id, 'needs_you', SYSTEM_ID, 'Timer');
  assert.deepEqual(h.listed(), ['Rang', 'Soon', 'No due', 'Nap reminder']);
  assert.deepEqual(h.listed(2), ['Rang', 'Soon'], 'the limit drops the later ones first');
});

test('the shared rule over todos.list counts only what is due now – snoozed and far timers wait under Later', () => {
  const h = setup();
  const now = h.clock.now();
  const bread = h.todo('Take the bread out', { widget: { type: 'timer', label: 'Bread', duration: 'PT5M' } });
  h.tasks.snooze(bread.id, now + 10 * M);
  h.todo('Dentist', { widget: { type: 'timer', label: 'Dentist', at: new Date(now + 3 * 24 * H).toISOString() } });
  h.todo('Sign the form');
  const list = h.tasks.todos();
  assert.equal(list.length, 3, 'todos.list keeps the Later ones');
  assert.equal(countNow(list, now), 1, 'the count a phone tab shows');
  assert.deepEqual(list.filter((task) => isLater(task, now)).map((task) => task.title).sort(), ['Dentist', 'Take the bread out']);
  assert.equal(countNow(list, now + 3 * 24 * H - 12 * H + 1), 1, 'a timer within 12 h waits under Today until it rings (one rule with the Needs-you group)');
});

test('B-041: a to-do due on a later day stays listed and waits under Later – the count leaves it out until its day', () => {
  const h = setup();
  const now = h.clock.now();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  h.todo('File the taxes', { dueAt: midnight.getTime() + 9 * H });
  h.todo('Sign the form');
  const list = h.tasks.todos();
  assert.equal(list.length, 2, 'todos.list keeps it');
  assert.equal(countNow(list, now), 1);
  assert.deepEqual(list.filter((task) => isLater(task, now)).map((task) => task.title), ['File the taxes']);
  assert.equal(countNow(list, midnight.getTime()), 2, 'it counts from its day on');
});
