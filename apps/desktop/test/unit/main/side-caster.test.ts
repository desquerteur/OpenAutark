// B-076: a side tab watched from another PC or a phone (src/main/side-driver/caster.ts) on a fake DevTools debugger and a
// manual clock: only the three Input commands pass, an address is made absolute like the address field does; `on` starts
// the screencast with the agents' live-view settings (JPEG 60, ≤ 1280 px) and the page focused, every frame is acknowledged
// at once and at most one per 500 ms – the newest – goes on with the page; the cast ends a minute after the last renewal
// or at `on: false`; input is the person's (agents yield, a press keeps the tab) and a failure never echoes it. A dialog
// the page opens travels with the page, input waits for its answer and the watcher gives it; a watch that ends lets the
// page leave the off-screen host (a page made anew stays), and the watcher's wake is no agent's use.
// Owns: these assertions only. Never: Electron, real pages or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAST_FRAME_GAP_MS, CAST_IDLE_MS, CAST_INPUT_METHODS, SideCaster, castCommands, castNav } from '../../../src/main/side-driver/caster.ts';
import { DEVTOOLS_BUSY } from '../../../src/main/side-driver/cdp.ts';
import { SideDriver } from '../../../src/main/side-driver/driver.ts';
import { SideTab } from '../../../src/main/side-driver/tab.ts';
import type { SideCastUpdate } from '../../../src/shared/model/side-view.ts';
import { HOST_OPS, parseMainMessage, parseRuntimeMessage, type HostRequest } from '../../../src/shared/api/host-bridge.ts';
import { HostServices, type HostServicesDeps } from '../../../src/main/host-services.ts';
import { FakeContents, fakeBrowser } from './side-driver-fakes.ts';

const TAB = 'web-1234';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (error: unknown) => (error as { code?: string }).code;

function manual() {
  const clock = { now: 50_000 };
  let seq = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    clock,
    set: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { fn, at: clock.now + ms }); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    advance(ms: number) {
      const end = clock.now + ms;
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock.now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
      }
      clock.now = end;
    },
  };
}

function rig() {
  const timers = manual();
  const contents = new FakeContents(timers.clock);
  let tab: SideTab | undefined = new SideTab(TAB, contents, { now: () => timers.clock.now, person: () => {} });
  const updates: SideCastUpdate[] = [];
  const kept: string[] = [];
  const released: string[] = [];
  const caster = new SideCaster({
    tab: (id) => (id === TAB ? tab : undefined), keep: (id) => { kept.push(id); }, release: (id) => { released.push(id); }, send: (update) => { updates.push(update); },
    now: () => timers.clock.now, setTimer: timers.set, clearTimer: timers.clear,
  });
  const frame = (sessionId: number, data: string, metadata: Record<string, unknown> = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 }) =>
    contents.debugger.emit('Page.screencastFrame', { sessionId, data, metadata });
  return { timers, contents, dbg: contents.debugger, caster, updates, kept, released, frame, tab: () => tab, setTab: (next: SideTab | undefined) => { tab = next; } };
}

const mouse = (type: string) => ({ method: 'Input.dispatchMouseEvent', params: { type, x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } });

test('only Input.dispatchMouseEvent, dispatchKeyEvent and insertText pass, 1–8 at a time with small plain params', () => {
  assert.deepEqual([...CAST_INPUT_METHODS].sort(), ['Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText']);
  assert.deepEqual(castCommands([mouse('mousePressed'), { method: 'Input.insertText', params: { text: 'hi' } }]).map((c) => c.method), ['Input.dispatchMouseEvent', 'Input.insertText']);
  for (const bad of [
    [{ method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }],
    [{ method: 'Page.navigate', params: { url: 'https://x.example' } }],
    [{ method: 'Input.dispatchTouchEvent', params: {} }],
    [], Array.from({ length: 9 }, () => mouse('mouseMoved')),
    [{ method: 'Input.insertText', params: ['x'] }], [{ method: 'Input.insertText' }],
    [{ method: 'Input.insertText', params: { text: 'x'.repeat(9000) } }], 'Input.insertText', null,
  ]) assert.throws(() => castCommands(bad), (error: unknown) => code(error) === 'bad_request', JSON.stringify(bad).slice(0, 60));
});

