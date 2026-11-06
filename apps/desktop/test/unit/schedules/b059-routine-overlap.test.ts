// B-059 (#5/#67): an agent's routine that fires while the task of its previous occurrence is still unfinished
// creates no second copy (Temporal-style skip) – the open task gets one skip note (the newest replaces an older
// one) and nobody is woken; a finished or cancelled occurrence lets the next fire create a new task; work the
// agent made during a routine's run (same origin, its own title) does not hold the routine; the person's
// "Post as task" routines post as before.
// Owns: these assertions only. Never: real timers or models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { fixture } from '../context/fixture.ts';
import { fireSchedule, isRoutineOccurrence, scheduleOrigin } from '../../../src/runtime/schedules/fire.ts';
import type { TaskStatus } from '../../../src/shared/model/tasks.ts';

const M = 60_000;
const NINE = Date.UTC(2026, 9, 17, 9, 0, 0); // harness clock start
const ALL: TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked', 'done', 'cancelled'];
const TITLE = 'Check the support inbox';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const routine = h.scheduler.create({
    ownerId: 'ag_tom', kind: 'routine', title: 'Support inbox', spec: { everyMs: 30 * M, tz: 'UTC' }, payload: { taskTemplate: { title: TITLE } },
  });
  const occurrences = () => h.tasks.list({ assigneeKind: 'agent', assigneeId: 'ag_tom', status: ALL, limit: 100 }).filter((task) => task.title === TITLE);
  const fire = (at: number) => fireSchedule(routine, at, h.services);
  const openWakes = () => h.wakes.list('ag_tom').filter((wake) => wake.claimedAt === undefined);
  const handleWakes = () => h.wakes.done(h.wakes.claim('ag_tom', Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
  return { ...h, routine, occurrences, fire, openWakes, handleWakes };
}

test('a routine fired while its last task is open makes no second task; one skip note, nobody woken', () => {
  const h = setup();
  h.fire(NINE);
  assert.equal(h.occurrences().length, 1);
  assert.ok(h.openWakes().length >= 1, 'the first occurrence wakes its owner');
  h.handleWakes();

  h.fire(NINE + 30 * M);
  h.fire(NINE + 60 * M);
  const [open] = h.occurrences();
  assert.equal(h.occurrences().length, 1, 'no second copy while the first one is open');
  assert.equal(h.openWakes().length, 0, 'a skipped run wakes nobody');
  const skips = (open.ledger.facts ?? []).filter((fact) => fact.startsWith('Skipped the'));
  assert.deepEqual(skips, ['Skipped the 10:00 run – the previous one is still open'], 'one note, the newest');
});

test('a blocked occurrence still holds the routine; a finished or cancelled one lets the next fire create a task', () => {
  const h = setup();
  h.fire(NINE);
  const [first] = h.occurrences();
  h.tasks.setStatus(first.id, 'blocked', 'ag_tom', 'Mail sign-in expired');
  h.fire(NINE + 30 * M);
  assert.equal(h.occurrences().length, 1, 'a blocked run counts as open (Temporal: a paused run is open)');

  h.tasks.complete(first.id, { summary: 'Answered 3 mails', evidence: [{ kind: 'note', label: 'answered' }], verification: 'claimed_by_agent' }, 'ag_tom');
  h.fire(NINE + 60 * M);
  assert.equal(h.occurrences().length, 2, 'the previous run is done: a new task');
  const second = h.occurrences().find((task) => task.id !== first.id)!;
  h.tasks.setStatus(second.id, 'cancelled', 'ag_tom', 'Nothing to do');
  h.fire(NINE + 90 * M);
  assert.equal(h.occurrences().length, 3);
});

test('work the agent made in a routine run (same origin, own title) does not hold the routine', () => {
  const h = setup();
  h.fire(NINE);
  const [first] = h.occurrences();
  const extra = h.tasks.create({ title: 'Reply to Anna about the refund', assigneeId: 'ag_tom', createdBy: 'ag_tom', origin: scheduleOrigin(h.routine) });
  assert.equal(isRoutineOccurrence(h.routine, h.tasks.get(first.id)!), true);
  assert.equal(isRoutineOccurrence(h.routine, h.tasks.get(extra.id)!), false);
  h.tasks.complete(first.id, { summary: 'Done', evidence: [{ kind: 'note', label: 'done' }], verification: 'claimed_by_agent' }, 'ag_tom');
  h.fire(NINE + 30 * M);
  assert.equal(h.occurrences().length, 2, 'the open reply task is no earlier occurrence');
});

test('the person\'s "Post as task" routines keep posting a team task each time', () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', title: 'Team' });
  const weekly = h.scheduler.create({
    ownerId: 'human', conversationId: chat.id, kind: 'routine', title: 'Weekly report', spec: { everyMs: 60 * M, tz: 'UTC' }, payload: { taskTemplate: { title: 'Write the weekly report' } },
  });
  fireSchedule(weekly, NINE, h.services);
  fireSchedule(weekly, NINE + 60 * M, h.services);
  assert.equal(h.tasks.list({ conversationId: chat.id, status: ALL }).filter((task) => task.title === 'Write the weekly report').length, 2);
});
