// B-057 live test L7 – the attempt after a restart's put-back is told why it runs again: its input notes end with
// RESTART_NOTE (do the part again, run its commands again; repeating reads and checks is safe) – after a crash (boot
// reconcile: RESTART_AGAIN) and after a graceful stop that cut its run (SHUTDOWN_CUT). A first attempt, a retry after an
// ordinary failure and a part that never started (requeue) do not get it; a restarted attempt held for an account or put
// back before it ran leaves the note to the attempt that runs.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordShutdownRuns } from '../../../src/runtime/runs/journal.ts';
import { RESTART_AGAIN, RESTART_NOTE, SHUTDOWN_CUT } from '../../../src/runtime/splits/reconcile.ts';
import { WAIT_TEXT } from '../../../src/runtime/splits/holds.ts';
import { part, splitAndEnd, world } from './fixture.ts';

const told = (notes: Array<{ text: string }>) => notes.some((note) => note.text === RESTART_NOTE);

test('after a crash: the attempt the boot recovery put back reads RESTART_NOTE after its part; first attempts do not', () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B')]);
  assert.equal(w.lanes.turns.some((entry) => told(entry.notes)), false, 'first attempts');
  const after = w.restart();
  after.splits.reconcile();
  assert.equal(after.lanes.turns.length, 2);
  for (const entry of after.lanes.turns) {
    assert.match(entry.notes[0].text, /^My part #\d of 2/);
    assert.equal(entry.notes.at(-1)?.text, RESTART_NOTE, `#${entry.turn.idx}`);
  }
  // That attempt fails like any other and runs once more: its retry is no restart.
  const id = after.lanes.started[0];
  after.lanes.end(id, 'failed', { retryable: true, error: 'The provider is busy.' });
  assert.equal(after.lanes.turns.length, 3);
  assert.equal(told(after.lanes.turns[2].notes), false);
});

test('after a graceful stop cut the run: the next attempt reads it; a retry or a part that never started does not', () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  recordShutdownRuns(w, [w.lanes.lanes.get(a)!.runId]);
  w.lanes.end(a, 'failed', { retryable: true, error: SHUTDOWN_CUT });
  const again = w.lanes.turns.at(-1)!;
  assert.equal(again.turn.splitId, a);
  assert.equal(told(again.notes), true);
  assert.equal(w.splits.get(a)!.split.attempts, 1, 'put back without using an attempt');

  w.lanes.end(b, 'failed', { retryable: true, error: 'The provider is busy.' });
  assert.equal(w.lanes.turns.at(-1)!.turn.splitId, b);
  assert.equal(told(w.lanes.turns.at(-1)!.notes), false, 'an ordinary retry');
  w.lanes.end(c, 'failed', { retryable: true, requeue: true, error: 'The runtime stopped before the split ran.' });
  assert.equal(w.lanes.turns.at(-1)!.turn.splitId, c);
  assert.equal(told(w.lanes.turns.at(-1)!.notes), false, 'it never started: nothing was cut');
  assert.notEqual(RESTART_AGAIN, SHUTDOWN_CUT);
});

test('a restarted attempt that never really ran (held for an account, or put back) leaves the note to the attempt that runs', () => {
  const w = world();
  splitAndEnd(w, [part('A'), part('B')]);
  const after = w.restart();
  after.splits.reconcile();
  const [a, b] = after.lanes.started;
  after.lanes.end(a, 'failed', { retryable: true, wait: true, error: 'No other model is available right now.' });
  assert.equal(after.splits.get(a)!.split.error, WAIT_TEXT);
  w.clock.advance(31 * 60_000); // past the recheck time of an outage with no known end (holds.ts)
  after.splits.pump();
  assert.equal(after.lanes.turns.at(-1)!.turn.splitId, a);
  assert.equal(told(after.lanes.turns.at(-1)!.notes), true, 'held: the cut work was never redone');
  after.lanes.end(b, 'failed', { retryable: true, requeue: true, error: 'The agent paused for its budget before this part started; it waits for a raise.' });
  assert.equal(after.lanes.turns.at(-1)!.turn.splitId, b);
  assert.equal(told(after.lanes.turns.at(-1)!.notes), true, 'put back before it ran');
  // Once an attempt really ran, its retry is no restart.
  after.lanes.end(b, 'failed', { retryable: true, error: 'The provider is busy.' });
  assert.equal(after.lanes.turns.at(-1)!.turn.splitId, b);
  assert.equal(told(after.lanes.turns.at(-1)!.notes), false);
});