test('sideNav takes exactly one of an http(s) address (made absolute) or back / forward / reload, for a web tab', () => {
  assert.equal(castNav({ tab: TAB, url: 'example.com' }).url, 'https://example.com/');
  assert.deepEqual(castNav({ tab: TAB, action: 'back' }), { tab: TAB, action: 'back' });
  for (const bad of [{ tab: TAB }, { tab: TAB, url: 'https://a.example', action: 'reload' }, { tab: TAB, action: 'stop' }, { tab: TAB, url: 'javascript:alert(1)' },
    { tab: TAB, url: 'file:///C:/x' }, { tab: 't1', action: 'reload' }, { tab: 'web-../x', action: 'reload' }]) {
    assert.throws(() => castNav(bad), (error: unknown) => code(error) === 'bad_request', JSON.stringify(bad));
  }
});

test('on: the page wakes, the screencast runs with the live-view settings and the page counts as focused', async () => {
  const r = rig();
  r.contents.url = 'https://mail.example/inbox';
  const result = await r.caster.cast({ tab: TAB, on: true });
  assert.equal(result.page?.url, 'https://mail.example/inbox');
  assert.equal(r.caster.watched(TAB), true);
  assert.deepEqual(r.dbg.named('Page.startScreencast').map((c) => c.params), [{ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }]);
  assert.deepEqual(r.dbg.named('Emulation.setFocusEmulationEnabled').map((c) => c.params), [{ enabled: true }]);
  await r.caster.cast({ tab: TAB, on: true }); // a renewal starts nothing new
  assert.equal(r.dbg.named('Page.startScreencast').length, 1);
});

test('every frame is acknowledged at once; at most one per 500 ms goes on – the newest – with the page and its viewport', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true });
  r.frame(1, 'AAA');
  await tick();
  assert.equal(r.updates.length, 1);
  assert.deepEqual(r.updates[0]!.frame, { data: 'AAA', meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, zoom: 1 } });
  assert.equal(r.updates[0]!.page.url, r.contents.url);
  r.timers.advance(100);
  r.frame(2, 'BBB');
  r.frame(3, 'CCC');
  await tick();
  assert.deepEqual(r.dbg.named('Page.screencastFrameAck').map((c) => c.params.sessionId), [1, 2, 3]);
  assert.equal(r.updates.length, 1, 'the slot is not free yet');
  r.timers.advance(CAST_FRAME_GAP_MS - 100);
  assert.deepEqual(r.updates.map((u) => u.frame?.data), ['AAA', 'CCC'], 'the newest waited for the slot');
  r.dbg.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://mail.example/' } });
  assert.equal(r.updates.length, 3, 'a navigation tells the page at once');
  assert.equal(r.updates[2]!.frame, undefined);
});

test('the cast ends CAST_IDLE_MS after its last renewal, or at once with on: false', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true });
  r.timers.advance(CAST_IDLE_MS / 2);
  await r.caster.cast({ tab: TAB, on: true });
  r.timers.advance(CAST_IDLE_MS - 1);
  assert.equal(r.caster.watched(TAB), true, 'renewed half-way');
  r.timers.advance(1);
  await tick();
  assert.equal(r.caster.watched(TAB), false);
  assert.equal(r.dbg.named('Page.stopScreencast').length, 1);
  assert.deepEqual(r.dbg.named('Emulation.setFocusEmulationEnabled').map((c) => c.params.enabled), [true, false]);
  r.frame(9, 'LATE');
  await tick();
  assert.equal(r.updates.length, 0, 'nothing after the end');

  await r.caster.cast({ tab: TAB, on: true });
  await r.caster.cast({ tab: TAB, on: false });
  await tick();
  assert.equal(r.caster.watched(TAB), false);
  assert.equal(r.dbg.named('Page.stopScreencast').length, 2);
});

test('a tab that is not open is not_found; DevTools holding the page end the cast with their sentence', async () => {
  const r = rig();
  r.setTab(undefined);
  await assert.rejects(r.caster.cast({ tab: TAB, on: true }), (error: unknown) => code(error) === 'not_found');
  await assert.rejects(r.caster.input({ tab: TAB, commands: [mouse('mouseMoved')] }), (error: unknown) => code(error) === 'not_found');
  const busy = rig();
  busy.dbg.attached = false;
  busy.dbg.attach = () => { throw new Error('already attached'); };
  await assert.rejects(busy.caster.cast({ tab: TAB, on: true }), (error: unknown) => code(error) === 'unavailable' && (error as Error).message === DEVTOOLS_BUSY);
  assert.equal(busy.caster.watched(TAB), false);
});

test('a page made anew is cast again on its new connection', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true });
  const fresh = new FakeContents(r.timers.clock);
  r.setTab(new SideTab(TAB, fresh, { now: () => r.timers.clock.now, person: () => {} }));
  await r.caster.cast({ tab: TAB, on: true });
  await tick();
  assert.equal(r.dbg.named('Page.stopScreencast').length, 1, 'the old page stops');
  assert.equal(fresh.debugger.named('Page.startScreencast').length, 1, 'the new page casts');
});

