// B-076: this PC's side tabs watched from another PC or a phone (src/runtime/browser/side-view.ts) on a manual clock and
// a fake host: pulls are keyed by tab (a tab never gets another's frame), each pull renews the cast at most once per
// RENEW_MS and the last release turns it off PULL_GRACE_MS later; the owner gets a frame every 500 ms, a phone every
// 1000 ms, a linked PC passing on its caller keeps that caller's gap and slot; a failed cast is the state's reason and
// leaves no pull spinning; input lands on the newest frame's viewport in the page's CSS pixels (its zoom applied); a
// dialog the page opens travels in the state and its answer goes to main as nav.
// Owns: these assertions only. Never: real timers, Electron or a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RENEW_MS, SideViews, sideCaller, sideMeta, sideNavOf, sidePullOf } from '../../../src/runtime/browser/side-view.ts';
import { PULL_GRACE_MS, type PullTimers } from '../../../src/runtime/browser/view-pull.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { HostOps } from '../../../src/shared/api/host-bridge.ts';
import type { SideCastUpdate, SidePull } from '../../../src/shared/model/side-view.ts';

const A = 'web-aaaa';
const B = 'web-bbbb';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (error: unknown) => (error as { code?: string }).code;

function clock(): PullTimers & { advance(ms: number): Promise<void> } {
  let now = 10_000;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => { timers.delete(id as number); },
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

function rig() {
  const timers = clock();
  const casts: Array<HostOps['sideCast']['args']> = [];
  const inputs: Array<HostOps['sideInput']['args']> = [];
  const navs: Array<HostOps['sideNav']['args']> = [];
  let failWith: unknown;
  const host = {
    cast: async (args: HostOps['sideCast']['args']) => {
      casts.push(args);
      if (failWith && args.on) throw failWith;
      return { ok: true as const, page: { url: `https://site.example/${args.tab}`, title: 'Site', back: true, forward: false, loading: false } };
    },
    input: async (args: HostOps['sideInput']['args']) => { inputs.push(args); return { ok: true as const }; },
    nav: async (args: HostOps['sideNav']['args']) => { navs.push(args); return { ok: true as const }; },
  };
  const views = new SideViews({ host: () => host, pc: () => 'office-pc', timers });
  const update = (tab: string, data: string, meta: Partial<NonNullable<SideCastUpdate['frame']>['meta']> = {}) => views.update({
    tab, live: true, page: { url: `https://site.example/${tab}`, title: 'Site', back: true, forward: false, loading: false },
    frame: { data, meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, zoom: 1, ...meta } },
  });
  const pull = (who: string, tab: string, after: { state?: number; frame?: number } = {}, extra: { via?: string; waitMs?: number; signal?: AbortSignal } = {}) =>
    views.pull(sideCaller(who, extra.via), { tab, after, waitMs: extra.waitMs }, extra.signal ?? new AbortController().signal);
  return { timers, views, casts, inputs, navs, update, pull, fail: (error: unknown) => { failWith = error; } };
}

test('a pull renews the cast and answers the page and the PC; frames are kept per tab', async () => {
  const r = rig();
  const first = await r.pull('owner', A);
  assert.deepEqual(r.casts, [{ tab: A, on: true }]);
  assert.equal(first.state.pc, 'office-pc');
  assert.equal(first.state.url, `https://site.example/${A}`);
  assert.equal(first.state.back, true);
  assert.equal(first.state.live, true);
  assert.equal(first.frame, undefined);
  r.update(A, 'AAAA');
  const second = await r.pull('owner', A, { state: first.state.at });
  assert.equal(second.frame?.data, 'AAAA');
  assert.deepEqual([second.frame?.tab, second.frame?.width, second.frame?.height], [A, 1280, 800]);
  const other = await r.pull('owner', B);
  assert.equal(other.frame, undefined, 'tab B never gets tab A\'s frame');
  assert.equal(other.state.tab, B);
});

test('the owner (and a linked PC passing on its owner) gets a frame every 500 ms, a phone every 1000 ms', async () => {
  assert.deepEqual(sideCaller('owner'), { caller: 'owner', gapMs: 500 });
  assert.deepEqual(sideCaller('dev_phone'), { caller: 'dev_phone', gapMs: 1000 });
  assert.deepEqual(sideCaller('dev_b', 'owner'), { caller: 'dev_b/owner', gapMs: 500 });
  assert.deepEqual(sideCaller('dev_b', 'dev_phone'), { caller: 'dev_b/dev_phone', gapMs: 1000 });
  const r = rig();
  const start = await r.pull('dev_phone', A);
  r.update(A, 'F1');
  const one = await r.pull('dev_phone', A, { state: start.state.at });
  assert.equal(one.frame?.data, 'F1');
  await r.timers.advance(300);
  r.update(A, 'F2');
  let answered: SidePull | undefined;
  void r.pull('dev_phone', A, { state: one.state.at, frame: one.frame!.at }).then((reply) => { answered = reply; });
  await r.timers.advance(600);
  assert.equal(answered, undefined, 'a phone waits for its gap');
  await r.timers.advance(100);
  assert.equal((answered as SidePull | undefined)?.frame?.data, 'F2');
});

test('renewals come at most once per RENEW_MS; the cast is turned off PULL_GRACE_MS after the last pull', async () => {
  const r = rig();
  const first = await r.pull('owner', A);
  await r.pull('owner', A, {}, { waitMs: 1000 });
  assert.equal(r.casts.length, 1);
  await r.timers.advance(RENEW_MS);
  const third = r.pull('owner', A, { state: first.state.at }, { waitMs: 1000 });
  assert.deepEqual(r.casts.map((c) => c.on), [true, true]);
  await r.timers.advance(1000);
  assert.equal((await third).frame, undefined, 'the wait ran out unchanged');
  await r.timers.advance(PULL_GRACE_MS + 1000);
  assert.deepEqual(r.casts.at(-1), { tab: A, on: false });
  r.update(A, 'LATE');
  assert.equal((await r.views.current(A)).frame, undefined, 'nothing is kept for a tab nobody watches');
});

