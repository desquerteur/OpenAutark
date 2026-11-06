// The side driver against a fake DevTools debugger – a click by ref travels the glide path as
// real mouseMoved events at their times before press/release, draws the agent's named cursor and reports
// its pointer; a batch stops at the first failing step (a stale ref asks for a new snapshot); fill and
// press; the person's own input refuses steps for 2 s (the agent's echoed input does not); human-check
// pages are never touched; the change list after an act; waits on page events; console and network
// with redaction; page dialogs; tabs, open with the agent and chat as opener, close; a debugger the DevTools hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SideDriver, PERSON_PRIORITY_MS } from '../../../src/main/side-driver/driver.ts';
import { DEVTOOLS_BUSY } from '../../../src/main/side-driver/cdp.ts';
import type { AXNode } from '../../../src/main/side-driver/snapshot.ts';
import { FakeContents, checkoutTree, fakeBrowser, pageHandlers } from './side-driver-fakes.ts';

const agent = { id: 'ag_ada', name: 'Ada' };

function setup(state: Parameters<typeof pageHandlers>[1] = { tree: checkoutTree() }) {
  const clock = { now: 1_000_000 };
  const contents = new FakeContents(clock);
  pageHandlers(contents.debugger, state);
  const browser = fakeBrowser({ 'web-1': contents });
  const points: any[] = [];
  const driver = new SideDriver({
    browser: () => browser, pointer: (point) => points.push(point), person: () => ({ kind: 'person', id: 'owner', name: 'Lukas' }),
    now: () => clock.now, sleep: async (ms) => { clock.now += ms; },
  });
  driver.tab('web-1', contents as never); // the workspace browser's hook: the tab's page was made
  return { clock, contents, dbg: contents.debugger, browser, points, driver, state };
}

test('click by ref: the mouse glides there in real mouseMoved steps, then presses and releases; cursor drawn, pointer reported', async () => {
  const { driver, dbg, points } = setup();
  const first = await driver.call({ action: 'snapshot', agent });
  assert.equal(first.ok, true);
  assert.equal(first.tab, 'web-1');
  assert.match(first.text!, /- button "Pay" \[ref=s24\]/);
  assert.ok(dbg.named('Page.addScriptToEvaluateOnNewDocument')[0]!.params.worldName, 'the driver’s script runs in its own world');
  assert.equal(dbg.named('Runtime.addBinding')[0]!.params.executionContextName, 'workforce-side', 'the binding exists only in that world');

  const out = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.deepEqual([out.ok, out.done, out.changes], [true, 1, 'No visible changes.']);
  const mouse = dbg.named('Input.dispatchMouseEvent');
  const moves = mouse.filter((call) => call.params.type === 'mouseMoved');
  assert.ok(moves.length >= 10, `a glide is many small moves (${moves.length})`);
  assert.deepEqual([moves.at(-1)!.params.x, moves.at(-1)!.params.y], [140, 116], 'it ends at the button’s center');
  for (let n = 1; n < moves.length; n += 1) assert.ok(moves[n]!.at >= moves[n - 1]!.at, 'moves run at their times');
  const span = moves.at(-1)!.at - moves[0]!.at;
  assert.ok(span > 150 && span <= 420, `a glide takes ≤ 420 ms (${span})`);
  const [press, release] = mouse.filter((call) => call.params.type !== 'mouseMoved');
  assert.deepEqual([press!.params.type, press!.params.button, press!.params.clickCount, press!.params.x], ['mousePressed', 'left', 1, 140]);
  assert.equal(release!.params.type, 'mouseReleased');
  assert.equal(release!.at - press!.at, 25, 'glide holds the button 25 ms');
  const cursor = dbg.evals('__wfSide.cursor(');
  assert.equal(cursor.length, 1);
  assert.match(cursor[0]!, /^__wfSide\.cursor\("ag_ada", "Ada", "#[0-9a-f]{6}", \[.*\], true\)$/);
  const point = points.at(-1);
  assert.deepEqual({ surface: point.surface, actor: point.actor, x: point.x, y: point.y, action: point.action, target: point.target },
    { surface: 'side:web-1', actor: { kind: 'agent', id: 'ag_ada', name: 'Ada' }, x: 140, y: 116, action: 'click', target: { role: 'button', name: 'Pay', ref: 's24' } });
  assert.ok(point.path.length <= 40 && point.path.length > 1);

  // instant: one jump, no hold
  dbg.calls = [];
  await driver.call({ action: 'act', agent, motion: 'instant', steps: [{ action: 'click', ref: 's22' }] });
  assert.deepEqual(dbg.named('Input.dispatchMouseEvent').map((call) => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('a batch stops at the first failing step; a stale ref asks for a new snapshot', async () => {
  const { driver, dbg } = setup({ tree: checkoutTree(), stale: new Set([999]) });
  await driver.call({ action: 'snapshot', agent });
  const out = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }, { action: 'click', ref: 's999' }, { action: 'click', ref: 's10' }] });
  assert.equal(out.ok, false);
  assert.equal(out.done, 1);
  assert.equal(out.error, 'Step 2 (click): The element s999 is not on the page any more – take a new snapshot.');
  assert.ok(!dbg.named('DOM.resolveNode').some((call) => call.params.backendNodeId === 10), 'the step after the failure never ran');
  assert.ok(out.changes !== undefined, 'what the steps that ran changed');
});

