// The live view of agents' own browsers (browser/view.ts, view-steer.ts) against a fake CDP: the screencast runs
// only while watched and follows the active tab, frames are acked and passed on at most every 500 ms (the newest),
// the person's steering (URL, back, tab switch, Show window), input and takeover; Show window counts as use and
// holds off the idle close until Hide; tab addresses and titles pass the vault redaction. Agent browsers launch
// off-screen, never headless.
// Owns: these assertions only. Never: a real browser or display.


import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserView, FRAME_GAP_MS, MAX_SIDE } from '../../../src/runtime/browser/view.ts';
import { OFF_SCREEN, ON_SCREEN } from '../../../src/runtime/browser/launch.ts';
import type { BrowserFrame, BrowserViewState } from '../../../src/shared/model/browser.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { cleanup, fakeBrowser, fakeSecrets, JPEG, manualTimers, recordingBus, tick, type FakeCdp } from './view-fakes.ts';

after(cleanup);

const VAULT_VALUE = 'sk-test-value-123'; // a stored secret the vault knows (fakeSecrets: secret://s1)

function rig(options: { idleMs?: number } = {}) {
  const { browser, contexts, launches } = fakeBrowser(options);
  const recorded = recordingBus();
  const timers = manualTimers();
  const services = { bus: recorded.bus, log: new MemoryLogger(), secrets: fakeSecrets(VAULT_VALUE) } as unknown as RuntimeServices;
  const view = new BrowserView({ browser, services: () => services, now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const frames = () => recorded.of<BrowserFrame>('browser.frame');
  const states = () => recorded.of<BrowserViewState>('browser.view');
  const lastState = () => states().at(-1)!;
  return { browser, contexts, launches, view, timers, recorded, frames, states, lastState };
}

test('agent browsers launch with a real window off-screen, never headless', async () => {
  const { browser, launches } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  assert.equal(launches[0].headless, false);
  assert.ok(launches[0].args.includes(`--window-position=${OFF_SCREEN.left},${OFF_SCREEN.top}`), launches[0].args.join(' '));
  assert.ok(launches[0].args.some((arg) => arg.startsWith('--window-size=')));
  assert.ok(!launches[0].args.some((arg) => /headless/.test(arg)));
});

test('no screencast without a watcher; a watch starts it on the active tab, every frame is acked, the release stops it', async () => {
  const { browser, contexts, view, frames, lastState } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  assert.equal(contexts[0].cdps.length, 0, 'nothing runs while nobody watches');
  const release = view.watch('ag_1');
  const { state } = await view.current('ag_1');
  const cdp = contexts[0].cdps[0];
  assert.deepEqual(cdp.methods(), ['Page.enable', 'Page.startScreencast']);
  assert.deepEqual(cdp.sent[1].params, { format: 'jpeg', quality: 60, maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, everyNthFrame: 1 });
  assert.equal(MAX_SIDE, 1280);
  assert.deepEqual({ open: state.open, live: state.live, tab: state.tab, tabs: state.tabs }, {
    open: true, live: true, tab: 't1', tabs: [{ tab: 't1', url: 'https://example.com/', title: 'example.com', active: true }],
  });
  assert.equal(lastState().live, true, 'the state is published on the bus');

  cdp.frame(1);
  assert.deepEqual(cdp.acks(), [1]);
  assert.equal(frames().length, 1);
  assert.deepEqual({ ...frames()[0], data: frames()[0].data.slice(0, 4) }, { agentId: 'ag_1', tab: 't1', data: '/9j/', width: 1280, height: 720, at: 1000 });
  assert.equal((await view.current('ag_1')).frame?.data, frames()[0].data, 'a new watcher gets the last frame');

  release();
  await view.current('ag_1');
  assert.deepEqual(cdp.methods().slice(-1), ['Page.stopScreencast']);
  assert.equal(cdp.detached, true);
  assert.equal(cdp.listening('Page.screencastFrame'), false);
  cdp.frame(2);
  assert.equal(frames().length, 1, 'no frame after the last watcher left');
});

test('at most one frame per 500 ms reaches the watchers – the newest – while Chrome gets every ack', async () => {
  const { browser, contexts, view, timers, frames } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  view.watch('ag_1');
  await view.current('ag_1');
  const cdp = contexts[0].cdps[0];
  cdp.frame(1);
  timers.advance(100); cdp.frame(2);
  timers.advance(100); cdp.frame(3);
  assert.deepEqual(cdp.acks(), [1, 2, 3]);
  assert.equal(frames().length, 1);
  assert.deepEqual(timers.pending(), [FRAME_GAP_MS - 100], 'one trailing slot for the newest frame');
  timers.advance(300);
  timers.fire();
  assert.equal(frames().length, 2);
  assert.equal(frames()[1].data, JPEG(3), 'frame 3 (the newest) went out, frame 2 was skipped');
  timers.advance(FRAME_GAP_MS); cdp.frame(4);
  assert.equal(frames().length, 3, 'after a quiet slot a frame goes out at once');
});

test('the view follows the agent to a new tab, and waits for a browser that is not open yet', async () => {
  const { browser, contexts, view, lastState } = rig();
  view.watch('ag_1');
  assert.deepEqual((await view.current('ag_1')).state, { agentId: 'ag_1', open: false, tabs: [], live: false, at: 1000 });
  await browser.open('ag_1', { url: 'https://one.test' });
  await view.current('ag_1');
  assert.equal(contexts[0].cdps.length, 1, 'the screencast starts when the agent opens its browser');
  await browser.open('ag_1', { url: 'https://two.test', newTab: true });
  await view.current('ag_1');
  const [first, second] = contexts[0].cdps;
  assert.equal(first.detached, true);
  assert.equal(second.page, contexts[0].list[1]);
  assert.equal(lastState().tab, 't2');
  assert.deepEqual(lastState().tabs.map((tab) => [tab.tab, tab.active]), [['t1', false], ['t2', true]]);
  await browser.close('ag_1');
  await view.current('ag_1');
  assert.deepEqual({ open: lastState().open, live: lastState().live }, { open: false, live: false });
});


const click = { action: 'click' as const, target: { ref: 'e2' } };

test('the person steers: address, back, tab switch – the picked tab is the agent\'s active one', async () => {
  const { browser, contexts, view } = rig();
  await assert.rejects(view.steer('ag_1', { url: 'example.org' }), /No browser is open/);
  await browser.open('ag_1', { url: 'https://example.com' });
  const page = contexts[0].list[0];
  const state = await view.steer('ag_1', { url: 'example.org' });
  assert.equal(page.navigations.at(-1), 'https://example.org/');
  assert.equal(state.tabs[0].url, 'https://example.org/');
  await view.steer('ag_1', { action: 'back' });
  assert.equal(page.navigations.at(-1), 'back');
  await assert.rejects(view.steer('ag_1', { url: 'file:///C:/secret.txt' }), /Only http and https/);
  await browser.open('ag_1', { url: 'https://two.test', newTab: true });
  await view.steer('ag_1', { tab: 't1' });
  assert.equal((await browser.snapshot('ag_1')).tab, 't1', 'the tab the person picked is the agent\'s active tab');
  assert.equal(page.fronted, 1, 'and comes to the front (Chrome paints only that tab)');
  await assert.rejects(view.steer('ag_1', { tab: 't9' }), /That tab is closed/);
});

test('Show window brings the off-screen window onto the screen and takes the browser over; Hide puts it back', async () => {
  const { browser, contexts, view } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  const shown = await view.steer('ag_1', { window: 'show' });
  const cdp: FakeCdp = contexts[0].cdps[0];
  assert.deepEqual(cdp.sent.map((entry) => [entry.method, entry.params]), [
    ['Browser.getWindowForTarget', undefined],
    ['Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } }],
    ['Browser.setWindowBounds', { windowId: 7, bounds: { ...ON_SCREEN } }],
  ]);
  assert.equal(shown.shown, true);
  assert.ok(shown.takeover, 'the real window is the person\'s now');
  await assert.rejects(browser.batch('ag_1', { steps: [click] }), /The person has taken over my browser/);
  const hidden = await view.steer('ag_1', { window: 'hide' });
  assert.deepEqual(contexts[0].cdps[1].sent.at(-1)?.params, { windowId: 7, bounds: { ...OFF_SCREEN } });
  assert.equal(hidden.shown, undefined);
  contexts[0].list[0].failCdp = true;
  await assert.rejects(view.steer('ag_1', { window: 'show' }), /could not be moved/);
});

test('a tab the screencast cannot start on reports it, and is tried again only after the agent\'s next step or on another tab', async () => {
  const { browser, contexts, view, lastState } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  contexts[0].list[0].failCdp = true;
  view.watch('ag_1');
  await view.current('ag_1');
  assert.equal(lastState().error, 'The live view could not start for this tab.');
  assert.equal(lastState().live, false);
  await browser.snapshot('ag_1');
  await tick();
  await view.current('ag_1');
  assert.equal(contexts[0].cdps.length, 1, 'no retry while nothing happens (a snapshot is no step)');
  await browser.batch('ag_1', { steps: [{ action: 'hover', target: { role: 'button', name: 'Send' } }] });
  await view.current('ag_1');
  assert.equal(contexts[0].cdps.length, 2, 'one more try after the agent\'s step');
  await browser.open('ag_1', { url: 'https://two.test', newTab: true });
  await view.current('ag_1');
  assert.equal(contexts[0].cdps.at(-1)?.page, contexts[0].list[1], 'the new tab is shown');
  assert.equal(lastState().error, undefined);
  assert.equal(lastState().live, true);
});

test('browser.sessions tells which agents have a browser open here; list names them with redacted addresses', async () => {
  const { browser, view, recorded } = rig();
  await browser.open('ag_1', { url: `https://example.com/?key=${VAULT_VALUE}` });
  await browser.open('ag_2', { url: 'https://example.org' });
  assert.deepEqual((await view.list()).map((entry) => [entry.agentId, entry.url]), [['ag_1', 'https://example.com/?key=secret://s1'], ['ag_2', 'https://example.org/']]);
  await browser.close('ag_1');
  assert.deepEqual(recorded.of<{ open: string[] }>('browser.sessions').map((entry) => entry.open), [['ag_1'], ['ag_1', 'ag_2'], ['ag_2']]);
});

test('tab addresses and titles pass the vault redaction', async () => {
  const { browser, contexts, view, recorded } = rig();
  await browser.open('ag_1', { url: 'https://login.example.com/' });
  view.watch('ag_1');
  await view.current('ag_1');
  const page = contexts[0].list[0];
  page.urlValue = `https://login.example.com/saved?key=${VAULT_VALUE}`;
  page.titleValue = `Key ${VAULT_VALUE} saved`;
  contexts[0].cdps[0].emit('Page.frameNavigated', { frame: { id: 'main' } });
  await view.current('ag_1');
  const state = (await view.current('ag_1')).state;
  assert.deepEqual(state.tabs.map(({ url, title }) => ({ url, title })), [{ url: 'https://login.example.com/saved?key=secret://s1', title: 'Key secret://s1 saved' }]);
  assert.ok(!JSON.stringify(recorded.events).includes(VAULT_VALUE), 'the value is in no state or event');
});

test('the person\'s input turns the takeover on and goes to the shown tab; hand back ends it', async () => {
  const { browser, contexts, view, lastState } = rig();
  await browser.open('ag_1', { url: 'https://example.com' });
  view.watch('ag_1');
  await view.current('ag_1');
  const cdp = contexts[0].cdps[0];
  cdp.frame(1);
  await assert.rejects(view.input('ag_1', 't9', { kind: 'text', text: 'hi' }), /another tab/);
  await view.input('ag_1', 't1', { kind: 'mouse', type: 'down', x: 64, y: 36, width: 128, height: 72 });
  assert.deepEqual(cdp.sent.at(-1), { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 640, y: 360, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } });
  await view.current('ag_1');
  assert.equal(lastState().takeover?.waiting, false);
  await assert.rejects(browser.snapshot('ag_1'), /The person has taken over my browser/);
  assert.equal(browser.takeovers.state('ag_1')?.waiting, true, 'the agent waits now');
  const back = await view.takeover('ag_1', { on: false });
  assert.equal(back.takeover, undefined);
  await browser.snapshot('ag_1');
});

test('Take over opens a closed browser at its address; Show window holds off the idle close until Hide', async () => {
  const { browser, view, lastState } = rig({ idleMs: 30 });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await assert.rejects(view.takeover('ag_1', { on: true }), /No browser is open/);
  const state = await view.takeover('ag_1', { on: true, url: 'https://example.com/login' });
  assert.deepEqual([state.open, state.tabs[0]?.url, Boolean(state.takeover)], [true, 'https://example.com/login', true]);
  await view.takeover('ag_1', { on: false });
  let closed = false;
  browser.onChange((_agentId, why) => { if (why === 'close') closed = true; });
  await view.steer('ag_1', { window: 'show' });
  await wait(90);
  assert.equal(browser.isOpen('ag_1'), true, 'not closed while the window is on the screen');
  view.watch('ag_1');
  await view.steer('ag_1', { window: 'hide' });
  assert.equal(lastState().shown, undefined);
  assert.equal(closed, false);
  await wait(100);
  assert.equal(closed, true, 'after Hide the idle close applies again');
});
