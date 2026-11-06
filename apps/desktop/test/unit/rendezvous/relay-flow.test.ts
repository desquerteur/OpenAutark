// Linked PCs and the meeting server (devices/rendezvous/service.ts against the real services/remote-relay
// on loopback): the server hands out the address it sees with the peer port and the PCs talk directly;
// only when no direct path answers does a tunnel carry the link; revoking cuts it; Connect by Remote ID
// finds the PC there and its request steps travel sealed; a lookup while the server is still connecting
// waits for it; off or not reachable, the lookup says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEETING_OFF, MEETING_UNREACHABLE } from '../../../src/runtime/remote/find.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { link, makePc, reset, startRelay, stopAll, until } from './rig.ts';

test('direct through the address the server saw: no tunnel when the peer port answers', async (t) => {
  reset();
  const relay = await startRelay();
  t.after(() => relay.close());
  const laptop = await makePc('Laptop', relay.url);
  const tower = await makePc('Tower', relay.url);
  t.after(() => stopAll([laptop, tower]));
  tower.port = 47999;
  tower.reachable = true;
  tower.address = 'http://10.99.0.2:47812'; // its stored LAN address is of another network
  link(laptop, tower);
  laptop.meeting.start();
  tower.meeting.start();
  await until(() => laptop.meeting.state().peersOnline, (n) => n === 1, 'tower online at the server');
  await laptop.mesh.connect(tower.identity.deviceId);
  assert.ok(laptop.dialed.includes('http://127.0.0.1:47999'), 'the address the server saw was dialed');
  assert.equal(relay.stats().tunnels, 0, 'no tunnel');
});

test('blocked direct addresses: the link runs through a tunnel; revoke cuts it', async (t) => {
  reset();
  const relay = await startRelay();
  t.after(() => relay.close());
  const laptop = await makePc('Laptop', relay.url);
  const tower = await makePc('Tower', relay.url);
  t.after(() => stopAll([laptop, tower]));
  link(laptop, tower);
  laptop.meeting.start();
  tower.meeting.start();
  await until(() => laptop.meeting.state().peersOnline, (n) => n === 1, 'tower online at the server');
  tower.mesh.register('echo', async (params) => params);
  assert.deepEqual(await laptop.mesh.call(tower.identity.deviceId, 'echo', { x: 1 }), { x: 1 });
  assert.equal(relay.stats().tunnels, 1, 'one tunnel carries it');
  await until(() => laptop.meeting.state().relayed.length, (n) => n === 1, 'relayed shown');
  laptop.mesh.revoke(tower.identity.deviceId);
  await until(() => relay.stats().tunnels, (n) => n === 0, 'the tunnel closes when unpinned');
});

test('Connect by Remote ID over the server: found with its key, request steps sealed end to end', async (t) => {
  reset();
  const relay = await startRelay();
  t.after(() => relay.close());
  const laptop = await makePc('Laptop', relay.url);
  const tower = await makePc('Tower', relay.url);
  t.after(() => stopAll([laptop, tower]));
  laptop.meeting.start();
  tower.meeting.start();
  await until(() => [laptop.meeting.state().status, tower.meeting.state().status], (s) => s.every((v) => v === 'connected'), 'both connected');
  const found = await laptop.meeting.find(remoteIdOf(tower.identity.fingerprint), AbortSignal.timeout(5_000));
  assert.deepEqual(found.map((entry) => [entry.deviceId, entry.name, entry.addresses[0]]), [[tower.identity.deviceId, 'Tower', `relay:${tower.identity.fingerprint}`]]);
  const reply = await laptop.meeting.post(found[0].addresses[0], { kind: 'remote2', session: 's' }, { timeoutMs: 5_000 }) as { ok: boolean; echo: unknown };
  assert.equal(reply.ok, true);
  assert.deepEqual(tower.handled.map((entry) => entry.body), [{ kind: 'remote2', session: 's' }]);
  assert.match(String(tower.handled[0].address), /^relay:[0-9a-f]{16}$/, 'counted under the server\'s source tag');
  tower.findable = false;
  const refused = await laptop.meeting.post(found[0].addresses[0], { kind: 'remote2', session: 's' }, { timeoutMs: 5_000 }) as { ok: boolean };
  assert.equal(refused.ok, false, 'a PC that does not accept requests refuses');
});

test('a lookup while the server is still connecting waits for it; off or not reachable it says so', async (t) => {
  reset();
  const relay = await startRelay();
  t.after(() => relay.close());
  const tower = await makePc('Tower', relay.url);
  const laptop = await makePc('Laptop', relay.url);
  const away = await makePc('Away', 'ws://127.0.0.1:9'); // nothing listens there
  const off = await makePc('Off');
  t.after(() => stopAll([tower, laptop, away, off]));
  tower.meeting.start();
  await until(() => tower.meeting.state().status, (status) => status === 'connected', 'tower connected');
  laptop.meeting.start();
  assert.equal(laptop.meeting.state().status, 'connecting', 'asked right at the start');
  const found = await laptop.meeting.find(remoteIdOf(tower.identity.fingerprint), AbortSignal.timeout(5_000));
  assert.deepEqual(found.map((entry) => entry.deviceId), [tower.identity.deviceId], 'found once the connection was up');

  off.meeting.start();
  const unavailable = (text: string) => (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === text;
  await assert.rejects(off.meeting.find(remoteIdOf(tower.identity.fingerprint), AbortSignal.timeout(5_000)), unavailable(MEETING_OFF), 'no server set');
  away.meeting.start();
  const started = Date.now();
  await assert.rejects(away.meeting.find(remoteIdOf(tower.identity.fingerprint), AbortSignal.timeout(400)), unavailable(MEETING_UNREACHABLE), 'not up before the deadline');
  assert.ok(Date.now() - started < 3_000, 'it waits only until its signal ends');
});
