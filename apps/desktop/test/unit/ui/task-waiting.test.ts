// The task bubble's waiting line and the task detail's Resume rule (src/ui/tasks/waiting.ts,
// T06): work the person paused with Stop (the runtime's own pause marker) reads "Paused by you
// since …" – not like a never-started 'Open' task – and only that work offers Resume; other
// waits keep their lines.
// Owns: these assertions only. Never: the DOM, rpc or the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { PAUSED_REASON } from '../../../src/runtime/tasks/owners.ts';
import { time } from '../../../src/ui/lib/format.ts';
import { canResume, stateLine, waitingLine } from '../../../src/ui/tasks/waiting.ts';

const SINCE = Date.UTC(2026, 9, 20, 9, 30, 0);
const names = (id: string) => (id === 'ag_tom' ? 'Tom' : id);

function task(patch: Partial<TaskView>): Pick<TaskView, 'status' | 'waitingOn'> {
  return { status: 'open', ...patch };
}

test('paused work (the runtime\'s marker) shows "Paused by you since …" and offers Resume', () => {
  const paused = task({ status: 'open', waitingOn: { kind: 'human', reason: PAUSED_REASON, since: SINCE } });
  assert.equal(waitingLine(paused, names), `Paused by you since ${time(SINCE)}`);
  assert.equal(canResume(paused), true);
});

test('open work that is not paused has no line and no Resume – setStatus would really start it', () => {
  assert.equal(waitingLine(task({ status: 'open' }), names), null);
  assert.equal(canResume(task({ status: 'open' })), false);
  const otherWait = task({ status: 'open', waitingOn: { kind: 'human', reason: 'Needs a look', since: SINCE } });
  assert.equal(canResume(otherWait), false, 'only the pause reason counts, not any wait on the human');
  assert.equal(canResume(task({ status: 'working', waitingOn: { kind: 'human', reason: PAUSED_REASON, since: SINCE } })), false);
});

test('other waits keep their lines', () => {
  assert.equal(waitingLine(task({ status: 'needs_you', waitingOn: { kind: 'human', reason: 'Code', since: SINCE } }), names), `Waiting on you since ${time(SINCE)}`);
  assert.equal(waitingLine(task({ status: 'needs_you' }), names), 'Needs you');
  assert.equal(waitingLine(task({ status: 'waiting', waitingOn: { kind: 'agent', id: 'ag_tom', reason: 'Cutting the clip', since: SINCE } }), names), `Waiting on Tom since ${time(SINCE)} · Cutting the clip`);
  assert.equal(waitingLine(task({ status: 'blocked', waitingOn: { kind: 'external', reason: 'Site down', since: SINCE } }), names), `Stuck since ${time(SINCE)} · Site down`);
});

test('the done line names the day when the work was finished before today', () => {
  const now = new Date(2026, 10, 5, 18, 0).getTime(); // Thursday
  const done = (at: number) => stateLine({ status: 'done', assigneeKind: 'agent', assigneeId: 'ag_1', completedAt: at, updatedAt: at } as never, () => 'Mara', now);
  const today = new Date(2026, 10, 5, 10, 14).getTime();
  assert.equal(done(today), `Done ${time(today)}`);
  const monday = new Date(2026, 10, 2, 10, 14).getTime();
  assert.notEqual(done(monday), `Done ${time(monday)}`, 'Monday is not today');
  assert.ok(done(monday).endsWith(time(monday)));
});
