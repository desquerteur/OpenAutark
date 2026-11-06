// D5 compact task lines (src/ui/tasks/compact-task.ts): a finished task an agent created (or made during a
// run, meta.fromRun) becomes one line; open cards and the person's own tasks stay full.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { compactState, isCompact } from '../../../src/ui/tasks/compact-task.ts';

const task = (patch: Partial<TaskView>) => ({ status: 'open', createdBy: 'human', ...patch }) as TaskView;
const meta = (fromRun?: string) => ({ meta: fromRun ? { fromRun } : {} });

test('a colleague\'s own finished task stays a full card (only agents\' tasks shrink)', () => {
  assert.equal(isCompact(task({ status: 'done', createdBy: 'per_0123456789ab' }), meta()), false);
  assert.equal(isCompact(task({ status: 'done', createdBy: 'owner' }), meta()), false);
  assert.equal(isCompact(task({ status: 'done', createdBy: 'system' }), meta()), false);
});

test('a finished task an agent made, or one made during a run, is one line; the person\'s own task stays a card', () => {
  assert.equal(isCompact(task({ status: 'done', createdBy: 'ag_tom' }), meta()), true);
  assert.equal(isCompact(task({ status: 'working', createdBy: 'ag_tom' }), meta()), false, 'work still going stays full');
  assert.equal(isCompact(task({ status: 'done', createdBy: 'human' }), meta()), false);
  assert.equal(isCompact(task({ status: 'cancelled', createdBy: 'human' }), meta('run_1')), true, 'meta.fromRun marks it as run work');
  assert.equal(compactState(task({ status: 'done' })), 'Done');
  assert.equal(compactState(task({ status: 'cancelled' })), 'Cancelled');
});
