// Pulled frames for phones (browser/view-pull.ts) on a manual clock and timers: a device gets one frame,
// then the newest one no earlier than DEVICE_FRAME_GAP_MS later; a state change answers at once;
// waitMs ends a pull with the state unchanged; a frame above maxBytes travels in parts that join to the original and are gone after a newer pull; the
// screencast (fake CDP) stops PULL_GRACE_MS after the last pull; nothing is left listening or
// waiting once a pull resolved or its caller went away.
// Owns: these assertions only. Never: real timers, a real browser or a socket.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPulls, OWNER_CALLER, PULL_GRACE_MS, type PullTimers, type PullViews } from '../../../src/runtime/browser/view-pull.ts';
import { BrowserView } from '../../../src/runtime/browser/view.ts';
import { DEVICE_FRAME_GAP_MS, type BrowserFrame, type BrowserPull, type BrowserViewState } from '../../../src/shared/model/browser.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { cleanup, fakeBrowser, fakeSecrets, recordingBus, tick } from './view-fakes.ts';

after(cleanup);

/** One-shot timers fired by due time while the clock advances. */
function clock(): PullTimers & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 10_000;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => { timers.delete(id as number); },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await tick();
      }
      now = end;
      await tick();
    },
  };
}

/** A bus that counts its listeners. */
function countingBus() {
  const listeners = new Map<string, Set<(data: never) => void>>();
  return {
    on(event: string, listener: (data: never) => void) {
      const set = listeners.get(event) ?? listeners.set(event, new Set()).get(event)!;
      set.add(listener);
      return () => { set.delete(listener); };
    },
    emit(event: string, data: unknown) { for (const listener of [...(listeners.get(event) ?? [])]) listener(data as never); },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

/** Views whose state and frame the test sets; counts the watches held. */
function views(timers: PullTimers) {
  let state: BrowserViewState = { agentId: 'ag_1', open: true, tabs: [], live: true, at: timers.now() };
  let frame: BrowserFrame | undefined;
  let leases = 0;
  const fake: PullViews & { leases(): number } = {
    watch: () => { leases++; let released = false; return () => { if (!released) { released = true; leases--; } }; },
    current: async () => ({ state, frame }),
    leases: () => leases,
  };
  const setFrame = (data: string) => { frame = { agentId: 'ag_1', tab: 't1', data, width: 1280, height: 720, at: timers.now() }; return frame; };
  const setState = (patch: Partial<BrowserViewState>) => { state = { ...state, ...patch, at: timers.now() }; return state; };
  return { fake, setFrame, setState, state: () => state };
}

function rig() {
  const timers = clock();
  const bus = countingBus();
  const pulls = new BrowserPulls({ bus, timers });
  const v = views(timers);
  const pull = (after: { state?: number; frame?: number } = {}, extra: { maxBytes?: number; waitMs?: number; signal?: AbortSignal } = {}) =>
    pulls.pull('dev_pixel', v.fake, { agentId: 'ag_1', after, maxBytes: extra.maxBytes, waitMs: extra.waitMs }, extra.signal ?? new AbortController().signal);
  return { timers, bus, pulls, v, pull };
}

/** Lets a pending pull run until it waits (or resolved). */
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await tick(); }

test('a device gets one frame, then the newest no earlier than DEVICE_FRAME_GAP_MS after the first', async () => {
  const { timers, bus, v, pull } = rig();
  const first = v.setFrame('A1');
  const got = await pull({ state: v.state().at });
  assert.equal(got.frame?.data, 'A1');
  const sentAt = timers.now();
  await timers.advance(300);
  v.setFrame('A2');
  let second: BrowserPull | undefined;
  void pull({ state: v.state().at, frame: first.at }).then((value) => { second = value; });
  const secondNow = () => second;
  await settle();
  bus.emit('browser.frame', { agentId: 'ag_1', tab: 't1' });
  await settle();
  assert.equal(secondNow(), undefined, 'the gap is not over yet');
  await timers.advance(300);
  v.setFrame('A3');
  bus.emit('browser.frame', { agentId: 'ag_1', tab: 't1' });
  await settle();
  assert.equal(secondNow(), undefined);
  await timers.advance(DEVICE_FRAME_GAP_MS - 600);
  await settle();
  assert.equal(second?.frame?.data, 'A3', 'the newest frame');
  assert.ok(timers.now() >= sentAt + DEVICE_FRAME_GAP_MS);
});

test('a state change answers at once (without a frame not yet due); waitMs ends a pull unchanged', async () => {
  const { timers, bus, v, pull } = rig();
  const frame = v.setFrame('B1');
  await pull({ state: v.state().at });
  let answer: BrowserPull | undefined;
  void pull({ state: v.state().at, frame: frame.at }).then((value) => { answer = value; });
  await settle();
  await timers.advance(100);
  v.setFrame('B2');
  const changed = v.setState({ tabs: [{ tab: 't1', url: 'https://a.example', title: 'A', active: true }] });
  bus.emit('browser.view', changed);
  await settle();
  assert.equal(answer?.state.at, changed.at, 'answered at once');
  assert.equal(answer?.frame, undefined, 'the newer frame is not due yet');

  let idle: BrowserPull | undefined;
  void pull({ state: changed.at, frame: frame.at }, { waitMs: 1000 }).then((value) => { idle = value; });
  const idleNow = () => idle;
  await settle();
  bus.emit('browser.view', { agentId: 'ag_other' }); // another browser: ignored
  await timers.advance(899);
  assert.equal(idleNow(), undefined);
  await timers.advance(1);
  await settle();
  assert.equal(idle?.frame?.data, 'B2', 'the waiting frame once the gap is over');
});

test('waitMs elapses: the state unchanged, no frame', async () => {
  const { timers, v, pull } = rig();
  let idle: BrowserPull | undefined;
  void pull({ state: v.state().at }, { waitMs: 1000 }).then((value) => { idle = value; });
  const idleNow = () => idle;
  await settle();
  await timers.advance(999);
  assert.equal(idleNow(), undefined);
  await timers.advance(1);
  await settle();
  assert.deepEqual(idle, { state: v.state() });
});

test('a frame above maxBytes: part 0 and parts n; the parts join to the original; a newer pull drops them', async () => {
  const { pulls, v, pull } = rig();
  const data = 'x'.repeat(1000) + 'y'.repeat(1000) + 'z'.repeat(500);
  const frame = v.setFrame(data);
  const got = await pull({}, { maxBytes: 1000 });
  assert.equal(got.parts, 3);
  assert.equal(got.frame?.data, 'x'.repeat(1000));
  const part = (index: number, at = frame.at) => pulls.part('dev_pixel', { agentId: 'ag_1', at, index }).data;
  assert.equal(got.frame!.data + part(1) + part(2), data);
  const gone = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && /That picture is gone/.test(error.message));
  gone(() => part(3));
  gone(() => part(1, frame.at + 1));
  gone(() => pulls.part(OWNER_CALLER, { agentId: 'ag_1', at: frame.at, index: 1 })); // another caller's cache
  await pull({ state: v.state().at, frame: frame.at }, { waitMs: 1000, signal: AbortSignal.abort() });
  gone(() => part(1));
});

