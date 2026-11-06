// CPU watchdog for ```app frames: long-task busy time, heartbeat misses (only once armed),
// host lateness, pause/resume, one trip only, a longer heartbeat limit that keeps the long-task
// rule, at most two pings out while a frame is quiet; and the shared long-task fan-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuWatchdog, LongTaskHub, WATCHDOG } from '../../../src/ui/blocks/app-watchdog.ts';
import type { LongTaskEntry, TripReason } from '../../../src/ui/blocks/app-watchdog.ts';

/** Manual timers: `advance` runs due timers in order; `stall` moves time without running them. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  let queue: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    timers: {
      now: () => now,
      set: (fn: () => void, ms: number) => { const id = ++seq; queue.push({ id, at: now + ms, fn }); return id; },
      clear: (handle: unknown) => { queue = queue.filter((timer) => timer.id !== handle); },
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
    },
    stall(ms: number) { now += ms; },
    get pending() { return queue.length; },
    get now() { return now; },
  };
}

function setup() {
  const clock = fakeTimers();
  const pings: string[] = [];
  const trips: TripReason[] = [];
  const dog = new CpuWatchdog({ ping: (id) => pings.push(id), onTrip: (reason) => trips.push(reason), timers: clock.timers });
  return { clock, pings, trips, dog };
}

test('long tasks: more than 2 s busy within the window trips once', () => {
  const { dog, trips } = setup();
  dog.longTask(0, 900);
  dog.longTask(1000, 900);
  assert.deepEqual(trips, []);
  dog.longTask(2000, 300); // 2100 ms busy within 3 s
  assert.deepEqual(trips, ['long-tasks']);
  dog.longTask(2400, 3000);
  assert.deepEqual(trips, ['long-tasks'], 'only once');
  assert.equal(dog.isTripped, true);
});

test('long tasks: spread-out work does not trip, one very long task does', () => {
  const quiet = setup();
  for (let at = 0; at < 30_000; at += 1000) quiet.dog.longTask(at, 400);
  assert.deepEqual(quiet.trips, []);
  const stuck = setup();
  stuck.dog.longTask(5000, WATCHDOG.busyMs + 100);
  assert.deepEqual(stuck.trips, ['long-tasks']);
  stuck.dog.longTask(9000, 0);
});

test('heartbeat: answered pings keep the frame alive', () => {
  const { dog, clock, pings, trips } = setup();
  dog.start();
  assert.equal(pings.length, 1);
  for (let i = 0; i < 5; i++) {
    clock.advance(50);
    dog.alive();
    clock.advance(WATCHDOG.pingEveryMs);
  }
  assert.equal(pings.length, 6);
  assert.deepEqual(trips, []);
});

test('heartbeat: an armed frame that stops answering trips after 2 s with a second chance first', () => {
  const { dog, clock, pings, trips } = setup();
  dog.start();
  clock.advance(10);
  dog.alive(); // armed
  clock.advance(WATCHDOG.pingEveryMs); // next ping, never answered
  const before = pings.length;
  clock.advance(WATCHDOG.answerMs);
  assert.deepEqual(trips, []);
  assert.equal(pings.length, before + 1, 'pinged again before giving up');
  clock.advance(WATCHDOG.answerMs);
  assert.deepEqual(trips, ['heartbeat']);
  assert.equal(clock.pending, 0, 'no timers left after a trip');
});

test('heartbeat: a frame that never answered is not frozen, and arms on its first late answer', () => {
  const { dog, clock, pings, trips } = setup();
  dog.start();
  clock.advance(10_000);
  assert.deepEqual(trips, []);
  assert.equal(pings.length, 1, 'no ping storm while unanswered');
  assert.equal(clock.pending, 0);
  dog.alive();
  clock.advance(WATCHDOG.pingEveryMs);
  assert.equal(pings.length, 2, 'pinging resumes after the first answer');
});

test('heartbeat: a late host timer is the host being busy – measure again instead of tripping', () => {
  const { dog, clock, trips } = setup();
  dog.start();
  clock.advance(10);
  dog.alive();
  clock.advance(WATCHDOG.pingEveryMs); // ping out
  clock.stall(WATCHDOG.answerMs * 3); // host blocked: our check runs 2 s late
  clock.advance(0);
  assert.deepEqual(trips, []);
  clock.advance(100);
  dog.alive();
  assert.deepEqual(trips, []);
});

test('heartbeat: paused while hidden, fresh measurement on resume; start() re-arms after a reload', () => {
  const { dog, clock, pings, trips } = setup();
  dog.start();
  clock.advance(10);
  dog.alive();
  dog.pause();
  clock.advance(60_000);
  assert.equal(pings.length, 1);
  assert.deepEqual(trips, []);
  dog.resume();
  assert.equal(pings.length, 2);
  clock.advance(10);
  dog.alive();
  dog.start(); // the app initialized again (reload): unarmed until it answers
  clock.advance(10_000);
  assert.deepEqual(trips, []);
  dog.stop();
  dog.resume();
  assert.equal(clock.pending, 0, 'stop() ends everything; resume needs a new start');
});

test('long-task hub: one observer while frames are watched, fan-out by container id', () => {
  let started = 0;
  let stopped = 0;
  let push: ((entries: LongTaskEntry[]) => void) | undefined;
  const hub = new LongTaskHub((onEntries) => { started++; push = onEntries; return () => { stopped++; }; });
  const seen: string[] = [];
  const offA = hub.watch('frame-a', (start, duration) => seen.push(`a:${start}+${duration}`));
  const offB = hub.watch('frame-b', () => { throw new Error('broken frame'); });
  assert.equal(started, 1);
  push!([{ startTime: 10, duration: 80, containers: ['frame-a', 'frame-a'] }, { startTime: 20, duration: 60, containers: ['frame-b', 'other'] }]);
  assert.deepEqual(seen, ['a:10+80']);
  offA();
  assert.equal(stopped, 0);
  offB();
  assert.equal(stopped, 1);
  assert.equal(hub.active, false);
  const unsupported = new LongTaskHub(() => null);
  const off = unsupported.watch('x', () => undefined);
  assert.equal(unsupported.active, false);
  off();
});

test('a longer heartbeat limit (a frame in its own process) leaves the long-task rule at 2 s', () => {
  const clock = fakeTimers();
  const trips: TripReason[] = [];
  const limits = { heartbeatMs: 30_000 };
  const quiet = new CpuWatchdog({ ping: () => undefined, onTrip: (reason) => trips.push(reason), timers: clock.timers, limits });
  quiet.start();
  quiet.alive(); // answered once: armed
  clock.advance(WATCHDOG.pingEveryMs + 29_000);
  assert.equal(trips.length, 0, 'quiet for 29 s: still waiting');
  clock.advance(1_000 + WATCHDOG.answerMs);
  assert.deepEqual(trips, ['heartbeat'], 'quiet for 30 s: stopped');
  const busy = new CpuWatchdog({ ping: () => undefined, onTrip: (reason) => trips.push(reason), timers: clock.timers, limits });
  busy.longTask(0, WATCHDOG.busyMs + 100);
  assert.deepEqual(trips, ['heartbeat', 'long-tasks'], 'long tasks on the app thread still trip after 2 s');
  assert.equal(WATCHDOG.heartbeatMs, WATCHDOG.busyMs, '```app frames keep 2 s for both');
});

test('a quiet frame gets one ping and one second chance, never a ping a second – also with a late host', () => {
  // A frame starved by a big compile: when it runs again it answers every ping it got at
  // once, and each extra answer would count against its message limit.
  const clock = fakeTimers();
  const pings: string[] = [];
  const trips: TripReason[] = [];
  const dog = new CpuWatchdog({ ping: (id) => pings.push(id), onTrip: (reason) => trips.push(reason), timers: clock.timers, limits: { heartbeatMs: 30_000 } });
  dog.start();
  for (let episode = 0; episode < 9; episode++) {
    dog.alive(); // it answers (episode 0: armed)
    const answered = pings.length;
    clock.advance(WATCHDOG.pingEveryMs + 1500); // the next ping and its second chance go out; then it is starved
    clock.stall(3000); // the host's own check runs 3 s late (the compile slows it too): measured again, no new ping
    clock.advance(20_000); // 25.5 s without an answer
    assert.deepEqual(trips, [], `episode ${episode}: within 30 s`);
    assert.equal(pings.length - answered, 2, `episode ${episode}: two pings to answer when it wakes up`);
  }
  dog.alive();
  clock.advance(WATCHDOG.pingEveryMs + 30_000 - 1);
  assert.deepEqual(trips, [], 'quiet for just under 30 s');
  clock.advance(1);
  assert.deepEqual(trips, ['heartbeat'], 'quiet for 30 s: stopped');
  assert.equal(clock.pending, 0);
});
