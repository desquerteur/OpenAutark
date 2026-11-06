// B-057 S11 – parts that wait for an account (splits/holds.ts): a split run that ended because no account could run it
// (a usage limit or an outage – SplitRunEnd.wait) is queued again without using its attempt and does not start before it
// is due (not on its lane's end, not on another pump); an account that becomes usable starts it at once; after a day of
// waiting its end counts like any retryable failure. The pipeline marks such ends (agents/split-turn.ts).
// Real split service and run journal; FakeLanes; a manual clock. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../models/harness.ts';
import { WAIT_TEXT } from '../../../src/runtime/splits/holds.ts';
import { splitTurnFailed } from '../../../src/runtime/agents/split-turn.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SplitRunEnd } from '../../../src/runtime/contracts/splits.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { part, splitAndEnd, world } from './fixture.ts';

const MINUTE = 60_000;
const LIMIT = 'No other model is available right now.';

test('a part that met a usage limit waits for an account without using its attempt; a usable account starts it at once', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('Count the files')]);
  const id = w.lanes.started[0];
  w.lanes.end(id, 'failed', { retryable: true, wait: true, error: LIMIT });
  const split = w.splits.get(id)!.split;
  assert.deepEqual([split.status, split.attempts, split.error], ['queued', 0, WAIT_TEXT]);
  assert.equal(w.lanes.started.length, 1, 'not started again when its lane freed');
  w.splits.pump();
  assert.equal(w.lanes.started.length, 1, 'nor by another pump before it is due');
  w.clock.advance(31 * MINUTE); // past the recheck time of an outage with no known end
  w.splits.pump();
  assert.equal(w.lanes.started.length, 2, 'due: it starts');
  assert.equal(w.splits.get(id)!.split.attempts, 1);
  w.lanes.end(id, 'failed', { retryable: true, wait: true, error: LIMIT });
  assert.equal(w.lanes.started.length, 2, 'held again');
  w.bus.emit('account.upserted', account('acc_plan', 'codex')); // an account becomes usable
  assert.equal(w.lanes.started.length, 3, 'started at once');
  w.lanes.end(id, 'done', { answer: 'Twelve files.' });
  assert.equal(w.splits.list({ groupId })[0].status, 'settled');
  assert.equal(w.splits.get(id)!.split.attempts, 1, 'the waits used no attempt');
});

test('after a day of waiting a limit end counts like any retryable failure; a stopped part waits no more', () => {
  const w = world();
  splitAndEnd(w, [part('Read the logs'), part('Sum the costs')]);
  const [logs, costs] = w.lanes.started;
  w.lanes.end(logs, 'failed', { retryable: true, wait: true, error: LIMIT });
  w.clock.advance(25 * 60 * MINUTE);
  w.splits.pump();
  assert.equal(w.lanes.started.filter((id) => id === logs).length, 2);
  w.lanes.end(logs, 'failed', { retryable: true, wait: true, error: LIMIT });
  let split = w.splits.get(logs)!.split;
  assert.deepEqual([split.status, split.attempts], ['running', 2], 'its one retry runs at once');
  w.lanes.end(logs, 'failed', { retryable: true, wait: true, error: LIMIT });
  split = w.splits.get(logs)!.split;
  assert.deepEqual([split.status, split.error], ['failed', LIMIT]);

  w.lanes.end(costs, 'failed', { retryable: true, wait: true, error: LIMIT });
  assert.equal(w.splits.get(costs)!.split.status, 'queued');
  assert.equal(w.splits.stop({ splitId: costs }, 'human'), 1);
  w.bus.emit('account.upserted', account('acc_plan', 'codex'));
  assert.equal(w.splits.get(costs)!.split.status, 'stopped', 'a stop ends the wait');
});

test('the pipeline marks a limit or an outage before the engine as a wait; a setup error is no wait', () => {
  const ends: SplitRunEnd[] = [];
  const services = { splits: { onSplitRunEnd: (_id: string, end: SplitRunEnd) => { ends.push(end); } }, log: { warn: () => {} } } as unknown as RuntimeServices;
  const plan = { split: { splitId: 'spl_1' } as SplitTurn };
  splitTurnFailed(services, plan, 'run_1', { code: 'rate_limited', message: 'Limited.' });
  splitTurnFailed(services, plan, 'run_2', { code: 'unavailable', message: LIMIT });
  splitTurnFailed(services, plan, 'run_3', { code: 'unavailable', message: 'Sign in first.', details: { setup: true } });
  splitTurnFailed(services, plan, 'run_4', { code: 'cancelled', message: 'Cut.' });
  assert.deepEqual(ends.map((end) => [end.retryable, end.wait]), [[true, true], [true, true], [false, undefined], [true, undefined]]);
});
