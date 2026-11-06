// MP9 takeover on the UI side (src/ui/workspace/browser-input.ts, src/ui/tasks/browser-todo.ts):
// clicks map to frame units through the letterboxed picture (outside it nothing is sent), keys
// carry CDP modifiers while Esc and Ctrl+V stay with the app, pastes lose control characters, the
// sender keeps the order with one call in flight, merges moves and wheel turns per tab and drops
// what waits after a failure; "Open browser" is offered on browser/social agents' confirm to-dos.
// Owns: these assertions only. Never: a DOM, runtime or socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputSender, drawnArea, framePoint, keyInput, pasteText, wheelPixels } from '../../../src/ui/workspace/browser-input.ts';
import { browserTodoTarget } from '../../../src/ui/tasks/browser-todo.ts';
import type { BrowserInput } from '../../../src/shared/model/browser.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';

const NO_MODS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

test('a click maps to frame units through the letterboxed picture; outside the picture nothing is sent', () => {
  const box = { left: 10, top: 20, width: 400, height: 400 }; // a 1280 × 720 frame drawn 400 × 225, centred
  assert.deepEqual(drawnArea(box, { width: 1280, height: 720 }), { left: 10, top: 107.5, width: 400, height: 225 });
  assert.deepEqual(framePoint(210, 220, box, { width: 1280, height: 720 }), { x: 640, y: 360, width: 1280, height: 720 });
  assert.equal(framePoint(210, 30, box, { width: 1280, height: 720 }), undefined, 'the bar above the picture');
  assert.deepEqual(framePoint(110, 70, box, { width: 0, height: 0 }), { x: 100, y: 50, width: 400, height: 400 }, 'unknown frame size: the box itself');
});

test('keys carry CDP modifiers; Esc, Ctrl+V and composition stay with the app', () => {
  assert.deepEqual(keyInput({ ...NO_MODS, key: 'a', code: 'KeyA', keyCode: 65 }, 'down'), { kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65 });
  assert.deepEqual(keyInput({ ...NO_MODS, ctrlKey: true, shiftKey: true, key: 'Tab', code: 'Tab', keyCode: 9, repeat: true }, 'up'),
    { kind: 'key', type: 'up', key: 'Tab', code: 'Tab', modifiers: 10, keyCode: 9, repeat: true });
  assert.equal(keyInput({ ...NO_MODS, key: 'Escape', code: 'Escape' }, 'down'), undefined);
  assert.equal(keyInput({ ...NO_MODS, ctrlKey: true, key: 'v', code: 'KeyV' }, 'down'), undefined, 'the paste event sends the text');
  assert.equal(keyInput({ ...NO_MODS, key: 'a', code: 'KeyA', isComposing: true }, 'down'), undefined);
  assert.equal(keyInput({ ...NO_MODS, ctrlKey: true, altKey: true, key: 'v', code: 'KeyV' }, 'down')?.kind, 'key', 'AltGr+V is a character, not a paste');
  assert.equal(pasteText('one\ttwo\nthree\u0007'), 'one\ttwo\nthree');
  assert.equal(pasteText('x'.repeat(3000)).length, 2000);
  assert.deepEqual([wheelPixels(3, 1), wheelPixels(-120, 0), wheelPixels(99, 2)], [120, -120, 10_000]);
});

test('the sender keeps the order with one call in flight, merges moves and wheel turns per tab and drops what waits after a failure', async () => {
  const sent: Array<[string, BrowserInput]> = [];
  const errors: unknown[] = [];
  let release: () => void = () => {};
  let fail = false;
  const sender = createInputSender((tab, input) => {
    sent.push([tab, input]);
    if (fail) return Promise.reject(new Error('The browser shows another tab now.'));
    return new Promise<void>((resolve) => { release = resolve; });
  }, (error) => errors.push(error));
  const at = { x: 1, y: 1, width: 10, height: 10 };
  const move = (x: number): BrowserInput => ({ kind: 'mouse', type: 'move', ...at, x });
  sender.push('t1', { kind: 'mouse', type: 'down', ...at });
  sender.push('t1', move(2));
  sender.push('t1', move(3));
  sender.push('t1', { kind: 'wheel', ...at, deltaX: 0, deltaY: 40 });
  sender.push('t1', { kind: 'wheel', ...at, deltaX: 0, deltaY: 80 });
  sender.push('t2', move(4));
  assert.equal(sent.length, 1, 'one call in flight');
  assert.equal(sender.pending(), 3, 'moves and wheel turns merged, another tab kept apart');
  for (let i = 0; i < 4; i++) { release(); await new Promise((resolve) => setImmediate(resolve)); }
  assert.deepEqual(sent.map(([tab, input]) => [tab, input.kind, input.kind === 'mouse' ? input.x : input.kind === 'wheel' ? input.deltaY : 0]),
    [['t1', 'mouse', 1], ['t1', 'mouse', 3], ['t1', 'wheel', 120], ['t2', 'mouse', 4]]);

  fail = true;
  sender.push('t1', { kind: 'text', text: 'a' });
  sender.push('t1', { kind: 'text', text: 'b' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1, 'reported once');
  assert.equal(sender.pending(), 0, 'keys for a page that is gone are dropped');
  assert.deepEqual(sent.slice(4).map(([, input]) => input.kind === 'text' && input.text), ['a']);
});

test('"Open browser" goes with confirm to-dos of browser and social agents, at their open browser', () => {
  const agents = new Map([
    ['ag_web', { id: 'ag_web', mode: 'browser' }], ['ag_social', { id: 'ag_social', mode: 'social' }],
    ['ag_writer', { id: 'ag_writer', mode: 'writing' }], ['ag_gone', { id: 'ag_gone', mode: 'browser', archivedAt: 1 }],
  ]);
  const todo = (createdBy: string, widget: Record<string, unknown> = { type: 'confirm', instructions: 'Sign in', url: 'https://accounts.example.com/login' }) =>
    ({ createdBy, widget, mode: undefined } as unknown as TaskView);
  assert.deepEqual(browserTodoTarget(todo('ag_web'), agents, []), { agentId: 'ag_web', url: 'https://accounts.example.com/login' });
  assert.deepEqual(browserTodoTarget(todo('ag_social', { type: 'confirm', url: 'javascript:alert(1)' }), agents, []), { agentId: 'ag_social' }, 'only http(s) addresses');
  assert.equal(browserTodoTarget(todo('ag_writer'), agents, []), undefined);
  assert.deepEqual(browserTodoTarget(todo('ag_writer'), agents, [{ agentId: 'ag_writer', tabs: 1, url: '', title: '' }]),
    { agentId: 'ag_writer', url: 'https://accounts.example.com/login' }, 'an open browser counts too');
  assert.equal(browserTodoTarget(todo('ag_web', { type: 'choice' }), agents, []), undefined, 'confirm to-dos only');
  assert.equal(browserTodoTarget(todo('ag_gone'), agents, []), undefined);
  assert.equal(browserTodoTarget(todo('human'), agents, []), undefined);
});