test('fill focuses, selects all and inserts; type inserts; press sends key events', async () => {
  const { driver, dbg } = setup();
  const out = await driver.call({ action: 'act', agent, steps: [{ action: 'fill', ref: 's20', value: 'bob@example.com' }, { action: 'press', key: 'Enter' }, { action: 'type', value: '!' }] });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.done, 3);
  assert.deepEqual(dbg.named('DOM.focus').map((call) => call.params.backendNodeId), [20]);
  assert.ok(dbg.named('Runtime.callFunctionOn').some((call) => String(call.params.functionDeclaration).includes('setSelectionRange')), 'select all first');
  assert.deepEqual(dbg.named('Input.insertText').map((call) => call.params.text), ['bob@example.com', '!']);
  assert.deepEqual(dbg.named('Input.dispatchKeyEvent').map((call) => [call.params.type, call.params.key]), [['keyDown', 'Enter'], ['keyUp', 'Enter']]);
  assert.ok(out.text, 'a first look hands over the whole snapshot');
});

test('the person goes first: their input refuses steps for 2 s and is reported as their pointer; the agent’s echo is not theirs', async () => {
  const { driver, dbg, points, clock } = setup();
  await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  points.length = 0;
  // The click's own events come back through the page listener: they are the agent's, not the person's.
  dbg.report({ k: 'in', e: 'click', x: 140, y: 116 });
  dbg.report({ k: 'in', e: 'move', x: 140, y: 116 });
  assert.equal(points.length, 0);
  const allowed = await driver.call({ action: 'act', agent, steps: [{ action: 'hover', ref: 's23' }] });
  assert.equal(allowed.ok, true);

  dbg.report({ k: 'in', e: 'move', x: 500, y: 400, target: { role: 'link', name: 'Terms' } });
  assert.deepEqual(points.at(-1), { surface: 'side:web-1', actor: { kind: 'person', id: 'owner', name: 'Lukas' }, x: 500, y: 400, action: 'move', target: { role: 'link', name: 'Terms' } });
  dbg.calls = [];
  const refused = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.deepEqual([refused.ok, refused.personActive, refused.done], [false, true, 0]);
  assert.match(refused.error!, /The person is using this tab right now/);
  assert.equal(dbg.named('Input.dispatchMouseEvent').length, 0, 'no input while the person works');
  const read = await driver.call({ action: 'snapshot', agent });
  assert.equal(read.ok, true, 'reading is never refused');
  clock.now += PERSON_PRIORITY_MS + 1;
  assert.equal((await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] })).ok, true);
  // Input inside a frame counts as the person's too (no coordinates, no pointer report).
  dbg.report({ k: 'in', e: 'type', key: 'char', frame: 1 }, 9);
  clock.now += 1200;
  dbg.report({ k: 'in', e: 'move', frame: 1 }, 9);
  assert.equal((await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] })).personActive, true);
});

test('a human-check page is only reported: reads and acts say so, the act still runs', async () => {
  const { driver, dbg } = setup({ tree: checkoutTree(), human: true });
  const snap = await driver.call({ action: 'snapshot', agent });
  assert.deepEqual([snap.ok, snap.humanCheck], [true, true]);
  const act = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.deepEqual([act.ok, act.humanCheck], [true, true]);
  assert.ok(dbg.named('Input.dispatchMouseEvent').length > 0);
});

