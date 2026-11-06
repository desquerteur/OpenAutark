// B-055 F1: the side driver's pure parts – key presses as DevTools key events, the call check (every
// field), the console and network ring buffers with header/body/address redaction, the human-check
// address rule, the in-page script (compiles, reports only trusted person input, throttled), and the
// host bridge's 'pointer' message (main → runtime pointer hub).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dialogAnswer, keyEvents, parseKey } from '../../../src/main/side-driver/keys.ts';
import { checkCall } from '../../../src/main/side-driver/validate.ts';
import { ConsoleLog, NetworkLog, redactBody, redactHeaders } from '../../../src/main/side-driver/logs.ts';
import { isChallengeUrl, pageScript } from '../../../src/main/side-driver/page-script.ts';
import { parseMainMessage } from '../../../src/shared/api/host-bridge.ts';

test('keys: names, aliases and modifiers become rawKeyDown/keyDown/keyUp with the right codes', () => {
  const enter = keyEvents(parseKey('Enter')!);
  assert.deepEqual(enter.map((e) => [e.type, e.key, e.text]), [['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined]]);
  const selectAll = keyEvents(parseKey('Ctrl+a')!);
  assert.deepEqual(selectAll.map((e) => [e.type, e.key, e.modifiers]), [['rawKeyDown', 'Control', 2], ['rawKeyDown', 'a', 2], ['keyUp', 'a', 2], ['keyUp', 'Control', 0]]);
  assert.equal(selectAll[1]!.code, 'KeyA');
  assert.equal(selectAll[1]!.text, undefined, 'a shortcut types nothing');
  const shiftTab = keyEvents(parseKey('Shift+Tab')!);
  assert.deepEqual(shiftTab.map((e) => e.windowsVirtualKeyCode), [16, 9, 9, 16]);
  assert.equal(keyEvents(parseKey('Shift+a')!)[1]!.text, 'A');
  assert.equal(parseKey('esc')!.main.key, 'Escape');
  assert.equal(parseKey('Control++')!.main.key, '+');
  assert.equal(parseKey('Hyper+x'), null);
  assert.equal(parseKey('NoSuchKey'), null);
  assert.equal(dialogAnswer(parseKey('Enter')!), true);
  assert.equal(dialogAnswer(parseKey('Escape')!), false);
  assert.equal(dialogAnswer(parseKey('a')!), undefined);
});

test('call check: every field, with one sentence for the agent', () => {
  const agent = { id: 'ag_1', name: 'Ada' };
  const error = (value: unknown) => { const out = checkCall(value); return 'error' in out ? out.error : ''; };
  assert.match(error(null), /must be an object/);
  assert.match(error({ action: 'fly', agent }), /Unknown side-browser action/);
  assert.match(error({ action: 'tabs' }), /names no agent/);
  assert.match(error({ action: 'tabs', agent: { id: 'a b', name: 'Ada' } }), /agent\.id/);
  assert.match(error({ action: 'tabs', agent: { id: 'a', name: '   ' } }), /agent\.name is empty/);
  assert.match(error({ action: 'snapshot', agent, tab: 'tab-1' }), /There is no side-browser tab "tab-1"/);
  assert.match(error({ action: 'act', agent, steps: [] }), /at least one step/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'click' }] }), /Step 1: click needs a ref or x and y/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'click', ref: 'e12' }] }), /not a side-browser ref/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'click', x: 3 }] }), /give both x and y/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'fill', ref: 's1' }] }), /fill needs a value/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'press' }] }), /press needs a key/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'select', ref: 's1' }] }), /select needs a value/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'warp', ref: 's1' }] }), /unknown action/);
  assert.match(error({ action: 'act', agent, steps: Array.from({ length: 21 }, () => ({ action: 'back' })) }), /At most 20 steps/);
  assert.match(error({ action: 'act', agent, steps: [{ action: 'back' }], motion: 'teleport' }), /motion must be/);
  assert.match(error({ action: 'wait', agent, wait: {} }), /wait needs text, url, change or idle/);
  assert.match(error({ action: 'wait', agent, wait: { idle: true, timeoutMs: 60_000 } }), /between 0 and 30000/);
  assert.match(error({ action: 'find', agent }), /find needs a query/);
  assert.match(error({ action: 'close', agent }), /close needs the tab/);
  assert.match(error({ action: 'network', agent, requestId: 'a b' }), /not a request id/);
  assert.match(error({ action: 'screenshot', agent, region: { x: 0, y: 0, width: 0, height: 5 } }), /region\.width must be between 1/);
  assert.match(error({ action: 'snapshot', agent, full: 'yes' }), /full must be true or false/);
  const ok = checkCall({ action: 'act', agent: { id: 'ag_1', name: ' Ada  Lovelace ' }, tab: 'web-1', motion: 'human', extra: 1, steps: [{ action: 'fill', ref: 's20', value: '' }, { action: 'press', key: 'Enter' }] });
  assert.ok('call' in ok);
  assert.deepEqual(ok.call, { action: 'act', agent: { id: 'ag_1', name: 'Ada Lovelace' }, tab: 'web-1', motion: 'human', steps: [{ action: 'fill', ref: 's20', value: '' }, { action: 'press', key: 'Enter' }] });
});

