// RpcPeer (devices/rpc-peer.ts, MP6 follow-up): a call refused before anything left this PC – the
// channel was closed already, or closed under the send – says details.reachable false (the other
// PC never saw it: remote-agents.ts keeps its placeholder instead of guessing an unknown effect);
// a call that was sent and then lost its channel does not claim that. Owns: these assertions only.
// Never: opens sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcPeer } from '../../../src/runtime/devices/rpc-peer.ts';
import type { SecureChannel } from '../../../src/runtime/devices/channel.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

function fakeChannel(options: { closed?: boolean; sendFails?: boolean } = {}) {
  const closers: Array<() => void> = [];
  const sent: unknown[] = [];
  const channel = {
    peerId: 'dev_other', closed: options.closed ?? false,
    onMessage: () => undefined,
    onClose: (fn: () => void) => { closers.push(fn); },
    send: (message: unknown) => { if (options.sendFails) throw new Error('Channel closed'); sent.push(message); },
    close: () => undefined,
  };
  return { channel: channel as unknown as SecureChannel, sent, drop: () => { channel.closed = true; for (const fn of closers) fn(); } };
}

const reachable = (error: unknown) => error instanceof WorkforceError ? (error.details as { reachable?: unknown } | undefined)?.reachable : 'not a WorkforceError';

test('a call on a closed channel, or one whose send fails, is refused as never sent', async () => {
  const closed = new RpcPeer(fakeChannel({ closed: true }).channel, () => undefined);
  const before = await closed.call('agents.deliver', {}).catch((error: unknown) => error);
  assert.equal((before as WorkforceError).code, 'unavailable');
  assert.equal(reachable(before), false);

  const failing = new RpcPeer(fakeChannel({ sendFails: true }).channel, () => undefined);
  const under = await failing.call('agents.deliver', {}, { timeoutMs: 50 }).catch((error: unknown) => error);
  assert.equal((under as WorkforceError).code, 'unavailable');
  assert.equal(reachable(under), false, 'rejected at once, not after the timeout');
});

test('a sent call whose channel closes later is not marked unsent (its effect is unknown)', async () => {
  const fake = fakeChannel();
  const peer = new RpcPeer(fake.channel, () => undefined);
  const pending = peer.call('agents.deliver', { title: 'x' }).catch((error: unknown) => error);
  assert.equal(fake.sent.length, 1, 'the request left this PC');
  fake.drop();
  const error = await pending;
  assert.equal((error as WorkforceError).code, 'unavailable');
  assert.notEqual(reachable(error), false);
});
