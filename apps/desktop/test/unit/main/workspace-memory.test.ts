// The person's browser – main's small rules: the memory saver's timer (a tab hidden 20 min gives its page up – one
// timer, kept tabs looked at again later), the shortcuts a page passes on, the IPC checks of the commands, a discarded
// tab as an entry again (its whole address in memory, the kept one on disk), up to 30 tabs, and the address field's
// address-or-search rule.
// Owns: these assertions. Never: Electron or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCARD_AFTER_MS, DiscardTimer } from '../../../src/main/workspace-discard.ts';
import { browserCommand } from '../../../src/main/workspace-commands.ts';
import { MAX_TABS, PersonalTabs, type TabFiles } from '../../../src/main/workspace-tabs.ts';
import { pageKey, type KeyInput } from '../../../src/shared/api/workspace-browser-keys.ts';
import { SEARCH_URL, omniboxUrl } from '../../../src/shared/api/workspace-browser.ts';

function memory(initial?: string): TabFiles & { text?: string; writes: number } {
  const files = { text: initial, writes: 0, read: () => files.text, write: (_file: string, text: string) => { files.text = text; files.writes++; } };
  return files;
}

function clock() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => now,
    set: (run: () => void, ms: number) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clear: (handle: unknown) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    advance(ms: number) { now += ms; for (;;) { const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0]; if (!due) return; timers.splice(timers.indexOf(due), 1); due.run(); } },
    get count() { return timers.length; },
  };
}

test('memory saver: a tab hidden for the whole time gives its page up; shown tabs and kept ones do not; one timer only', () => {
  const time = clock();
  const discarded: string[] = [];
  const keep = new Set<string>();
  const saver = new DiscardTimer({ after: DISCARD_AFTER_MS, now: time.now, set: time.set, clear: time.clear, keep: (id) => keep.has(id), discard: (id) => discarded.push(id) });
  assert.equal(time.count, 0, 'no timer while nothing is hidden');
  saver.hidden('web-a');
  time.advance(5 * 60_000);
  saver.hidden('web-b');
  saver.hidden('web-a'); // already timed: its time keeps running
  assert.equal(time.count, 1, 'one timer for the next tab due');
  time.advance(DISCARD_AFTER_MS - 5 * 60_000);
  assert.deepEqual(discarded, ['web-a'], 'a after 20 min');
  saver.shown('web-b');
  time.advance(DISCARD_AFTER_MS);
  assert.deepEqual(discarded, ['web-a'], 'b was shown in time');
  saver.hidden('web-c');
  keep.add('web-c');
  time.advance(DISCARD_AFTER_MS);
  assert.deepEqual(discarded, ['web-a'], 'c is kept (sound, DevTools, a question …)');
  assert.deepEqual(saver.timed(), ['web-c'], 'and looked at again later');
  keep.delete('web-c');
  time.advance(DISCARD_AFTER_MS);
  assert.deepEqual(discarded, ['web-a', 'web-c']);
  assert.equal(time.count, 0, 'nothing hidden: no timer');
  saver.hidden('web-d'); saver.stop();
  assert.equal(time.count, 0);
});

test('a discarded tab is an entry again: its whole address in memory, only the kept address on disk; up to 30 tabs', () => {
  assert.equal(MAX_TABS, 30);
  const files = memory();
  const tabs = new PersonalTabs({ file: 't.json', files });
  tabs.shown('web-a');
  tabs.save(new Map([['web-a', 'https://shop.test/cart?session=abc&item=2']]));
  tabs.discard('web-a', 'https://shop.test/cart?session=abc&item=2');
  assert.equal(tabs.restoredUrl('web-a'), 'https://shop.test/cart?session=abc&item=2', 'it loads again where it was');
  tabs.save(new Map());
  assert.ok(!files.text!.includes('session=abc'), 'the file keeps the kept address only');
  tabs.discard('web-unknown', 'https://x.test/');
  assert.equal(tabs.restoredUrl('web-unknown'), undefined, 'no tab, no entry');
});

const key = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...mods });