test('a failed cast is the state\'s reason, and a pull past it waits instead of spinning', async () => {
  const r = rig();
  r.fail(new WorkforceError('not_found', 'This tab is not open on its PC any more.'));
  const first = await r.pull('owner', A);
  assert.equal(first.state.open, false);
  assert.equal(first.state.live, false);
  assert.match(first.state.error ?? '', /not open/);
  await r.timers.advance(RENEW_MS);
  let answered = false;
  void r.pull('owner', A, { state: first.state.at }, { waitMs: 3000 }).then(() => { answered = true; });
  await r.timers.advance(2000);
  assert.equal(answered, false, 'the same failure again is no change');
  assert.equal(r.casts.length, 2, 'but it was tried again');
  await r.timers.advance(1000);
  assert.equal(answered, true);
});

test('input lands on the newest frame in the page\'s CSS pixels (zoom applied), one at a time; a click needs a picture', async () => {
  const r = rig();
  await assert.rejects(r.views.input(A, { kind: 'mouse', type: 'down', x: 1, y: 1, width: 10, height: 10 }), (error: unknown) => code(error) === 'conflict');
  await r.views.input(A, { kind: 'text', text: 'hello' });
  assert.deepEqual(r.inputs.at(-1), { tab: A, commands: [{ method: 'Input.insertText', params: { text: 'hello' } }] });
  await r.pull('owner', A);
  r.update(A, 'Z', { zoom: 2 });
  await r.views.input(A, { kind: 'mouse', type: 'down', x: 640, y: 200, width: 1280, height: 800, button: 'left' });
  const params = r.inputs.at(-1)!.commands[0]!.params;
  assert.deepEqual([params.type, params.x, params.y], ['mousePressed', 320, 100]);
  await r.views.input(A, { kind: 'wheel', x: 1280, y: 800, width: 1280, height: 800, deltaX: 0, deltaY: 120 });
  assert.deepEqual([r.inputs.at(-1)!.commands[0]!.params.x, r.inputs.at(-1)!.commands[0]!.params.y], [640, 400]);
  await r.views.nav(A, { action: 'reload' });
  assert.deepEqual(r.navs, [{ tab: A, action: 'reload' }]);
});

test('without a host that can open windows every call says so', async () => {
  const views = new SideViews({ host: () => undefined, pc: () => 'cli-box', timers: clock() });
  const first = await views.pull(sideCaller('owner'), { tab: A }, new AbortController().signal);
  assert.equal(first.state.open, false);
  assert.match(first.state.error ?? '', /app window/);
  await assert.rejects(views.nav(A, { action: 'back' }), (error: unknown) => code(error) === 'unavailable');
});

test('params: a web tab id, the frame limits, exactly one of url or action; the zoom divides the viewport', () => {
  assert.equal(sidePullOf({ tab: A }).request.maxBytes, 1024 * 1024);
  assert.throws(() => sidePullOf({ tab: 't1' }), (error: unknown) => code(error) === 'bad_request');
  assert.throws(() => sidePullOf({ tab: A, maxBytes: 10 }), (error: unknown) => code(error) === 'bad_request');
  assert.throws(() => sidePullOf({ tab: A, extra: 1 }), (error: unknown) => code(error) === 'bad_request');
  assert.deepEqual(sideNavOf({ url: ' news.example ' }), { url: 'news.example' });
  for (const bad of [{}, { url: 'a', action: 'back' }, { action: 'stop' }, { url: 'a\nb' }]) assert.throws(() => sideNavOf(bad), (error: unknown) => code(error) === 'bad_request');
  assert.deepEqual(sideMeta({ deviceWidth: 1000, deviceHeight: 500, offsetTop: 10, pageScaleFactor: 1, zoom: 1.25 }), { width: 800, height: 400, offsetTop: 8, scale: 1 });
  assert.equal(sideMeta({ deviceWidth: 0, deviceHeight: 500, offsetTop: 0, pageScaleFactor: 1, zoom: 1 }), undefined);
});

test('a dialog the page opens is part of the state the watcher pulls; its answer goes to main as nav; it clears with the next page', async () => {
  const r = rig();
  const first = await r.pull('owner', A);
  assert.equal(first.state.dialog, undefined);
  r.views.update({ tab: A, live: true, page: { url: `https://site.example/${A}`, title: 'Site', back: true, forward: false, loading: false, dialog: { type: 'confirm', message: 'Delete?' } } });
  const asked = await r.pull('owner', A, { state: first.state.at });
  assert.deepEqual(asked.state.dialog, { type: 'confirm', message: 'Delete?' });
  await r.views.nav(A, { dialog: 'accept' });
  assert.deepEqual(r.navs.at(-1), { tab: A, dialog: 'accept' });
  r.views.update({ tab: A, live: true, page: { url: `https://site.example/${A}`, title: 'Site', back: true, forward: false, loading: false } });
  const answered = await r.pull('owner', A, { state: asked.state.at });
  assert.equal('dialog' in answered.state, false, 'gone once main says the page has none');
  assert.deepEqual(sideNavOf({ dialog: 'dismiss' }), { dialog: 'dismiss' });
  for (const bad of [{ dialog: 'later' }, { dialog: 'accept', action: 'reload' }]) assert.throws(() => sideNavOf(bad), (error: unknown) => code(error) === 'bad_request');
});
