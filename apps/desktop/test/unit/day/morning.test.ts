// B-041 track A2: the morning run (runtime/day/morning.ts) – one timer to the next planAt in the profile zone; at
// planAt: plan today, then the briefing; a run missed while the PC was off or asleep happens shortly after start or
// wake-up (never inside start(), never after the working day); kv day/planned keeps start, resume, the timer and a
// manual plan from planning a day twice; a failing plan is not retried in a loop; autoPlan off arms nothing;
// settings changes and resume re-arm; stop clears the timer.
// Owns: checks of MorningPlan only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { DaySettings } from '../../../src/shared/model/day-settings.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { MorningPlan } from '../../../src/runtime/day/morning.ts';
import { plannedDate } from '../../../src/runtime/day/plan.ts';
import { FakeTimers } from '../chat/harness.ts';
import { BERLIN, dayFixture } from './fixture.ts';

const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), BERLIN);
const TUE = '2026-10-27';
const CATCH_UP = 1_000;

function morning(now: number, day: Partial<DaySettings> = {}) {
  const f = dayFixture({ now, day });
  const timers = new FakeTimers();
  let plans = 0;
  const real = f.day.plan.bind(f.day);
  f.day.plan = async (...args) => { plans++; return real(...args); };
  const run = new MorningPlan(f.s, { timers, catchUpMs: CATCH_UP });
  /** Fires the armed timer at its moment and waits for the run. */
  const fire = async () => { const timer = timers.only(); assert.ok(timer, 'a timer is armed'); f.clock.advance(timer.ms); timers.fire(); await settle(); };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  return { f, timers, run, fire, settle, plans: () => plans };
}

test('armed for planAt; the run plans today and writes the briefing, then waits for tomorrow', async () => {
  const m = morning(wall(TUE, '05:00'));
  await m.f.day.add({ text: 'Wäsche waschen' }, HUMAN_ID);
  m.run.start();
  assert.equal(m.timers.only()?.ms, 60 * 60_000, 'one timer, to 06:00');
  assert.equal(m.plans(), 0, 'start only arms');
  await m.fire();
  assert.equal(m.plans(), 1);
  assert.equal(plannedDate(m.f.s, HUMAN_ID), TUE);
  assert.equal(m.f.calendar.events.length, 1, 'the to-do got its block');
  assert.ok(m.f.day.briefing(HUMAN_ID, TUE), 'and the briefing is there');
  assert.equal(m.timers.only()?.ms, 24 * 60 * 60_000, 'tomorrow at 06:00');
  m.run.stop();
  assert.equal(m.timers.pending.length, 0);
});

test('missed while the PC was off: it runs shortly after start, once; start and resume afterwards do not plan again', async () => {
  const m = morning(wall(TUE, '07:30'));
  m.run.start();
  assert.equal(m.timers.only()?.ms, CATCH_UP);
  await m.fire();
  assert.equal(m.plans(), 1);
  m.run.stop();
  m.run.start();
  for (const listener of m.f.powerListeners) listener('resume');
  assert.equal(m.timers.only()?.ms, wall('2026-10-28', '06:00') - m.f.clock.now(), 'planned already: tomorrow');
  assert.equal(m.plans(), 1);
});

test('a manual plan before planAt: the run only writes the briefing; after work nothing is caught up', async () => {
  const m = morning(wall(TUE, '05:30'));
  m.run.start();
  await m.f.day.plan(HUMAN_ID, TUE, 'plan');
  await m.fire();
  assert.equal(m.plans(), 1, 'the person\'s plan counts');
  assert.ok(m.f.day.briefing(HUMAN_ID, TUE));
  const late = morning(wall(TUE, '21:00'));
  late.run.start();
  assert.equal(late.timers.only()?.ms, wall('2026-10-28', '06:00') - wall(TUE, '21:00'), 'the day is over: tomorrow');
});

test('autoPlan off arms nothing; switching it on, changing planAt and waking up re-arm the one timer', async () => {
  const m = morning(wall(TUE, '05:00'), { autoPlan: false });
  m.run.start();
  assert.equal(m.timers.pending.length, 0);
  m.f.setDay({ autoPlan: true });
  assert.equal(m.timers.only()?.ms, 60 * 60_000);
  m.f.setDay({ planAt: '05:30' });
  assert.equal(m.timers.only()?.ms, 30 * 60_000);
  m.f.clock.set(wall(TUE, '07:00')); // the PC slept through 05:30
  for (const listener of m.f.powerListeners) listener('resume');
  assert.equal(m.timers.only()?.ms, CATCH_UP);
  m.f.setDay({ autoPlan: false });
  assert.equal(m.timers.pending.length, 0);
});

test('a plan that fails is tried once that day, not in a loop', async () => {
  const m = morning(wall(TUE, '07:00'));
  m.f.day.plan = async () => { throw new Error('calendar down'); };
  m.run.start();
  await m.fire();
  assert.equal(plannedDate(m.f.s, HUMAN_ID), TUE, 'recorded: the person can press Plan');
  assert.ok(m.f.day.briefing(HUMAN_ID, TUE), 'the briefing still comes');
  assert.equal(m.timers.only()?.ms, wall('2026-10-28', '06:00') - m.f.clock.now());
});

test('a wake-up before planAt re-arms from the wall clock, also for the same planAt (the old timer ran late by the sleep)', async () => {
  const m = morning(wall('2026-10-26', '22:00'));
  m.run.start();
  const first = m.timers.only()!;
  assert.equal(first.ms, 8 * 60 * 60_000, 'to 06:00');
  m.f.clock.set(wall(TUE, '05:45')); // asleep from 23:00 to 05:45: the armed timeout did not count down
  for (const listener of m.f.powerListeners) listener('resume');
  const again = m.timers.only()!;
  assert.notEqual(again.id, first.id, 'a fresh timeout');
  assert.equal(again.ms, 15 * 60_000, 'the 15 minutes left to 06:00');
  for (const listener of m.f.powerListeners) listener('unlock');
  assert.equal(m.timers.only()?.ms, 15 * 60_000);
  m.run.stop();
});