test('after an act: what changed since the agent’s last look; later looks are change lists too', async () => {
  const state = { tree: checkoutTree() };
  const { driver, dbg } = setup(state);
  await driver.call({ action: 'snapshot', agent });
  const paid: AXNode = { nodeId: '90', role: { value: 'dialog' }, name: { value: 'Paid' }, backendDOMNodeId: 90 };
  dbg.handlers['Input.dispatchMouseEvent'] = (p) => { if (p.type === 'mouseReleased') state.tree = checkoutTree([paid]); return {}; };
  const out = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.equal(out.changes, 'Added:\n- dialog "Paid" [ref=s90]');
  assert.equal(out.text, undefined, 'no whole snapshot when little changed');
  const again = await driver.call({ action: 'snapshot', agent });
  assert.equal(again.changes, 'No visible changes.');
  const full = await driver.call({ action: 'snapshot', agent, full: true });
  assert.match(full.text!, /- dialog "Paid" \[ref=s90\]/);
  const other = await driver.call({ action: 'snapshot', agent: { id: 'ag_bob', name: 'Bob' } });
  assert.match(other.text!, /- button "Pay"/, 'another agent’s first look is whole');
  const found = await driver.call({ action: 'find', agent, query: 'pay' });
  assert.equal(found.text, '- button "Pay" [ref=s24]');
});

