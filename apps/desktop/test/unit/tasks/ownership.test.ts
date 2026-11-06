// The ownership loop (src/runtime/tasks/ownership.ts): an owner keeps working until the task is done or it asks.
// A turn that did something continues at once, one that did not pauses 1 min, 2 min, 4 min …; an outage retries and is
// brought forward when an account becomes usable; a wait is re-checked after a day; done or stopped plans nothing;
// recover() wakes every unfinished agent task once after a restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Account } from '../../../src/shared/model/providers.ts';
import { CONTINUE_MS, RECHECK_MS, STALL_BASE_MS, stallDelay } from '../../../src/runtime/tasks/ownership.ts';
import { INTERRUPTED_NOTE } from '../../../src/runtime/tasks/recover-notes.ts';
import { M, ownershipFixture } from './ownership-fixture.ts';

test('a turn that did something continues soon; one that did not pauses with a doubling wait', () => {
  const f = ownershipFixture();
  const now = f.clock.now();
  const next = f.turn(true);
  assert.equal(next?.reason, 'retry');
  assert.equal(next!.dueAt - now, CONTINUE_MS);
  assert.equal(f.current().ledger.stalls, 0);

  const first = f.turn(false);
  assert.equal(first!.dueAt - now, STALL_BASE_MS, 'first stall: 1 min');
  const second = f.turn(false);
  assert.equal(second!.dueAt - now, 2 * M, 'second stall: 2 min');
  assert.equal(f.current().ledger.stalls, 2);
  assert.equal(stallDelay(40), 24 * 3600_000, 'at most a day');
  assert.equal(f.turn(true)!.dueAt - now, CONTINUE_MS, 'progress resets the pause');
});

test('an outage retries after a minute and comes forward when an account becomes usable', () => {
  const f = ownershipFixture();
  f.ownership.watchOutages();
  const now = f.clock.now();
  const next = f.turn(false, 'unavailable');
  assert.equal(next!.dueAt - now, STALL_BASE_MS);
  assert.equal(f.current().attempts, 0, 'an outage is no attempt');
  f.bus.emit('account.upserted', { id: 'acc_1', enabled: true, state: 'ok' } as unknown as Account);
  assert.ok(f.pending()[0].dueAt <= f.clock.now(), 'released to now');
});

test('a wait is re-checked after a day; done and a person\'s Stop plan nothing', () => {
  const f = ownershipFixture();
  const now = f.clock.now();
  f.tasks.setStatus(f.task.id, 'waiting', 'ag_tom', 'Waiting for the logo');
  const recheck = f.turn(false, 'waiting');
  assert.equal(recheck?.reason, 'review');
  assert.equal(recheck!.dueAt - now, RECHECK_MS);

  const g = ownershipFixture();
  g.tasks.complete(g.task.id, { summary: 'Done', evidence: [], verification: 'claimed_by_agent' }, 'ag_tom');
  assert.equal(g.turn(true), undefined);

  const h = ownershipFixture();
  assert.equal(h.turn(false, 'stopped'), undefined);
  assert.equal(h.current().status, 'open', 'paused for the person');
});

test('recover() wakes an interrupted task with the cut-off note', () => {
  const f = ownershipFixture();
  f.wakes.done(f.wakes.list('ag_tom').map((wake) => wake.id));
  f.tasks.setStatus(f.task.id, 'working', 'ag_tom');
  (f.services as { runs?: unknown }).runs = { get: (id: string) => (id === 'run_cut' ? { id, agentId: 'ag_tom', taskId: f.task.id } : undefined) };
  const continued = f.ownership.recover({ interruptedRuns: ['run_cut'] });
  assert.equal(continued, 1);
  const wake = f.pending()[0];
  assert.equal(wake?.note, INTERRUPTED_NOTE);
});