test("browser shortcuts in a page: Chrome's keys that the browser keeps", () => {
  const ctrl = { control: true };
  const cases: Array<[KeyInput, unknown]> = [
    [key('t', ctrl), { app: 'new-tab' }], [key('T', { control: true, shift: true }), { main: 'reopen' }], [key('w', ctrl), { app: 'close-tab' }],
    [key('Tab', ctrl), { app: 'next-tab' }], [key('Tab', { control: true, shift: true }), { app: 'previous-tab' }], [key('1', ctrl), { app: 'tab-1' }], [key('9', ctrl), { app: 'tab-9' }],
    [key('l', ctrl), { app: 'address' }], [key('d', { alt: true }), { app: 'address' }], [key('F6'), { app: 'address' }],
    [key('r', ctrl), { main: 'reload' }], [key('F5'), { main: 'reload' }], [key('R', { control: true, shift: true }), { main: 'hard-reload' }], [key('F5', { shift: true }), { main: 'hard-reload' }],
    [key('ArrowLeft', { alt: true }), { main: 'back' }], [key('ArrowRight', { alt: true }), { main: 'forward' }],
    [key('f', ctrl), { app: 'find' }], [key('h', ctrl), { app: 'history' }],
    [key('=', ctrl), { main: 'zoom-in' }], [key('+', { control: true, shift: true }), { main: 'zoom-in' }], [key('-', ctrl), { main: 'zoom-out' }], [key('0', ctrl), { main: 'zoom-reset' }],
    [key('F12'), { main: 'devtools' }], [key('I', { control: true, shift: true }), { main: 'devtools' }],
    [key('k', ctrl), { host: 'k' }], [key('b', ctrl), { host: 'b' }],
    [key('a', ctrl), undefined], [key('c', ctrl), undefined], [key('x'), undefined], [key('ArrowLeft'), undefined],
    [{ ...key('t', ctrl), type: 'keyUp' }, undefined],
  ];
  for (const [input, expected] of cases) assert.deepEqual(pageKey(input, false, false), expected, JSON.stringify(input));
  assert.equal(pageKey(key('Escape'), false, false), undefined, 'Escape is the page\'s while it is not loading');
  assert.deepEqual(pageKey(key('Escape'), false, true), { main: 'stop' });
  assert.deepEqual(pageKey(key('t', { meta: true }), true, false), { app: 'new-tab' }, 'Cmd on macOS');
  assert.deepEqual(pageKey(key('[', { meta: true }), true, false), { main: 'back' });
  assert.equal(pageKey(key('t', ctrl), true, false), undefined, 'Ctrl+T is no browser key on macOS');
});

test('commands are checked before anything runs', () => {
  assert.deepEqual(browserCommand({ action: 'find', id: 'web-a', text: 'x', next: true, forward: false }).action, 'find');
  for (const action of ['focus', 'find-stop', 'reveal', 'back', 'reload', 'stop', 'close', 'mute', 'devtools', 'hide']) assert.equal(browserCommand({ action, id: 'web-a' }).action, action);
  assert.equal(browserCommand({ action: 'show', id: 'web-a', bounds: { x: 0, y: 48, width: 400, height: 300 } }).action, 'show');
  assert.equal(browserCommand({ action: 'zoom', id: 'web-a', step: -1 }).action, 'zoom');
  assert.equal(browserCommand({ action: 'reopen', space: 'chat:c1' }).action, 'reopen');
  for (const bad of [
    { action: 'find', id: 'web-a' }, { action: 'find', id: 'web-a', text: 'x', next: 'yes' }, { action: 'open', id: 'web-a' },
    { action: 'focus' }, { action: 'reload', id: '../x' }, { action: 'reopen' }, { action: 'reopen', space: 'nowhere' }, { action: 'zoom', id: 'web-a', step: 2 }, { action: 'zoom', step: 1 }, { action: 'show', id: 'web-a' }, { action: 'show', id: 'web-a', bounds: { x: 0, y: 48, width: 0, height: 300 } },
    { action: 'show', id: null }, { action: 'hide' }, { action: 'hide', id: null }, null, 'list',
  ]) assert.throws(() => browserCommand(bad), JSON.stringify(bad));
});

test('the address field: an address by browserUrl\'s rules, words search Google', () => {
  assert.equal(omniboxUrl('example.com'), 'https://example.com');
  assert.equal(omniboxUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.equal(omniboxUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(omniboxUrl('intranet:8080'), 'https://intranet:8080');
  assert.equal(omniboxUrl('how to bake bread'), `${SEARCH_URL}how+to+bake+bread`);
  assert.equal(omniboxUrl('bread'), `${SEARCH_URL}bread`, 'one word without a dot searches');
  assert.equal(omniboxUrl('? example.com'), `${SEARCH_URL}example.com`, '"?" forces a search');
  assert.equal(omniboxUrl('ann@example.com'), `${SEARCH_URL}ann%40example.com`, 'a mail address searches');
  assert.equal(omniboxUrl('c++ & rust'), `${SEARCH_URL}c%2B%2B+%26+rust`);
  assert.throws(() => omniboxUrl('javascript:alert(1)'), /HTTP or HTTPS/, 'a scheme stays an address – refused, never searched');
  assert.throws(() => omniboxUrl('file:///C:/x'), /HTTP or HTTPS/);
  assert.throws(() => omniboxUrl('   '), /address or search/);
});
