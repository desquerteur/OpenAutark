// F08 – the mini-app "Activity" list (ui/blocks/app-calls.ts activityRows, shown by AppActivity.tsx):
// only the given block's calls, newest first, in words plus the bridge name, size, result and time
// – never a payload (message text, state, event data, link URLs, unknown names an app made up);
// equal calls in a row merge with a count; the row limit holds; the ring tells its listeners about
// every add, finish and clear (the open list follows it without polling), and a listener that
// throws does not break the bridge. AppFrame.tsx takes its host tools from app-tools.ts and shows
// the Activity line under the frame (never over the app); the list is read before its popover first
// renders, and the popover places itself again when its content grows (lib/popover.tsx); the line
// sits quietly at the frame's right edge, its list opens along it and the rows do not light up.
// Owns: these assertions only. Never: renders Preact or loads a frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_METHODS, APP_TOOLS } from '../../../src/shared/blocks/app-bridge.ts';
import { activityLabel, activityRows, CallRing, logCall } from '../../../src/ui/blocks/app-calls.ts';

const SECRETS = ['TOP-SECRET-TEXT', 'state-secret-42', 'event-secret', 'https://evil.test/?leak=1', 'leak:made-up-tool', 'data:hidden'];

function filled(): CallRing {
  const ring = new CallRing(50);
  const tool = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: APP_METHODS.toolsCall, params: { name, arguments: args } });
  logCall(ring, 'b_msg_1_0', { jsonrpc: '2.0', id: 0, method: APP_METHODS.initialize, params: {} }, 90, 'ok', 1_000);
  logCall(ring, 'b_msg_2_0', tool(APP_TOOLS.event, { name: 'other-frame', data: 'event-secret' }), 70, 'ok', 1_500);
  logCall(ring, 'b_msg_1_0', tool(APP_TOOLS.event, { name: 'picked', data: 'event-secret' }), 120, 'ok', 2_000);
  logCall(ring, 'b_msg_1_0', tool(APP_TOOLS.stateSet, { state: 'state-secret-42' }), 200, 'ok', 3_000);
  logCall(ring, 'b_msg_1_0', tool(APP_TOOLS.stateSet, { state: 'state-secret-42' }), 210, 'ok', 3_100);
  logCall(ring, 'b_msg_1_0', { jsonrpc: '2.0', id: 4, method: APP_METHODS.message, params: { content: { type: 'text', text: 'TOP-SECRET-TEXT' } } }, 80, 'error', 4_000);
  logCall(ring, 'b_msg_1_0', { jsonrpc: '2.0', id: 5, method: 'ui/open-link', params: { url: 'https://evil.test/?leak=1' } }, 60, 'pending', 5_000);
  logCall(ring, 'b_msg_1_0', tool('leak:made-up-tool', {}), 40, 'limited', 6_000);
  logCall(ring, 'b_msg_1_0', { jsonrpc: '2.0', method: 'data:hidden' }, 30, 'invalid', 7_000);
  return ring;
}

test('activity rows: only this block, newest first, merged repeats, no payloads', () => {
  const rows = activityRows(filled(), 'b_msg_1_0');
  assert.deepEqual(rows.map((row) => [row.label, row.name, row.result, row.count, row.bytes, row.at]), [
    ['Sent an unknown message', 'other', 'invalid', 1, 30, 7_000],
    ['Called an unknown tool', 'other', 'limited', 1, 40, 6_000],
    ['Asked to open a link', 'ui/open-link', 'pending', 1, 60, 5_000],
    ['Posted a message to the chat', 'ui/message', 'error', 1, 80, 4_000],
    ['Saved its state', 'wf_state_set', 'ok', 2, 410, 3_100],
    ['Sent an event to the agent', 'wf_event', 'ok', 1, 120, 2_000],
    ['Connected', 'ui/initialize', 'ok', 1, 90, 1_000],
  ]);
  const text = JSON.stringify(rows);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `leaks ${secret}`);
  assert.equal(text.includes('other-frame'), false);
  assert.deepEqual(activityRows(filled(), 'b_msg_2_0').map((row) => row.name), ['wf_event']);
  assert.deepEqual(activityRows(filled(), 'b_unknown_0'), []);
});

test('activity rows: limit, unknown sizes and the time of a finished call', () => {
  const ring = new CallRing(100);
  for (let i = 0; i < 40; i++) logCall(ring, 'b_m_0', { method: i % 2 ? APP_METHODS.ping : APP_METHODS.displayMode }, i, 'ok', i);
  assert.equal(activityRows(ring, 'b_m_0').length, 30);
  assert.equal(activityRows(ring, 'b_m_0', 5).length, 5);
  const big = logCall(ring, 'b_big_0', {}, Infinity, 'too-large', 10);
  logCall(ring, 'b_big_0', {}, 12, 'too-large', 11);
  assert.equal(big.bytes, -1);
  assert.deepEqual(activityRows(ring, 'b_big_0').map((row) => [row.count, row.bytes]), [[2, -1]]);
  const call = logCall(ring, 'b_state_0', { method: APP_METHODS.toolsCall, params: { name: APP_TOOLS.stateGet } }, 20, 'pending', 1_000);
  ring.finish(call, 'ok', 1_042);
  assert.deepEqual(activityRows(ring, 'b_state_0')[0], { label: 'Read its saved state', name: 'wf_state_get', result: 'ok', at: 1_000, bytes: 20, ms: 42, count: 1 });
});

