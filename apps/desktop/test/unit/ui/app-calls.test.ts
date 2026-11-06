// Bridge call ring: names reduced to known methods/tools, size and time only, fixed capacity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_METHODS, APP_TOOLS } from '../../../src/shared/blocks/app-bridge.ts';
import { callName, CallRing, finishCall, isReply, logCall } from '../../../src/ui/blocks/app-calls.ts';
import { frameElementId } from '../../../src/ui/blocks/app-guard.ts';

test('names: known methods and wf_* tools kept, anything else is "other"', () => {
  assert.deepEqual(callName({ jsonrpc: '2.0', method: APP_METHODS.initialize }), { method: 'ui/initialize' });
  assert.deepEqual(callName({ method: 'ui/open-link', params: { url: 'https://x.test/?secret=1' } }), { method: 'ui/open-link' });
  assert.deepEqual(callName({ method: APP_METHODS.toolsCall, params: { name: APP_TOOLS.stateSet, arguments: { state: 'x' } } }), { method: 'tools/call', tool: 'wf_state_set' });
  assert.deepEqual(callName({ method: APP_METHODS.toolsCall, params: { name: 'leak:my-secret' } }), { method: 'tools/call', tool: 'other' });
  assert.deepEqual(callName({ method: 'data:hidden-in-method' }), { method: 'other' });
  assert.deepEqual(callName('{"method":"ui/message"}'), { method: 'other' });
  assert.deepEqual(callName(null), { method: 'other' });
});

test('an entry never holds payload content', () => {
  const ring = new CallRing(10);
  const message = { jsonrpc: '2.0', id: 1, method: APP_METHODS.message, params: { content: { type: 'text', text: 'TOP-SECRET-TEXT' } } };
  const entry = logCall(ring, 'msg_1:0', message, 120, 'pending', 1000);
  assert.deepEqual(entry, { at: 1000, frame: 'msg_1:0', method: 'ui/message', bytes: 120, result: 'pending' });
  assert.equal(JSON.stringify(ring.entries()).includes('TOP-SECRET'), false);
  finishCall(entry, 'ok', 1042);
  assert.deepEqual(ring.entries()[0], { at: 1000, frame: 'msg_1:0', method: 'ui/message', bytes: 120, result: 'ok', ms: 42 });
  assert.equal(logCall(ring, 'msg_1:0', {}, Infinity, 'too-large').bytes, -1);
});

test('the ring keeps the newest entries, oldest first, and filters by frame', () => {
  const ring = new CallRing(3);
  for (let i = 0; i < 5; i++) logCall(ring, i % 2 ? 'b' : 'a', { method: APP_METHODS.sizeChanged }, i, 'ok', i);
  assert.equal(ring.size, 3);
  assert.deepEqual(ring.entries().map((entry) => entry.at), [2, 3, 4]);
  assert.deepEqual(ring.entries('a').map((entry) => entry.at), [2, 4]);
  ring.entries()[0].bytes = 999; // copies
  assert.equal(ring.entries()[0].bytes, 2);
  ring.clear();
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.entries(), []);
});

test('replies (e.g. heartbeat answers) are recognised and not calls', () => {
  assert.equal(isReply({ jsonrpc: '2.0', id: 'wf-ping-1', result: {} }), true);
  assert.equal(isReply({ jsonrpc: '2.0', id: 3, error: { code: 1 } }), true);
  assert.equal(isReply({ jsonrpc: '2.0', id: 3, method: 'ping' }), false);
  assert.equal(isReply({ jsonrpc: '2.0', id: 3 }), false);
  assert.equal(isReply('x'), false);
});

test('frame element ids are valid and differ per mode', () => {
  assert.equal(frameElementId('msg_1:0', 'inline'), 'wf-app-msg_1_0-inline');
  assert.notEqual(frameElementId('msg_1:0', 'inline'), frameElementId('msg_1:0', 'fullscreen'));
  assert.match(frameElementId('a b"<x>', 'inline'), /^[A-Za-z0-9_-]+$/);
});