test('nothing is left listening or waiting after a pull resolved or its caller left; the watch ends PULL_GRACE_MS later', async () => {
  const { timers, bus, v, pull } = rig();
  const frame = v.setFrame('C1');
  await pull();
  assert.equal(bus.count(), 0);
  const caller = new AbortController();
  const pending = pull({ state: v.state().at, frame: frame.at }, { signal: caller.signal });
  await settle();
  assert.equal(bus.count(), 2, 'waiting on browser.view and browser.frame');
  assert.equal(v.fake.leases(), 2, 'the first pull is still in its grace');
  caller.abort();
  await pending;
  assert.equal(bus.count(), 0, 'no listener after an abort');
  assert.equal(timers.pending(), 2, 'only the two grace releases');
  await timers.advance(PULL_GRACE_MS);
  assert.equal(v.fake.leases(), 0);
  assert.equal(timers.pending(), 0);
});

test('the screencast (fake CDP) stops PULL_GRACE_MS after the last pull', async () => {
  const timers = clock();
  const { browser, contexts } = fakeBrowser();
  const recorded = recordingBus();
  const view = new BrowserView({
    browser, services: () => ({ bus: recorded.bus, log: { debug() {}, info() {}, warn() {}, error() {} }, secrets: fakeSecrets() }) as never,
    now: timers.now, setTimer: timers.set, clearTimer: timers.clear,
  });
  await browser.open('ag_1', { url: 'https://example.com' });
  const pulls = new BrowserPulls({ bus: countingBus(), timers });
  const local: PullViews = { watch: (agentId) => view.watch(agentId), current: (agentId) => view.current(agentId) };
  const got = await pulls.pull('dev_pixel', local, { agentId: 'ag_1' }, new AbortController().signal);
  assert.equal(got.state.live, true);
  const cdp = contexts[0].cdps[0];
  await timers.advance(PULL_GRACE_MS - 1);
  await view.current('ag_1');
  assert.equal(cdp.methods().includes('Page.stopScreencast'), false, 'still watched within the grace');
  await timers.advance(1);
  await view.current('ag_1');
  await settle();
  assert.equal(cdp.methods().includes('Page.stopScreencast'), true, 'a phone that stopped pulling ends the screencast');
});