test('console: calls, exceptions and log entries in a ring; filters by pattern, errors and limit', () => {
  const log = new ConsoleLog();
  assert.match(log.text(), /No console messages since/);
  log.api({ type: 'log', args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 3 }, { type: 'object', description: 'Object' }], timestamp: 1, stackTrace: { callFrames: [{ url: 'https://a.example/app.js?token=x', lineNumber: 9 }] } });
  log.exception({ timestamp: 2, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined\n    at f (app.js:1)\n    at g\n    at h\n    at i' } } });
  log.entry({ entry: { level: 'error', source: 'network', text: 'Failed to load resource: 404', url: 'https://a.example/x.png', timestamp: 3 } });
  log.entry({ entry: { level: 'verbose', text: 'noise' } });
  log.navigated('https://a.example/next');
  const all = log.text();
  assert.match(all, /\[log\] \S+ hello 3 Object \(https:\/\/a\.example\/app\.js\?token=hidden:10\)/);
  assert.match(all, /\[error\] \S+ TypeError: x is undefined\n {4}at f/);
  assert.ok(!all.includes('at i'), 'a stack keeps its first lines');
  assert.match(all, /\[error\] \S+ network: Failed to load resource: 404/);
  assert.match(all, /\[page\] \S+ navigated to https:\/\/a\.example\/next/);
  assert.ok(!all.includes('noise'));
  assert.ok(!log.text({ errorsOnly: true }).includes('hello'));
  assert.match(log.text({ pattern: 'typeerror' }), /TypeError/);
  assert.match(log.text({ pattern: 'nothing-like-it' }), /No console messages match/);
  for (let n = 0; n < 400; n += 1) log.api({ type: 'info', args: [{ type: 'string', value: `m${n}` }], timestamp: 10 + n });
  const tail = log.text({ limit: 3 });
  assert.equal(tail.split('\n').length, 4);
  assert.match(tail, /^… \d+ earlier entries\n.*m397\n.*m398\n.*m399$/);
});