test('every known method and wf_* tool has its own words', () => {
  for (const method of [...Object.values(APP_METHODS).filter((name) => name !== APP_METHODS.toolsCall && name !== APP_METHODS.hostContextChanged), 'ui/open-link']) {
    assert.notEqual(activityLabel({ method }).label, 'Sent an unknown message', method);
  }
  for (const tool of Object.values(APP_TOOLS)) {
    const { label, name } = activityLabel({ method: APP_METHODS.toolsCall, tool });
    assert.equal(name, tool);
    assert.notEqual(label, 'Called an unknown tool', tool);
  }
});

test('the ring tells listeners about add, finish and clear; a throwing listener is isolated', () => {
  const ring = new CallRing(5);
  let calls = 0;
  ring.subscribe(() => { throw new Error('broken view'); });
  const off = ring.subscribe(() => { calls += 1; });
  const entry = logCall(ring, 'b_x_0', { method: APP_METHODS.initialize }, 10, 'pending', 1);
  ring.finish(entry, 'ok', 5);
  ring.clear();
  assert.equal(calls, 3);
  off();
  logCall(ring, 'b_x_0', { method: APP_METHODS.initialize }, 10, 'ok', 6);
  assert.equal(calls, 3, 'unsubscribed');
});

test('AppFrame uses app-tools.ts and shows the Activity disclosure', () => {
  const frame = readFileSync(new URL('../../../src/ui/blocks/AppFrame.tsx', import.meta.url), 'utf8');
  assert.match(frame, /import \{ callHostTool, hostContext, linkOpener \} from '\.\/app-tools\.ts';/);
  assert.match(frame, /<AppActivity frame=\{key\}/);
  for (const copy of ['function hostContext(', 'APP_TOOLS.', "confirm({ title: 'Open link"]) assert.equal(frame.includes(copy), false, `inline copy left: ${copy}`);
  assert.ok(frame.split('\n').length <= 300, 'AppFrame.tsx stays within 300 lines');
});

test('the Activity line sits under the frame and its list stays placed as it grows', () => {
  const frame = readFileSync(new URL('../../../src/ui/blocks/AppFrame.tsx', import.meta.url), 'utf8');
  const activity = readFileSync(new URL('../../../src/ui/blocks/AppActivity.tsx', import.meta.url), 'utf8');
  const popover = readFileSync(new URL('../../../src/ui/lib/popover.tsx', import.meta.url), 'utf8');
  // Not the absolutely placed corner button of "Open larger": that one covers the app's top-right corner.
  assert.match(frame, /<AppActivity frame=\{key\} \/>/);
  assert.doesNotMatch(activity, /app-frame-expand|IconButton/);
  assert.match(activity, /<div class="app-frame-foot">\s*<button type="button" class="text-button" aria-haspopup="dialog" aria-expanded=\{open\} onClick=\{toggle\}>Activity<\/button>/);
  // The rows exist before the popover first renders, so its first placement measures them.
  assert.match(activity, /setRows\(activityRows\(appCalls, props\.frame\)\);\r?\n\s*setAnchor\(event\.currentTarget\);/);
  // Rows that arrive while it is open: the popover is placed again on a size change (event-driven).
  assert.match(popover, /new ResizeObserver\(/);
  assert.match(popover, /\}, \[props\.open, props\.anchor, props\.align, props\.placement, size\]\);/);
  assert.doesNotMatch(activity + popover, /setInterval|setTimeout/);
});

test('the Activity line is quiet at the frame\'s right edge; its list opens along that edge and its rows do not light up', () => {
  const activity = readFileSync(new URL('../../../src/ui/blocks/AppActivity.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../../src/ui/styles/blocks.css', import.meta.url), 'utf8');
  assert.match(activity, /placement="bottom-end" width=\{340\} class="app-activity"/);
  assert.match(css, /\.app-frame-foot \{ display: flex; justify-content: flex-end; \}/);
  assert.match(css, /\.app-frame-foot \.text-button \{ padding: 4px 0 0; font-size: 12px; color: var\(--muted\); \}/);
  assert.match(css, /\.app-frame-foot \.text-button:hover, \.app-frame-foot \.text-button\[aria-expanded=true\] \{ color: var\(--secondary\); \}/);
  // One class more than base.css's '.menu-item:hover:not(:disabled)', so the informative rows stay calm.
  assert.match(css, /\.app-activity \.menu-item:hover:not\(:disabled\) \{ background: none; \}/);
});
