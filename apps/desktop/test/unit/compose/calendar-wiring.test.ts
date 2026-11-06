// B-041 My day wiring (src/runtime/compose/calendar.ts, compose/lifecycle.ts): createCalendar puts the calendar,
// the connected sources, the estimates and the day service on RuntimeServices and starts their listeners and
// timers – the check-off listener (calendar/task-link.ts), the sources' start sync and power triggers, the day
// service's focus listener, the morning run and keep-awake; stopCalendar takes every one of them back (no live
// subscription, no armed timer), and the lifecycle stops My day right after the realtime calls, before the engines.
// Owns: these assertions only. Never: real engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, stopCalendar } from '../../../src/runtime/compose/calendar.ts';
import { stopSteps } from '../../../src/runtime/compose/lifecycle.ts';
import type { Network } from '../../../src/runtime/compose/network.ts';
import type { Core } from '../../../src/runtime/compose/services.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';

/** Counts live subscriptions made through `target[method]` (each returns its own unsubscribe). */
function countSubscriptions<T extends object>(target: T, method: keyof T): { live: () => number } {
  let live = 0;
  const original = (target[method] as unknown as (...args: unknown[]) => () => void).bind(target);
  (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
    const off = original(...args);
    live++;
    let done = false;
    return () => { if (!done) { done = true; live--; } off(); };
  };
  return { live: () => live };
}

/** Tracks timers armed while `run` and later calls happen: armed minus cleared minus fired. */
function trackTimers() {
  const armed = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSet((...args: unknown[]) => { armed.delete(handle); fn(...args); }, ms, ...rest);
    armed.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => { armed.delete(handle); realClear(handle); }) as typeof clearTimeout;
  return { armed: () => armed.size, restore: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; } };
}

test('createCalendar starts every My day part; stopCalendar leaves no listener and no armed timer behind', (t) => {
  const f = rpcFixture();
  const timers = trackTimers();
  t.after(() => { timers.restore(); stopCalendar(f.services); f.cleanup(); });
  const s = f.services as RuntimeServices;
  const bus = countSubscriptions(s.bus, 'on');
  const power = countSubscriptions(s.host, 'onPower');
  const wakes = countSubscriptions(s.wakes, 'onChange');
  createCalendar(s);
  assert.ok(s.calendar && s.calendarSources && s.estimates && s.day, 'every service is on RuntimeServices');
  assert.ok(bus.live() >= 4, `task-link, focus, morning and keep-awake listen on the bus (${bus.live()})`);
  assert.ok(power.live() >= 3, 'the sources, the morning run and keep-awake hear resume/unlock');
  assert.equal(wakes.live(), 1, 'keep-awake follows the wake queue');
  assert.ok(timers.armed() >= 2, 'the sources\' start sync and the morning run are armed');
  stopCalendar(s);
  assert.deepEqual([bus.live(), power.live(), wakes.live(), timers.armed()], [0, 0, 0, 0]);
  stopCalendar(s); // twice is harmless
});

test('the lifecycle stops My day right after the realtime calls, before the engines', () => {
  const services = new Proxy({}, { get: () => ({}) });
  const steps = stopSteps({ services } as unknown as Core, new Proxy({}, { get: () => undefined }) as unknown as Network);
  const names = steps.map((step) => step.name);
  assert.equal(names[names.indexOf('calls') + 1], 'my day', names.join(', '));
  assert.ok(names.indexOf('my day') < names.indexOf('engines'), names.join(', '));
});
