// Host side of the ```app bridge: frame parsing, size cap, rate limits, result shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgeLimiter, clampHeight, frameBytes, isAction, isSizeChange, messageText, parseFrame, toolError, toolResult,
} from '../../../src/ui/blocks/app-host.ts';
import { APP_BRIDGE_LIMITS } from '../../../src/shared/blocks/app-bridge.ts';

test('parseFrame accepts JSON-RPC 2.0 requests and notifications only', () => {
  assert.deepEqual(parseFrame({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { a: 1 } }), { id: 1, method: 'ui/initialize', params: { a: 1 } });
  assert.deepEqual(parseFrame({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }), { method: 'ui/notifications/initialized', params: {} });
  assert.equal(parseFrame({ id: 1, method: 'x' }), null); // no jsonrpc marker
  assert.equal(parseFrame({ jsonrpc: '2.0', id: 1, result: {} }), null); // a response
  assert.equal(parseFrame({ jsonrpc: '2.0', method: 'x', params: [1] }), null); // positional params
  assert.equal(parseFrame({ jsonrpc: '2.0', id: { evil: true }, method: 'x' }), null);
  assert.equal(parseFrame({ jsonrpc: '2.0', method: 'x'.repeat(101) }), null);
  assert.equal(parseFrame('{"jsonrpc":"2.0","method":"x"}'), null); // strings are not frames
  assert.equal(parseFrame(null), null);
});

test('frameBytes measures UTF-8 JSON and refuses cycles', () => {
  assert.equal(frameBytes({ a: 'é' }), JSON.stringify({ a: 'é' }).length + 1);
  assert.equal(frameBytes({ a: '😀' }), '{"a":""}'.length + 4);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(frameBytes(cyclic), Infinity);
  assert.ok(frameBytes({ data: 'x'.repeat(APP_BRIDGE_LIMITS.messageBytes) }) > APP_BRIDGE_LIMITS.messageBytes);
});

test('actions are the calls with effects outside the frame', () => {
  const call = (name: string) => ({ method: 'tools/call', params: { name } });
  assert.equal(isAction(call('wf_event')), true);
  assert.equal(isAction(call('wf_complete')), true);
  assert.equal(isAction(call('wf_state_set')), true);
  assert.equal(isAction(call('wf_state_get')), false);
  assert.equal(isAction(call('wf_mermaid')), false);
  assert.equal(isAction({ method: 'ui/message', params: {} }), true);
  assert.equal(isAction({ method: 'ui/open-link', params: {} }), true);
  assert.equal(isAction({ method: 'ui/initialize', params: {} }), false);
  assert.equal(isSizeChange({ method: 'ui/notifications/size-changed', params: {} }), true);
});

test('limiter: messages per second and actions per minute', () => {
  const limiter = new BridgeLimiter({ messagesPerSecond: 5, actionsPerMinute: 3 });
  for (let i = 0; i < 5; i++) assert.equal(limiter.allow(false, 1000 + i), true);
  assert.equal(limiter.allow(false, 1010), false); // 6th within one second
  assert.equal(limiter.allow(false, 2100), true); // window moved on
  const actions = new BridgeLimiter({ messagesPerSecond: 100, actionsPerMinute: 3 });
  assert.equal(actions.allow(true, 0), true);
  assert.equal(actions.allow(true, 1000), true);
  assert.equal(actions.allow(true, 2000), true);
  assert.equal(actions.allow(true, 3000), false);
  assert.equal(actions.allow(false, 3000), true); // plain messages still pass
  assert.equal(actions.allow(true, 61_000), true); // first action left the window
});

test('a refused action does not consume message budget', () => {
  const limiter = new BridgeLimiter({ messagesPerSecond: 2, actionsPerMinute: 1 });
  assert.equal(limiter.allow(true, 0), true);
  assert.equal(limiter.allow(true, 1), false);
  assert.equal(limiter.allow(false, 2), true); // second message slot was still free
});

test('result helpers follow the MCP tools/call shape', () => {
  assert.deepEqual(toolResult({ ok: true }), { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } });
  const error = toolError('x'.repeat(400));
  assert.equal(error.isError, true);
  assert.equal(((error.content as Array<{ text: string }>)[0].text).length, 300);
});

test('clampHeight keeps reported heights sane', () => {
  assert.equal(clampHeight(240.2), 241);
  assert.equal(clampHeight('300'), 300);
  assert.equal(clampHeight(5), 24);
  assert.equal(clampHeight(1e9), 4000);
  assert.equal(clampHeight(-1), undefined);
  assert.equal(clampHeight('abc'), undefined);
});

test('messageText reads MCP content blocks and caps the text', () => {
  assert.equal(messageText({ role: 'user', content: { type: 'text', text: ' hi ' } }), 'hi');
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ content: 'plain' }), 'plain');
  assert.equal(messageText({}), '');
  assert.equal(messageText({ content: { type: 'text', text: 'x'.repeat(5000) } }).length, 4000);
});
