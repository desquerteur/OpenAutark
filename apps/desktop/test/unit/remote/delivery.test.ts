// Remote requests that do not go smoothly (remote/requests.ts, join.ts, service.ts): an acceptance
// is stored on the target only when the requester collects it (a requester that is away, cancels
// or gives up never leaves a one-sided link); a lost wait is retried until the request expired,
// then the target hears that the requester gave up; turning requests off ends open requests;
// overlapping connects are refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_GRACE_MS, REQUEST_TTL_MS, WAIT_MAX_MS } from '../../../src/runtime/remote/requests.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RemoteOutgoing } from '../../../src/shared/model/remote.ts';
import { Lan, linkedIds, settle, type Pc } from './rig.ts';

const outgoing = (value: RemoteOutgoing) => value;

/** Ends the target's open long wait ('pending'): the requester pauses before its next one. */
async function idle(target: Pc): Promise<void> {
  target.timers.fire(WAIT_MAX_MS);
  await settle();
}

async function pair() {
  const lan = new Lan();
  const laptop = await lan.add('Laptop', 'http://10.0.0.1:47812');
  const tower = await lan.add('Tower', 'http://10.0.0.2:47812');
  return { lan, laptop, tower };
}

test('an acceptance is stored when the requester collects it; one it never collects stores nothing', async () => {
  const { laptop, tower } = await pair();
  outgoing(await tower.remote.connect({ target: laptop.remote.remoteId() }));
  await idle(laptop); // no wait in flight now
  laptop.remote.decide(laptop.remote.state().incoming[0].id, true);
  await settle();
  assert.deepEqual(linkedIds(laptop), [], 'accepted, but not collected yet: nothing stored');
  assert.deepEqual(laptop.remote.state().incoming, []);
  // The requester cancels before it collected the answer: the target never stores it.
  tower.remote.cancel();
  await settle();
  assert.deepEqual([linkedIds(laptop), linkedIds(tower)], [[], []]);

  // Accepted while the requester pauses; its next wait collects it: both sides store each other.
  outgoing(await tower.remote.connect({ target: laptop.remote.remoteId() }));
  await idle(laptop);
  laptop.remote.decide(laptop.remote.state().incoming[0].id, true);
  laptop.clock.advance(REQUEST_TTL_MS - 1_000); // late in the request: the answer stays collectable
  tower.timers.fire(3_000);
  await settle();
  assert.deepEqual(linkedIds(laptop), [tower.identity.deviceId]);
  assert.deepEqual(linkedIds(tower), [laptop.identity.deviceId]);
  assert.equal(tower.remote.state().outgoing?.status, 'accepted');
});

test('a lost wait is retried until the request expired; then the target hears the requester gave up', async () => {
  const { laptop, tower } = await pair();
  outgoing(await tower.remote.connect({ target: laptop.remote.remoteId() }));
  await idle(laptop);
  tower.drop = (body) => body.kind === 'remote3';
  for (let i = 0; i < 4; i++) { tower.timers.fire(15_000); await settle(); }
  assert.equal(tower.remote.state().outgoing?.status, 'waiting', 'short failures do not end the request');
  assert.ok(tower.sent.filter((kind) => kind === 'remote3').length >= 5, 'it kept asking');
  // The network is back before the request expired: the answer still arrives.
  tower.drop = undefined;
  laptop.remote.decide(laptop.remote.state().incoming[0].id, false);
  tower.timers.fire(15_000);
  await settle();
  assert.equal(tower.remote.state().outgoing?.status, 'declined');

  outgoing(await tower.remote.connect({ target: laptop.remote.remoteId() }));
  await idle(laptop);
  tower.drop = (body) => body.kind === 'remote3';
  tower.clock.advance(REQUEST_TTL_MS + DELIVERY_GRACE_MS);
  tower.timers.fire(15_000);
  await settle();
  assert.equal(tower.remote.state().outgoing?.status, 'failed');
  assert.equal(tower.sent.at(-1), 'remoteCancel', 'giving up is told to the other PC');
  assert.deepEqual(laptop.remote.state().incoming, [], 'so its person is not asked any more');
  assert.deepEqual([linkedIds(laptop), linkedIds(tower)], [[], []]);
});

test('turning requests off ends every open request (declined); overlapping connects are refused', async () => {
  const { laptop, tower } = await pair();
  outgoing(await tower.remote.connect({ target: laptop.remote.remoteId() }));
  laptop.findable = false;
  laptop.remote.refresh();
  await settle();
  assert.deepEqual(laptop.remote.state().incoming, []);
  assert.equal(tower.remote.state().outgoing?.status, 'declined');
  assert.match(tower.remote.state().outgoing?.reason ?? '', /stopped accepting/);
  laptop.findable = true;
  laptop.remote.refresh();

  const first = tower.remote.connect({ target: laptop.remote.remoteId() });
  await assert.rejects(tower.remote.connect({ target: laptop.remote.remoteId() }), (error: WorkforceError) => error.code === 'conflict');
  assert.equal(outgoing(await first).status, 'waiting');
  assert.equal(laptop.remote.state().incoming.length, 1, 'only one request reached the other PC');
});
