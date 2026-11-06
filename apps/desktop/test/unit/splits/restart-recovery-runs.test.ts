// B-057 live test L7 (Codex, 30.10.): the runtime was killed while three split parts ran shell commands. At the next
// start the parts were put back (splits/reconcile.ts) – but their cut runs also went into the recovery notes
// (tasks/recover-notes.ts), whose chat-free 'retry' wake had the PARENT spend a 68 s turn looking for its parts' commands.
// main.ts now hands ownership.recover only recoveryRuns(): every interrupted run except a split's.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryRuns } from '../../../src/runtime/splits/reconcile.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const run = (id: string, splitId?: string): Run => ({ id, agentId: 'ag_1', trigger: splitId ? 'split' : 'message', status: 'interrupted', ...(splitId ? { splitId } : {}) });

test("recoveryRuns leaves split runs out and keeps every other interrupted run (also one the journal no longer knows)", () => {
  const rows = new Map([run('run_chat'), run('run_task'), run('run_part1', 'spl_1'), run('run_part2', 'spl_2')].map((item) => [item.id, item]));
  const journal = { get: (id: string) => rows.get(id) };
  assert.deepEqual(recoveryRuns(journal, ['run_chat', 'run_part1', 'run_task', 'run_part2', 'run_gone']), ['run_chat', 'run_task', 'run_gone']);
  assert.deepEqual(recoveryRuns(journal, []), []);
});

test('recoveryRuns keeps a run it cannot read (the recovery notes decide as before)', () => {
  const journal = { get: (): Run | undefined => { throw new Error('db closed'); } };
  assert.deepEqual(recoveryRuns(journal, ['run_a']), ['run_a']);
});