test('wait: event-driven on text, address and change; times out with a sentence', async () => {
  const state = { tree: checkoutTree(), text: 'Loading' };
  const { driver, dbg, contents } = setup(state);
  const pending = driver.call({ action: 'wait', agent, wait: { text: 'Done', timeoutMs: 5000 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(dbg.evals('__wfSide.watch(true)').length >= 1, 'the document is watched while waiting');
  state.text = 'All done';
  dbg.report({ k: 'mut' });
  const text = await pending;
  assert.equal(text.ok, true, text.error);
  assert.equal(text.text, 'Now the text "Done" is on the page.');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(dbg.evals('__wfSide.watch(false)').length >= 1, 'and no longer after');

  const url = driver.call({ action: 'wait', agent, wait: { url: '*/checkout*', timeoutMs: 5000 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  contents.url = 'https://shop.example/checkout?step=2';
  dbg.emit('Page.navigatedWithinDocument', { frameId: 'main', url: contents.url });
  assert.equal((await url).ok, true);

  const already = await driver.call({ action: 'wait', agent, wait: { url: 'checkout' } });
  assert.equal(already.text, 'Already true: the address matches "checkout".');
  const late = await driver.call({ action: 'wait', agent, wait: { change: true, timeoutMs: 60 } });
  assert.deepEqual([late.ok, late.error], [false, 'Waited 0.1 s – the page did not change.']);
});

test('console and network through the driver: buffers from attach, secrets hidden', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'tabs', agent });
  await driver.call({ action: 'snapshot', agent }); // attached and listening
  dbg.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Payment failed' }], timestamp: Date.now() });
  dbg.emit('Network.requestWillBeSent', { requestId: '7', request: { url: 'https://api.shop.example/pay', method: 'POST', headers: { Cookie: 'sid=1' } }, type: 'Fetch', timestamp: 5 });
  dbg.emit('Network.responseReceived', { requestId: '7', response: { status: 402, statusText: 'Payment Required', mimeType: 'application/json', headers: { 'set-cookie': 'sid=2' } } });
  dbg.emit('Network.loadingFinished', { requestId: '7', timestamp: 5.1, encodedDataLength: 80 });
  dbg.handlers['Network.getResponseBody'] = () => ({ body: '{"error":"card declined","token":"t-123"}' });
  const consoleOut = await driver.call({ action: 'console', agent, errorsOnly: true });
  assert.match(consoleOut.text!, /\[error\] \S+ Payment failed/);
  const list = await driver.call({ action: 'network', agent, errorsOnly: true });
  assert.match(list.text!, /^POST 402 fetch 80 B 100 ms https:\/\/api\.shop\.example\/pay \[id=7\]$/);
  const detail = await driver.call({ action: 'network', agent, requestId: '7' });
  assert.match(detail.text!, /Cookie: \[hidden\]/);
  assert.match(detail.text!, /set-cookie: \[hidden\]/);
  assert.match(detail.text!, /"error":"card declined","token":"\[hidden\]"/);
  assert.ok(!detail.text!.includes('t-123'));
  assert.match((await driver.call({ action: 'network', agent, requestId: '99' })).error!, /no request 99/);
});

test('page dialogs: steps wait for an answer; Enter accepts it', async () => {
  const { driver, dbg } = setup();
  await driver.call({ action: 'snapshot', agent });
  dbg.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete the cart?' });
  const blocked = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.match(blocked.error!, /A confirm dialog is open .*press Enter to accept or Escape to dismiss it/);
  assert.match((await driver.call({ action: 'snapshot', agent })).error!, /confirm dialog is open/);
  const answered = await driver.call({ action: 'act', agent, steps: [{ action: 'press', key: 'Enter' }] });
  assert.equal(answered.ok, true, answered.error);
  assert.deepEqual(dbg.named('Page.handleJavaScriptDialog').map((call) => call.params.accept), [true]);
});

test('tabs, open and close: the list, the opener of an opened tab, refusals as sentences, the call check first', async () => {
  const { driver, browser } = setup();
  const tabs = await driver.call({ action: 'tabs', agent });
  assert.deepEqual(tabs.tabs, [{ id: 'web-1', url: 'https://shop.example/cart', title: 'Cart', active: true }]);
  assert.match((await driver.call({ action: 'open', agent, url: 'ftp://x.example' })).error!, /HTTP or HTTPS/);
  assert.match((await driver.call({ action: 'open', agent, url: 'shop.example/new', chat: 'ch_1', show: true })).error!, /Close a browser tab before opening another/);
  assert.deepEqual(browser.opened, ['https://shop.example/new']);
  assert.deepEqual(browser.openers, [{ opener: { agentId: agent.id, agentName: agent.name, chatId: 'ch_1' }, show: true }]);
  assert.deepEqual((await driver.call({ action: 'close', agent, tab: 'web-1' })).tabs, [], 'any tab may be closed');
  assert.match((await driver.call({ action: 'snapshot', agent, tab: 'web-2' })).error!, /There is no side-browser tab web-2/);
  assert.deepEqual(await driver.call({ action: 'act', agent: { id: 'ag_ada' } }), { ok: false, error: 'agent.name must be text.' });
  browser.pages = []; browser.active = {};
  assert.match((await driver.call({ action: 'snapshot', agent })).error!, /no open tab/);
});

test('spaces: a call without a tab means its space and the tab it shows, a tab list is per space and names who opened a tab, a tab id works from anywhere', async () => {
  const { driver, browser, contents } = setup();
  browser.pages.push({ id: 'web-c', url: 'https://chat.example/', title: 'Chat tab', space: 'chat:ch_1', opener: { agentId: 'ag_ada', agentName: 'Ada', chatId: 'ch_1' } } as never);
  browser.contents.set('web-c', contents);
  assert.deepEqual((await driver.call({ action: 'tabs', agent })).tabs!.map((tab) => tab.id), ['web-1'], 'global');
  assert.deepEqual((await driver.call({ action: 'tabs', agent, space: 'chat:ch_1' })).tabs, [{ id: 'web-c', url: 'https://chat.example/', title: 'Chat tab', active: false, by: 'Ada' }]);
  assert.match((await driver.call({ action: 'snapshot', agent, space: 'chat:other' })).error!, /no open tab/);
  assert.equal((await driver.call({ action: 'text', agent, space: 'chat:ch_1' })).tab, 'web-c');
  assert.equal((await driver.call({ action: 'text', agent, tab: 'web-c' })).tab, 'web-c', 'works from anywhere');
  browser.pages.push({ id: 'web-d', url: 'https://chat.example/d', title: 'Another', space: 'chat:ch_1' } as never);
  browser.contents.set('web-d', contents);
  assert.equal((await driver.call({ action: 'text', agent, tab: 'web-d', space: 'chat:ch_1' })).tab, 'web-d');
  assert.equal((await driver.call({ action: 'text', agent, space: 'chat:ch_1' })).tab, 'web-d', 'an agent goes on in the tab it named last');
  browser.active.global = 'web-1';
  assert.equal((await driver.call({ action: 'text', agent: { id: 'ag_cy', name: 'Cy' } })).tab, 'web-1', 'without one it reads what the person looks at');
  browser.pages.push({ id: 'web-2', url: 'https://other.example/', title: 'Other' } as never);
  browser.contents.set('web-2', contents);
  browser.active.global = 'web-2';
  assert.equal((await driver.call({ action: 'text', agent: { id: 'ag_cy', name: 'Cy' } })).tab, 'web-2', 'and follows when the person moves on');
  browser.active['chat:ch_1'] = 'web-d'; // the chat's area shows a page while the pane shows web-2
  assert.equal((await driver.call({ action: 'text', agent: { id: 'ag_dee', name: 'Dee' }, space: 'chat:ch_1' })).tab, 'web-d', "in the chat's area the tab shown there");
  assert.equal((await driver.call({ action: 'text', agent: { id: 'ag_dee', name: 'Dee' } })).tab, 'web-2', 'in the pane the one shown there');
  const marked = async (space?: string) => (await driver.call({ action: 'tabs', agent, ...(space ? { space } : {}) })).tabs!.map((tab) => [tab.id, tab.active]);
  assert.deepEqual(await marked('chat:ch_1'), [['web-c', false], ['web-d', true]]);
  assert.deepEqual(await marked(), [['web-1', false], ['web-2', true]], 'each space marks the tab it shows');
  browser.active = {};
  browser.pages.pop();
  assert.equal((await driver.call({ action: 'text', agent: { id: 'ag_bo', name: 'Bo' }, space: 'chat:ch_1' })).tab, 'web-c', 'another agent starts on the first');
  assert.equal((await driver.call({ action: 'text', agent })).tab, 'web-1', 'each space its own');
  assert.match((await driver.call({ action: 'tabs', agent, space: 'chat:../x' })).error!, /no browser space/);
});

test('open in the current tab, and a click that navigates: both wait for the new document, then hand over its snapshot', async () => {
  const { driver, dbg, contents } = setup();
  dbg.handlers['Page.navigate'] = (p) => { contents.url = p.url; return { frameId: 'main', loaderId: 'l1' }; };
  const opened = await driver.call({ action: 'open', agent, url: 'https://shop.example/terms', newTab: false });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.url, 'https://shop.example/terms');
  assert.match(opened.text!, /- button "Pay" \[ref=s24\]/);
  dbg.handlers['Input.dispatchMouseEvent'] = (p) => {
    if (p.type !== 'mouseReleased') return {};
    contents.loading = true;
    dbg.emit('Page.frameStartedLoading', { frameId: 'main' });
    setTimeout(() => {
      contents.url = 'https://shop.example/paid'; contents.title = 'Paid';
      dbg.emit('Page.frameNavigated', { frame: { id: 'main', url: contents.url } });
      dbg.emit('Page.domContentEventFired', {});
    }, 30);
    return {};
  };
  const started = Date.now();
  const out = await driver.call({ action: 'act', agent, steps: [{ action: 'click', ref: 's24' }] });
  assert.equal(out.ok, true, out.error);
  assert.ok(Date.now() - started >= 25, 'it waited for the document');
  assert.equal(out.url, 'https://shop.example/paid');
  assert.match(out.changes!, /^Address: https:\/\/shop\.example\/paid \(was https:\/\/shop\.example\/terms\)$/);
  assert.match(out.text!, /- button "Pay"/, 'another document: the whole snapshot');
});

test('screenshot: the visible page as JPEG, scaled to maxEdge with the factor named', async () => {
  const { driver } = setup();
  const shot = await driver.call({ action: 'screenshot', agent, maxEdge: 500 });
  assert.equal(shot.ok, true, shot.error);
  assert.deepEqual([shot.image!.mime, shot.image!.width, shot.image!.height], ['image/jpeg', 500, 400]);
  assert.match(shot.text!, /Scaled to 50 %/);
});

test('a debugger the DevTools hold gives a clear sentence; a closed tab lets go of the debugger', async () => {
  const { driver, contents } = setup();
  assert.equal((await driver.call({ action: 'snapshot', agent })).ok, true);
  contents.debugger.detach();
  contents.debugger.attach = () => { throw new Error('Another debugger is already attached'); };
  const out = await driver.call({ action: 'snapshot', agent });
  assert.deepEqual(out, { ok: false, error: DEVTOOLS_BUSY });
  driver.tab('web-1', null);
  contents.debugger.report({ k: 'in', e: 'move', x: 1, y: 1 }); // nobody listens any more
});
