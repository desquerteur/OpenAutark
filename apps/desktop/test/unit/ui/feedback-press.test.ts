// B-055 Q4 – the header feedback cell's press (ui/feedback/press.ts PressTracker): pointer down is
// reported first (the screenshot starts before anything opens), a release before HOLD_MS is a tap,
// holding HOLD_MS or longer is talk (start on the hold, end on release, discarded on cancel),
// without dictation every press is a tap, Enter/Space is a tap that took no screenshot yet.
// Owns: these assertions only. Never: real timers, a DOM or a microphone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, PressTracker } from '../../../src/ui/feedback/press.ts';
import type { Schedule } from '../../../src/ui/feedback/press.ts';
import { HOLD_MS as MIC_HOLD_MS } from '../../../src/ui/feedback/bridge.ts';

/** A tracker with a fake clock: `advance(ms)` fires the armed hold timer when it is due. */
function setup(canHold = true) {
  const log: string[] = [];
  let now = 0;
  let due: { at: number; run: () => void } | null = null;
  const schedule: Schedule = (run, ms) => {
    const entry = { at: now + ms, run };
    due = entry;
    return () => { if (due === entry) due = null; };
  };
  const tracker = new PressTracker({
    press: () => log.push('press'),
    tap: (source) => log.push(`tap ${source}`),
    holdStart: () => log.push('hold start'),
    holdEnd: () => log.push('hold end'),
    holdCancel: () => log.push('hold cancel'),
  }, { canHold: () => canHold, schedule });
  const advance = (ms: number) => {
    now += ms;
    const entry = due;
    if (entry && entry.at <= now) { due = null; entry.run(); }
  };
  return { tracker, log, advance, armed: () => due !== null };
}

test('one hold threshold for the cell and the mic button: 300 ms', () => {
  assert.equal(HOLD_MS, 300);
  assert.equal(MIC_HOLD_MS, HOLD_MS);
});

test('pointer down reports the press first; a release before HOLD_MS is a tap from the pointer', () => {
  const s = setup();
  s.tracker.down();
  assert.deepEqual(s.log, ['press'], 'the screenshot can start before anything opens');
  assert.equal(s.tracker.phase, 'down');
  s.advance(HOLD_MS - 1);
  s.tracker.up();
  assert.deepEqual(s.log, ['press', 'tap pointer']);
  assert.equal(s.tracker.phase, 'idle');
  assert.equal(s.armed(), false, 'the hold timer is disarmed');
  s.advance(1000);
  assert.deepEqual(s.log, ['press', 'tap pointer'], 'no late hold');
});

test('holding HOLD_MS is talk: it starts when recognized and ends on release – a second click toggles again', () => {
  const s = setup();
  s.tracker.down();
  s.advance(HOLD_MS);
  assert.deepEqual(s.log, ['press', 'hold start']);
  assert.equal(s.tracker.phase, 'holding');
  s.advance(4000);
  s.tracker.up();
  assert.deepEqual(s.log, ['press', 'hold start', 'hold end']);
  s.tracker.down(); s.advance(80); s.tracker.up();
  assert.deepEqual(s.log.slice(-2), ['press', 'tap pointer']);
});

test('a cancelled pointer discards a talk and ignores a pending press; Escape is the same cancel', () => {
  const s = setup();
  s.tracker.down(); s.advance(100); s.tracker.cancel();
  assert.deepEqual(s.log, ['press'], 'a pending press does nothing');
  s.advance(HOLD_MS);
  assert.deepEqual(s.log, ['press'], 'no hold after the cancel');
  s.tracker.down(); s.advance(HOLD_MS); s.tracker.cancel();
  assert.deepEqual(s.log, ['press', 'press', 'hold start', 'hold cancel']);
  s.tracker.up();
  assert.deepEqual(s.log.at(-1), 'hold cancel', 'the release after a cancel is nothing');
});

test('without dictation every press is a tap, however long', () => {
  const s = setup(false);
  s.tracker.down();
  assert.equal(s.armed(), false);
  s.advance(5000);
  s.tracker.up();
  assert.deepEqual(s.log, ['press', 'tap pointer']);
});

test('Enter/Space is a tap that took no screenshot yet; a key during a press and a second pointer are ignored', () => {
  const s = setup();
  s.tracker.key();
  assert.deepEqual(s.log, ['tap key']);
  s.tracker.down();
  s.tracker.key();
  s.tracker.down(); // a second finger
  s.tracker.up();
  assert.deepEqual(s.log, ['tap key', 'press', 'tap pointer']);
});
