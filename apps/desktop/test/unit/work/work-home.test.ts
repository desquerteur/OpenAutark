// What Work tells the clock (src/ui/tasks/work-model.ts, B-078): the next moment the report changes by time alone – a
// finished task leaving its three-day window. Open work changes only by its own events, never by a clock.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_DAYS, nextWorkChange } from '../../../src/ui/tasks/work-model.ts';
import { DAY, HOUR, NOW, task } from './fixture.ts';

test('nextWorkChange: the earliest finished task leaving the report – none when nothing is ahead', () => {
  const waiting = task({ status: 'waiting', waitingOn: { kind: 'external', reason: 'Printer', since: NOW - DAY } });
  const finished = task({ status: 'done', completedAt: NOW - 2 * DAY });
  const newer = task({ status: 'done', completedAt: NOW - HOUR });
  assert.equal(nextWorkChange([waiting], [], NOW), undefined, 'a wait changes nothing by time');
  assert.equal(nextWorkChange([], [newer, finished], NOW), NOW - 2 * DAY + REPORT_DAYS * DAY + 1);
  assert.equal(nextWorkChange([], [task({ status: 'done', completedAt: NOW - 9 * DAY })], NOW), undefined, 'already out');
  assert.equal(nextWorkChange([], [task({ status: 'done', parentId: 'task_p', completedAt: NOW - HOUR })], NOW), undefined, 'steps are no report');
});
