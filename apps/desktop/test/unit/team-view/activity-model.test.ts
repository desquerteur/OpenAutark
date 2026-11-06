// Activity (src/ui/team/activity-model.ts): one row per member, people and agents side
// by side – done today (since the day start, done only), working now (an agent's live run with its
// task's title; a person's focus timer or working task), open (without what waits for a ring) and
// stuck (Work's rule; for a human also past due, never a timer) – and the totals line.
// Owns: these assertions only. Never: the DOM, rpc or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { NO_OWNER, activityRows, activityTotals, isStuck, ownedByMember } from '../../../src/ui/team/activity-model.ts';
import { STUCK_WAIT_MS, stuckOf } from '../../../src/ui/tasks/work-model.ts';
import type { ActivityInput, ActivityMember } from '../../../src/ui/team/activity-model.ts';

const NOW = Date.UTC(2026, 9, 24, 15);
const DAY_START = Date.UTC(2026, 9, 24, 0);
let seq = 0;

function task(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: `task_${seq}`, conversationId: 'ch_a', title: `Task ${seq}`, notes: '', status: 'open', assigneeKind: 'agent', assigneeId: 'ag_mara',
    createdBy: 'human', priority: 0, dependsOn: [], ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false,
    ...patch,
  } as TaskView;
}

const run = (agentId: string, patch: Partial<AgentActivity> = {}): AgentActivity => ({ agentId, runId: `run_${agentId}`, conversationId: 'ch_a', note: 'Working', startedAt: NOW - 60_000, ...patch });

const members: ActivityMember[] = [{ id: 'human', kind: 'person' }, { id: 'per_anna', kind: 'person' }, { id: 'ag_mara', kind: 'agent' }, { id: 'ag_leo', kind: 'agent' }];

function input(patch: Partial<ActivityInput>): ActivityInput {
  return { open: [], todos: [], done: [], live: [], now: NOW, dayStart: DAY_START, ...patch };
}

test('ownedByMember: agents by id, people as their page counts them (the caller also without an id)', () => {
  assert.equal(ownedByMember({ assigneeKind: 'agent', assigneeId: 'ag_mara' }, { id: 'ag_mara', kind: 'agent' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'human', assigneeId: 'ag_mara' }, { id: 'ag_mara', kind: 'agent' }), false);
  assert.equal(ownedByMember({ assigneeKind: 'human' }, { id: 'human', kind: 'person' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'human', assigneeId: 'per_anna' }, { id: 'per_anna', kind: 'person' }), true);
  assert.equal(ownedByMember({ assigneeKind: 'team' }, { id: 'human', kind: 'person' }), false);
});

test('isStuck: blocked, stopped, waiting over two days, escalated – a human\'s work past due, never a timer or a fresh wait', () => {
  assert.equal(isStuck(task({ status: 'blocked' }), NOW), true);
  assert.equal(isStuck(task({ status: 'open', waitingOn: { kind: 'human', reason: 'Paused by you', since: NOW } }), NOW), true, 'stopped by the person');
  assert.equal(isStuck(task({ status: 'waiting', waitingOn: { kind: 'agent', reason: 'Waiting for Leo', since: NOW - STUCK_WAIT_MS - 1 } }), NOW), true);
  assert.equal(isStuck(task({ status: 'waiting', waitingOn: { kind: 'agent', reason: 'Waiting for Leo', since: NOW - 3_600_000 } }), NOW), false);
  assert.equal(isStuck(task({ ledger: { escalation: 'manager' } as TaskView['ledger'] }), NOW), true);
  assert.equal(isStuck(task({ assigneeKind: 'human', dueAt: NOW - 1 }), NOW), true, 'a person\'s overdue to-do');
  assert.equal(isStuck(task({ assigneeKind: 'human', dueAt: NOW - 1, widget: { type: 'timer', label: 'Tea' } }), NOW), false, 'a timer rings, it is not stuck');
  assert.equal(isStuck(task({ dueAt: NOW - 1 }), NOW), false, 'an agent\'s due time alone is not stuck');
  assert.equal(isStuck(task({ assigneeKind: 'human', status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW - 9 * STUCK_WAIT_MS } }), NOW), false, 'a snooze is no wait');
});

