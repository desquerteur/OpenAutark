// A snoozed to-do's row on the For-you list (HumanItem.tsx useSnoozeEnd, INT-1): once this
// connection has listed the schedules (schedules.list allowed) the live ring decides – a paused or
// deleted ring reads as plain "Snoozed" –, else the end the snooze recorded (waitingOn.until),
// e.g. on a To-do-only phone. The hook is read from HumanItem.tsx's source (a .tsx file the node
// test runner cannot import); both branches run here with the real shared rules.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Schedule, TaskView } from '../../../src/shared/model/tasks.ts';
import { snoozedUntil, snoozeEnd } from '../../../src/shared/model/todo-later.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const item = readFileSync(path.join(root, 'src/ui/tasks/HumanItem.tsx'), 'utf8');

const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);
const END = NOW + 30 * 60_000;

const todo = (until?: number): TaskView => ({
  id: 'todo_1', conversationId: 'ch_a', title: 'Call the tax office', notes: '', status: 'waiting', assigneeKind: 'human', createdBy: 'ag_ava',
  priority: 0, ledger: {}, attempts: 0, sort: 1, rev: 2, createdAt: NOW - 60_000, updatedAt: NOW,
  waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW, ...(until !== undefined ? { until } : {}) },
  steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false,
});

const ring = (patch: Partial<Schedule> = {}): Schedule => ({
  id: 'sch_1', ownerId: 'human', taskId: 'todo_1', kind: 'timer', title: 'Call the tax office', spec: { at: END }, payload: {},
  nextAt: END, runs: 0, active: true, createdAt: NOW, ...patch,
});

/** useSnoozeEnd's rule (asserted against the source below). */
const shown = (task: TaskView, listed: readonly Schedule[] | undefined) => (listed ? snoozeEnd(listed, task.id) : snoozedUntil(task));

test('HumanItem.tsx: the listed schedule where schedules.list is allowed and loaded, else the recorded end', () => {
  assert.match(item, /function useSnoozeEnd\(task: TaskView, snoozed: boolean\): number \| undefined \{/);
  assert.match(item, /if \(!snoozed\) return undefined;\r?\n\s*return schedulesLoaded\.value \? snoozeEnd\(schedules\.value, task\.id\) : snoozedUntil\(task\);/);
  assert.match(item, /const until = useSnoozeEnd\(task, snoozed\);/);
  assert.match(item, /import \{ ensureSchedules, schedules, schedulesLoaded \} from '\.\/schedules\.ts';/);
});

test('both branches: a To-do-only phone shows the recorded end; a listed paused or deleted ring reads as plain "Snoozed"', () => {
  assert.equal(shown(todo(END), undefined), END, 'no schedules.list: the end the snooze recorded');
  assert.equal(shown(todo(), undefined), undefined, 'nothing recorded: plain "Snoozed"');
  assert.equal(shown(todo(END), [ring()]), END, 'listed: the live ring');
  assert.equal(shown(todo(END), [ring({ nextAt: END + 60_000, spec: { at: END + 60_000 } })]), END + 60_000, 'the live ring wins over the record');
  assert.equal(shown(todo(END), [ring({ active: false })]), undefined, 'a paused ring');
  assert.equal(shown(todo(END), []), undefined, 'a deleted ring');
});
