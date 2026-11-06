// B-041 track A2: keeping the PC awake for agent work tonight (runtime/day/keep-awake.ts) – no hold during the
// day; at workEnd with work queued (the one timer for the night's start) one hold; turns running hold too; the
// hold goes when nothing is left, at planAt, or after 10 h – and not again that night; wakes due after the
// morning hold nothing; the setting switches it; stop lets go. No polling: one timer at most.
// Owns: checks of KeepAwake / nightOf only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { KEEP_AWAKE_REASON, KeepAwake, nightOf } from '../../../src/runtime/day/keep-awake.ts';
import type { DaySettings } from '../../../src/shared/model/day-settings.ts';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import { FakeTimers } from '../chat/harness.ts';
import { BERLIN, dayFixture } from './fixture.ts';

const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), BERLIN);
const MON = '2026-10-26';
const turn: AgentActivity = { agentId: 'ag_x', runId: 'run_1', note: 'working', startedAt: 0 };

function awake(now: number, day: Partial<DaySettings> = {}) {
  const f = dayFixture({ now, day });
  const timers = new FakeTimers();
  const keep = new KeepAwake(f.s, { timers });
  keep.start();
  /** Moves the clock to the armed moment and fires it. */
  const fire = () => { const timer = timers.only(); assert.ok(timer); f.clock.advance(timer.ms); timers.fire(); };
  return { f, timers, keep, fire };
}

test('the night window: workEnd until the next planAt', () => {
  assert.equal(nightOf(wall(MON, '15:00'), BERLIN, '20:00', '06:00'), undefined);
  assert.deepEqual(nightOf(wall(MON, '22:00'), BERLIN, '20:00', '06:00'), { from: wall(MON, '20:00'), to: wall('2026-10-27', '06:00') });
  assert.deepEqual(nightOf(wall('2026-10-27', '03:00'), BERLIN, '20:00', '06:00'), { from: wall(MON, '20:00'), to: wall('2026-10-27', '06:00') });
});

test('work queued in the afternoon: nothing by day, one hold from workEnd, gone when the queue is empty', () => {
  const k = awake(wall(MON, '15:00'));
  k.f.wakes.wake({ agentId: 'ag_x', reason: 'task', dueAt: wall(MON, '21:00') });
  assert.equal(k.keep.holding, false);
  assert.equal(k.timers.only()?.ms, 5 * 60 * 60_000, 'one timer: the night\'s start');
  k.fire();
  assert.equal(k.keep.holding, true);
  assert.deepEqual(k.f.holds, [KEEP_AWAKE_REASON]);
  assert.equal(k.timers.only()?.ms, 10 * 60 * 60_000, 'until planAt (10 h at most)');
  k.f.wakes.cancel('ag_x');
  assert.equal(k.keep.holding, false);
  assert.equal(k.f.awake(), 0);
});

test('turns running after hours hold the PC; their end with nothing queued lets go', () => {
  const k = awake(wall(MON, '22:00'));
  assert.equal(k.keep.holding, false);
  k.f.bus.emit('agent.activity', { active: [turn] });
  assert.equal(k.keep.holding, true);
  k.f.bus.emit('agent.activity', { active: [] });
  assert.equal(k.keep.holding, false);
  k.f.wakes.wake({ agentId: 'ag_x', reason: 'task', dueAt: wall('2026-10-27', '07:00') });
  assert.equal(k.keep.holding, false, 'due after the morning: nothing to stay awake for');
});

test('at most 10 h, then not again that night; the setting switches it; stop lets go', () => {
  const k = awake(wall(MON, '20:00'), { planAt: '08:00' });
  k.f.wakes.wake({ agentId: 'ag_x', reason: 'retry', dueAt: wall('2026-10-27', '07:30') });
  assert.equal(k.keep.holding, true);
  assert.equal(k.timers.only()?.ms, 10 * 60 * 60_000);
  k.fire();
  assert.equal(k.keep.holding, false, '06:00: ten hours');
  k.f.wakes.wake({ agentId: 'ag_y', reason: 'task' });
  assert.equal(k.keep.holding, false, 'not again before the next evening');
  const off = awake(wall(MON, '21:00'), { keepAwake: false });
  off.f.wakes.wake({ agentId: 'ag_x', reason: 'task' });
  assert.equal(off.keep.holding, false);
  off.f.setDay({ keepAwake: true });
  assert.equal(off.keep.holding, true);
  off.keep.stop();
  assert.equal(off.keep.holding, false);
  assert.equal(off.f.awake(), 0);
  assert.equal(off.timers.pending.length, 0);
});

test('a wake-up re-arms the one timer from the wall clock, also for the same edge', () => {
  const k = awake(wall(MON, '15:00'));
  k.f.wakes.wake({ agentId: 'ag_x', reason: 'task', dueAt: wall(MON, '21:00') });
  const first = k.timers.only()!;
  assert.equal(first.ms, 5 * 60 * 60_000);
  k.f.clock.set(wall(MON, '19:30'));
  for (const listener of k.f.powerListeners) listener('resume');
  const again = k.timers.only()!;
  assert.notEqual(again.id, first.id, 'a fresh timeout');
  assert.equal(again.ms, 30 * 60_000, 'the half hour left to workEnd');
  k.keep.stop();
});