test('input is the person\'s: agents yield, a press keeps the tab, moves do not; failures never echo the input', async () => {
  const r = rig();
  r.timers.clock.now = 77_000;
  await r.caster.input({ tab: TAB, commands: [mouse('mouseMoved')] });
  assert.equal(r.tab()!.personAt, 77_000);
  assert.equal(r.tab()!.personActive(2000), true, 'an agent step within 2 s waits');
  assert.deepEqual(r.kept, []);
  await r.caster.input({ tab: TAB, commands: [mouse('mousePressed'), mouse('mouseReleased')] });
  assert.deepEqual(r.kept, [TAB]);
  assert.deepEqual(r.dbg.named('Input.dispatchMouseEvent').map((c) => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  await assert.rejects(r.caster.input({ tab: TAB, commands: [{ method: 'Runtime.evaluate', params: { expression: '1' } }] }), (error: unknown) => code(error) === 'bad_request');
  assert.equal(r.dbg.named('Runtime.evaluate').length, 0);
  r.dbg.handlers['Input.insertText'] = () => { throw new Error('could not insert "hunter2"'); };
  await assert.rejects(r.caster.input({ tab: TAB, commands: [{ method: 'Input.insertText', params: { text: 'hunter2' } }] }),
    (error: unknown) => code(error) === 'unavailable' && !(error as Error).message.includes('hunter2'));
});

test('navigation: an address, back through the history, reload; the tab becomes the person\'s', async () => {
  const r = rig();
  await r.caster.nav({ tab: TAB, url: 'news.example' });
  assert.deepEqual(r.dbg.named('Page.navigate').map((c) => c.params), [{ url: 'https://news.example/' }]);
  r.dbg.handlers['Page.getNavigationHistory'] = () => ({ currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] });
  await r.caster.nav({ tab: TAB, action: 'back' });
  await r.caster.nav({ tab: TAB, action: 'forward' }); // nothing ahead
  assert.deepEqual(r.dbg.named('Page.navigateToHistoryEntry').map((c) => c.params), [{ entryId: 7 }]);
  await r.caster.nav({ tab: TAB, action: 'reload' });
  assert.equal(r.dbg.named('Page.reload').length, 1);
  assert.deepEqual(r.kept, [TAB, TAB, TAB, TAB]);
  r.dbg.handlers['Page.navigate'] = () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  await assert.rejects(r.caster.nav({ tab: TAB, url: 'https://nowhere.example' }), /ERR_NAME_NOT_RESOLVED/);
});

test('a dialog the page opens travels with the page; input and navigation wait for its answer, which the watcher gives', async () => {
  const r = rig();
  const unavailable = (error: unknown) => code(error) === 'unavailable' && /dialog/.test((error as Error).message);
  await r.caster.cast({ tab: TAB, on: true });
  r.dbg.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete this draft?', url: r.contents.url });
  assert.deepEqual(r.updates.at(-1)?.page.dialog, { type: 'confirm', message: 'Delete this draft?' }, 'told at once');
  assert.deepEqual((await r.caster.cast({ tab: TAB, on: true })).page?.dialog, { type: 'confirm', message: 'Delete this draft?' }, 'a renewal names it too');
  await assert.rejects(r.caster.input({ tab: TAB, commands: [mouse('mousePressed')] }), unavailable);
  await assert.rejects(r.caster.nav({ tab: TAB, action: 'reload' }), unavailable);
  assert.equal(r.dbg.named('Input.dispatchMouseEvent').length + r.dbg.named('Page.reload').length, 0, 'nothing waits on the blocked page');
  await r.caster.nav({ tab: TAB, dialog: 'dismiss' });
  assert.deepEqual(r.dbg.named('Page.handleJavaScriptDialog').map((c) => c.params), [{ accept: false }]);
  assert.equal(r.updates.at(-1)?.page.dialog, undefined, 'the answer clears it at once');
  r.dbg.emit('Page.javascriptDialogClosed', { result: false });
  await r.caster.nav({ tab: TAB, dialog: 'accept' }); // answered already: nothing to answer
  assert.equal(r.dbg.named('Page.handleJavaScriptDialog').length, 1);
  await r.caster.input({ tab: TAB, commands: [mouse('mousePressed')] });
  assert.equal(r.dbg.named('Input.dispatchMouseEvent').length, 1, 'input flows again');
  r.dbg.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved.' });
  await r.caster.nav({ tab: TAB, dialog: 'accept' });
  assert.deepEqual(r.dbg.named('Page.handleJavaScriptDialog').at(-1)?.params, { accept: true });
  assert.deepEqual(castNav({ tab: TAB, dialog: 'accept' }), { tab: TAB, dialog: 'accept' });
  for (const bad of [{ tab: TAB, dialog: 'maybe' }, { tab: TAB, dialog: 'accept', action: 'reload' }, { tab: TAB, dialog: 'dismiss', url: 'a.example' }]) {
    assert.throws(() => castNav(bad), (error: unknown) => code(error) === 'bad_request', JSON.stringify(bad));
  }
});

test('a watch that ends lets the page leave the off-screen host (off, idle, a failed start); a page made anew stays; watching is no agent\'s use', async () => {
  const r = rig();
  await r.caster.cast({ tab: TAB, on: true });
  await r.caster.cast({ tab: TAB, on: false });
  assert.deepEqual(r.released, [TAB], 'off');
  await r.caster.cast({ tab: TAB, on: true });
  r.timers.advance(CAST_IDLE_MS);
  assert.deepEqual(r.released, [TAB, TAB], 'nobody renewed it');
  await r.caster.cast({ tab: TAB, on: true });
  r.setTab(new SideTab(TAB, new FakeContents(r.timers.clock), { now: () => r.timers.clock.now, person: () => {} }));
  await r.caster.cast({ tab: TAB, on: true });
  assert.deepEqual(r.released, [TAB, TAB], 'cast again at once: the new page stays where it paints');
  const busy = rig();
  busy.dbg.handlers['Page.startScreencast'] = () => { throw new Error('Target closed'); };
  await assert.rejects(busy.caster.cast({ tab: TAB, on: true }), (error: unknown) => code(error) === 'unavailable');
  // Review fix: a cast that could not start holds nothing (not watched any more), but the page is not sent away at once –
  // the viewer's next pull tries again; the off-screen host's own idle sweep takes it out when nobody does.
  assert.equal(busy.caster.watched(TAB), false, 'a cast that could not start holds nothing');
  assert.deepEqual(busy.released, [], 'no host window made and destroyed on each try');
  await busy.caster.cast({ tab: TAB, on: false });
  assert.deepEqual(busy.released, [TAB], 'the watch ended after a failed start: the page leaves');

  const asked: Array<[string, boolean | undefined]> = [];
  const browser = fakeBrowser({ [TAB]: new FakeContents(r.timers.clock) });
  const driver = new SideDriver({ browser: () => ({ ...browser, sideContents: (id: string, watcher?: boolean) => { asked.push([id, watcher]); return browser.sideContents(id); } }) });
  assert.ok(driver.side(TAB));
  assert.deepEqual(asked, [[TAB, true]], 'the watcher wakes the page without counting as an agent that used it');
});

test('the host bridge carries sideCast / sideInput / sideNav to the caster and its updates back as side-view messages', async () => {
  for (const op of ['sideCast', 'sideInput', 'sideNav'] as const) assert.ok(HOST_OPS.includes(op), op);
  const seen: Array<[string, unknown]> = [];
  const sideView = {
    cast: async (args: unknown) => { seen.push(['cast', args]); return { ok: true as const }; },
    input: async (args: unknown) => { seen.push(['input', args]); return { ok: true as const }; },
    nav: async (args: unknown) => { seen.push(['nav', args]); return { ok: true as const }; },
  };
  const host = new HostServices({ sideView } as unknown as HostServicesDeps);
  const ask = (target: HostServices, op: string, args: unknown) => target.handle({ id: 1, type: 'host', op, args } as HostRequest);
  await ask(host, 'sideCast', { tab: TAB, on: true });
  await ask(host, 'sideInput', { tab: TAB, commands: [mouse('mouseMoved')] });
  await ask(host, 'sideNav', { tab: TAB, action: 'reload' });
  assert.deepEqual(seen.map(([name]) => name), ['cast', 'input', 'nav']);
  await assert.rejects(ask(new HostServices({} as unknown as HostServicesDeps), 'sideNav', { tab: TAB, action: 'reload' }), (error: unknown) => code(error) === 'unavailable');
  assert.notEqual(parseRuntimeMessage({ id: 2, type: 'host', op: 'sideInput', args: { tab: TAB, commands: [] } }), null);
  const update = { tab: TAB, page: { url: 'https://a.example/', title: 'A', back: false, forward: false, loading: false }, live: true };
  assert.deepEqual(parseMainMessage({ type: 'side-view', update }), { type: 'side-view', update });
  for (const bad of [{ tab: 1, page: update.page, live: true }, { tab: TAB, live: true }, { tab: TAB, page: update.page }, null]) {
    assert.equal(parseMainMessage({ type: 'side-view', update: bad }), null, JSON.stringify(bad));
  }
});