test('network: requests with status, size and time; redirects kept; failures; secrets never handed out', () => {
  const net = new NetworkLog();
  net.sent({ requestId: '1', request: { url: 'https://api.example/login?session=s1', method: 'POST', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' } }, type: 'XHR', timestamp: 10, wallTime: 1 });
  net.response({ requestId: '1', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Set-Cookie': 'sid=secret', 'X-Api-Key': 'k', 'Cache-Control': 'no-store' } } });
  net.finished({ requestId: '1', timestamp: 10.25, encodedDataLength: 2048 });
  net.sent({ requestId: '2', request: { url: 'https://a.example/old', method: 'GET' }, type: 'Document', timestamp: 11 });
  net.sent({ requestId: '2', request: { url: 'https://a.example/new', method: 'GET' }, type: 'Document', timestamp: 11.1, redirectResponse: { status: 301 } });
  net.sent({ requestId: '3', request: { url: 'https://cdn.example/x.js', method: 'GET' }, type: 'Script', timestamp: 12 });
  net.failed({ requestId: '3', timestamp: 12.5, errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(net.inflight(net.latest()), 1, 'the redirected document is still open');
  const list = net.text();
  assert.match(list, /POST 200 xhr 2\.0 kB 250 ms https:\/\/api\.example\/login\?session=hidden \[id=1\]/);
  assert.match(list, /GET 301 document 100 ms https:\/\/a\.example\/old \[id=2~11\]/);
  assert.match(list, /GET pending document https:\/\/a\.example\/new \[id=2\]/);
  assert.match(list, /GET failed \(net::ERR_NAME_NOT_RESOLVED\) script 500 ms/);
  assert.deepEqual(net.text({ errorsOnly: true }).split('\n').length, 1);
  const detail = net.detail('1', { body: JSON.stringify({ access_token: 'tok', user: 'ann', refresh_token: 'r' }) })!;
  assert.match(detail, /Authorization: \[hidden\]/);
  assert.match(detail, /Set-Cookie: \[hidden\]/);
  assert.match(detail, /X-Api-Key: \[hidden\]/);
  assert.match(detail, /Cache-Control: no-store/);
  assert.match(detail, /"access_token":"\[hidden\]"/);
  assert.match(detail, /"user":"ann"/);
  assert.ok(!/tok"|Bearer abc|sid=secret/.test(detail));
  assert.match(net.detail('1', { body: Buffer.from([0, 1, 2]).toString('base64'), base64Encoded: true })!, /Body:/);
  assert.equal(net.detail('nope'), undefined);
  assert.deepEqual(redactHeaders({ cookie: 'a=1', 'x-csrf-token': 't', accept: '*/*' }), ['cookie: [hidden]', 'x-csrf-token: [hidden]', 'accept: */*']);
  assert.equal(redactBody('{"password": "p", "name": "x"}'), '{"password": "[hidden]", "name": "x"}');
});

test('human checks: challenge frames and pages, not invisible badges', () => {
  assert.equal(isChallengeUrl('https://www.google.com/recaptcha/api2/anchor?k=1&size=normal'), true);
  assert.equal(isChallengeUrl('https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible'), false);
  assert.equal(isChallengeUrl('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge'), true);
  assert.equal(isChallengeUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2'), true);
  assert.equal(isChallengeUrl('https://shop.example/cdn-cgi/challenge-platform/h/g/orchestrate'), true);
  assert.equal(isChallengeUrl('https://shop.example/recaptcha-settings'), false);
  assert.equal(isChallengeUrl('https://notahcaptcha.com.example/'), false);
});

function pageWorld() {
  const listeners = new Map<string, (event: any) => void>();
  const sent: any[] = [];
  let clock = 1000;
  const timers: Array<() => void> = [];
  const win: any = {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    __report: (payload: string) => sent.push(JSON.parse(payload)),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    Date: { now: () => clock },
    document: { activeElement: null, querySelectorAll: () => [], querySelector: () => null, documentElement: {}, body: null, title: '' },
  };
  win.window = win; win.globalThis = win;
  Object.defineProperty(win, 'top', { get: () => win });
  const context = vm.createContext(win);
  new vm.Script(pageScript('__report')).runInContext(context);
  return { win, listeners, sent, timers, tick: (ms: number) => { clock += ms; }, run: () => timers.splice(0).forEach((fn) => fn()) };
}

test('page script: compiles, exposes its API, reports only trusted person input, moves at most every 100 ms', () => {
  const page = pageWorld();
  assert.deepEqual(Object.keys(page.win.__wfSide).sort(), ['cursor', 'facts', 'passwords', 'state', 'text', 'watch']);
  const move = page.listeners.get('mousemove')!;
  move({ isTrusted: false, movementX: 3, movementY: 0, clientX: 1, clientY: 1, target: null });
  move({ isTrusted: true, movementX: 0, movementY: 0, clientX: 2, clientY: 2, target: null }); // a synthetic move after a scroll
  assert.equal(page.sent.length, 0);
  move({ isTrusted: true, movementX: 2, movementY: 1, clientX: 10, clientY: 20, target: null });
  assert.deepEqual(page.sent, [{ k: 'in', e: 'move', x: 10, y: 20 }]);
  page.tick(30);
  move({ isTrusted: true, movementX: 2, movementY: 1, clientX: 12, clientY: 22, target: null });
  move({ isTrusted: true, movementX: 2, movementY: 1, clientX: 14, clientY: 24, target: null });
  assert.equal(page.sent.length, 1, 'within 100 ms: held back');
  page.tick(80); page.run();
  assert.deepEqual(page.sent[1], { k: 'in', e: 'move', x: 14, y: 24 }, 'the latest point follows');
  page.listeners.get('mousedown')!({ isTrusted: true, clientX: 14.4, clientY: 24.6, target: null });
  assert.deepEqual(page.sent[2], { k: 'in', e: 'click', x: 14, y: 25 }, 'a click goes at once');
  page.tick(200);
  page.listeners.get('keydown')!({ isTrusted: true, key: 'q' });
  assert.deepEqual(page.sent[3], { k: 'in', e: 'type', key: 'char' }, 'never the typed character');
  assert.deepEqual(JSON.parse(JSON.stringify(page.win.__wfSide.facts())), { human: false, passwords: 0 }); // (another realm's object)
});

test('host bridge: the pointer message (main → runtime) is checked like every other', () => {
  const point = { surface: 'side:web-1', actor: { kind: 'person', id: 'owner', name: 'Lukas' }, x: 10, y: 20, action: 'click', target: { role: 'button', name: 'Pay' } };
  assert.deepEqual(parseMainMessage({ type: 'pointer', point }), { type: 'pointer', point });
  assert.equal(parseMainMessage({ type: 'pointer', point: { ...point, x: Number.NaN } }), null);
  assert.equal(parseMainMessage({ type: 'pointer', point: { ...point, actor: { kind: 'robot', id: 'x', name: 'y' } } }), null);
  assert.equal(parseMainMessage({ type: 'pointer' }), null);
});