test('activityRows: done today, working now, open and stuck for people and agents side by side', () => {
  const working = task({ title: 'Draft the newsletter', status: 'working', running: true });
  const blocked = task({ title: 'Pay the invoice', status: 'blocked' });
  const annas = task({ assigneeKind: 'human', assigneeId: 'per_anna', title: 'Pick colours', status: 'working' });
  const mine = task({ assigneeKind: 'human', assigneeId: undefined, title: 'Write the book', timerStartedAt: NOW - 600_000 });
  const myOverdue = task({ assigneeKind: 'human', assigneeId: undefined, title: 'Taxes', dueAt: NOW - 3_600_000 });
  const snoozed = task({ assigneeKind: 'human', assigneeId: undefined, status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW } });
  const done = [
    task({ status: 'done', completedAt: NOW - 3_600_000 }),
    task({ status: 'done', completedAt: DAY_START - 1 }), // yesterday
    task({ status: 'cancelled', completedAt: NOW - 60_000 }), // cancelled is not done
    task({ assigneeKind: 'human', assigneeId: 'per_anna', status: 'done', completedAt: NOW - 60_000 }),
  ];
  const rows = activityRows(members, input({
    open: [working, blocked, annas, mine], todos: [mine, myOverdue, snoozed], done,
    live: [run('ag_mara', { taskId: working.id, note: 'Reading the sources' })],
  }));
  const [me, anna, mara, leo] = rows;
  assert.deepEqual([me.doneToday, me.open, me.stuck], [0, 2, 1], 'the caller: the book and the overdue taxes (snoozed left out, counted once)');
  assert.deepEqual(me.now, { title: 'Write the book', taskId: mine.id, conversationId: 'ch_a' }, 'the running focus timer');
  assert.deepEqual([anna.doneToday, anna.open, anna.stuck, anna.now?.title], [1, 1, 0, 'Pick colours']);
  assert.deepEqual([mara.doneToday, mara.open, mara.stuck], [1, 2, 1]);
  assert.deepEqual(mara.now, { title: 'Draft the newsletter', note: 'Reading the sources', taskId: working.id, conversationId: 'ch_a' });
  assert.deepEqual([leo.doneToday, leo.open, leo.stuck, leo.now], [0, 0, 0, undefined]);
  assert.deepEqual(activityTotals(rows), { doneToday: 2, working: 3, open: 5, stuck: 2 });
});

test('activityRows: a live run without a task shows its note; without a note "Working"', () => {
  const rows = activityRows([{ id: 'ag_leo', kind: 'agent' }, { id: 'ag_mara', kind: 'agent' }], input({ live: [run('ag_leo', { note: 'Checking the inbox' }), run('ag_mara', { note: '' })] }));
  assert.deepEqual(rows[0].now, { title: 'Checking the inbox', conversationId: 'ch_a' });
  assert.equal(rows[1].now?.title, 'Working');
});

test('B-054: a chat-free run without a task says what started it (origin label), with its live note beside it', () => {
  const rows = activityRows([{ id: 'ag_leo', kind: 'agent' }, { id: 'ag_mara', kind: 'agent' }], input({ live: [
    run('ag_leo', { conversationId: undefined, note: 'Reading the mail', origin: { source: 'app:mail1', label: 'New mail in office@example.com' } }),
    run('ag_mara', { conversationId: undefined, note: '', origin: { source: 'schedule:s1', label: 'Routine "Morning check"' } }),
  ] }));
  assert.deepEqual(rows[0].now, { title: 'New mail in office@example.com', note: 'Reading the mail', conversationId: undefined });
  assert.equal(rows[1].now?.title, 'Routine "Morning check"');
  assert.equal(rows[1].now?.note, undefined);
});

test('work nobody owns yet is its own row ("No owner yet"): the totals then match Work\'s stuck count', () => {
  const unowned = task({ assigneeKind: 'team', assigneeId: undefined, title: 'Steuern erledigen' });
  const unowned2 = task({ assigneeKind: 'team', assigneeId: undefined, title: 'Webseite verbessern' });
  const blocked = task({ status: 'blocked' });
  const open = [unowned, unowned2, blocked];
  const rows = activityRows([...members, NO_OWNER], input({ open }));
  const nobody = rows.find((row) => row.member.kind === 'team')!;
  assert.deepEqual([nobody.open, nobody.stuck], [2, 2], 'no owner yet is stuck in Work too');
  const workStuck = open.filter((entry) => stuckOf(entry, NOW)).length;
  assert.equal(activityTotals(rows).stuck, workStuck);
  assert.equal(ownedByMember({ assigneeKind: 'team' }, NO_OWNER), true);
  assert.equal(ownedByMember({ assigneeKind: 'agent', assigneeId: 'ag_mara' }, NO_OWNER), false);
});

test('counted narrows done today, open and stuck to Work\'s scope; "now" still sees the own to-do\'s focus timer', () => {
  const mine = task({ assigneeKind: 'human', assigneeId: undefined, title: 'Write the book', timerStartedAt: NOW - 600_000 });
  const myOverdue = task({ assigneeKind: 'human', assigneeId: undefined, title: 'Taxes', dueAt: NOW - 3_600_000 });
  const blocked = task({ status: 'blocked' });
  const myDone = task({ assigneeKind: 'human', assigneeId: undefined, status: 'done', completedAt: NOW - 60_000 });
  const agentDone = task({ status: 'done', completedAt: NOW - 60_000 });
  const onWork = (entry: TaskView) => entry.assigneeKind !== 'human'; // Work leaves the viewer's own to-dos to My day
  const rows = activityRows([{ id: 'human', kind: 'person' }, { id: 'ag_mara', kind: 'agent' }], input({
    open: [blocked, mine], todos: [mine, myOverdue], done: [myDone, agentDone], counted: onWork,
  }));
  const [me, mara] = rows;
  assert.deepEqual([me.doneToday, me.open, me.stuck], [0, 0, 0], 'the own to-dos are My day\'s: nothing a count would open in Work');
  assert.equal(me.now?.title, 'Write the book');
  assert.deepEqual([mara.doneToday, mara.open, mara.stuck], [1, 1, 1]);
  assert.deepEqual(activityTotals(rows), { doneToday: 1, working: 1, open: 1, stuck: 1 });
});
