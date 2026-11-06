// End-to-end (Remote, 23.10.2026): two headless runtimes on this machine. B types A's Remote ID
// → found by a loopback discovery probe → A shows the request with the same 4-digit code (Settings › Devices – no
// decision to-do any more) → A's person accepts (remote.decide) → both list each other and connect. Then once more, declined;
// then with requests turned off on A nothing answers. Discovery stays on loopback
// (WORKFORCE_DISCOVERY_TARGETS: each runtime listens on its own 127.0.0.x, probes go to both).
// The request travels over the peer listeners' LAN/tailnet addresses of this machine (skipped
// without any).
// Second test (B-072): the same through a meeting server – `node services/remote-relay/src/main.ts` on
// ws://127.0.0.1 – with LAN discovery off (each runtime probes only its own loopback address): the Remote ID is found
// there, the request steps travel sealed through it, Accept links both; requests off on A: "is online" names nobody.
// Run: npm run build && node --test test/e2e/runtime-remote.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';

const A_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.2,127.0.0.3' };
const B_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.3,127.0.0.2' };
const group = (id) => `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
const RELAY_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'services', 'remote-relay', 'src', 'main.ts');

async function until(read, ok, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The meeting server from its source on 127.0.0.1 (an ephemeral port, read from its start line). */
async function startMeeting() {
  const child = spawn(process.execPath, [RELAY_MAIN], {
    cwd: path.dirname(path.dirname(RELAY_MAIN)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' },
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the meeting server did not start\n${out}`)), 20_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((entry) => entry.includes('meeting server listening'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).port); }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the meeting server exited (${code})\n${out}`)); });
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(resolve, 5000).unref?.(); } }),
  };
}

test('two runtimes connect by Remote ID; the target\'s person accepts with the same code', { timeout: 240_000 }, async (t) => {
  const a = await startRuntime({ env: A_ENV });
  t.after(() => a.stop());
  const b = await startRuntime({ env: B_ENV });
  t.after(() => b.stop());
  for (const runtime of [a, b]) await runtime.client.call('events.subscribe', { topics: ['system', 'tasks'] });
  const peer = await until(() => a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no LAN or tailnet address for the peer listener'); return; }

  const aState = await a.client.call('remote.state');
  assert.match(aState.self.remoteId, /^\d{9}$/);
  assert.equal(aState.self.findable, true, 'requests are on by default');
  const aId = aState.self.deviceId;
  const bId = (await b.client.call('remote.state')).self.deviceId;

  // 1. By Remote ID (typed with spaces).
  const started = Date.now();
  const out = await b.client.call('remote.connect', { target: group(aState.self.remoteId) });
  assert.equal(out.status, 'waiting', JSON.stringify(out));
  assert.equal(out.deviceId, aId);
  assert.match(out.code, /^\d{4}$/);
  const incoming = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  assert.equal(incoming[0].code, out.code, 'both screens show the same match code');
  assert.equal(incoming[0].deviceId, bId);
  assert.equal((await a.client.call('todos.list')).filter((task) => task.title.endsWith(`code ${out.code}`)).length, 0, 'no decision to-do');
  await a.client.call('remote.decide', { id: incoming[0].id, accept: true });
  await until(() => b.client.call('remote.state').then((state) => state.outgoing?.status), (status) => status === 'accepted', 'B to hear the acceptance');
  await until(() => a.client.call('devices.list').then((list) => list.find((device) => device.id === bId)?.status), (status) => status === 'online', 'A to list B online');
  await until(() => b.client.call('devices.list').then((list) => list.find((device) => device.id === aId)?.status), (status) => status === 'online', 'B to list A online');
  t.diagnostic(`Remote ID → accepted → both online: ${Date.now() - started} ms`);
  const allow = (await a.client.call('devices.list')).find((device) => device.id === bId).allow ?? {};
  assert.ok(!Object.values(allow).some(Boolean), 'a new connection allows nothing yet');
  await b.client.call('remote.cancel'); // closes the outcome

  // 2. Again by Remote ID after an unlink (connecting by name went – Umbau Einfachheit), declined this time.
  await a.client.call('devices.revoke', { id: bId });
  await b.client.call('devices.revoke', { id: aId }).catch(() => undefined); // A's unlink may have reached B already
  const byName = await b.client.call('remote.connect', { target: aState.self.remoteId });
  assert.equal(byName.deviceId, aId, JSON.stringify(byName));
  const second = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the second request on A');
  await a.client.call('remote.decide', { id: second[0].id, accept: false });
  await until(() => b.client.call('remote.state').then((state) => state.outgoing?.status), (status) => status === 'declined', 'B to hear the decline');

  // 3. Requests off on A: nobody answers the Remote ID; no meeting server is set, so the text names it.
  await a.client.call('settings.update', { devices: { findable: false } });
  await assert.rejects(b.client.call('remote.connect', { target: aState.self.remoteId }), /Meeting server off \(devices\.relay\) – no PC with this Remote ID on this network\. Open Autark on that PC/);
});

test('through a local meeting server with LAN discovery off: found by Remote ID, accepted, linked', { timeout: 240_000 }, async (t) => {
  const meeting = await startMeeting();
  t.after(() => meeting.stop());
  // Each runtime probes only its own loopback address: the other one is never found on "this network".
  const a = await startRuntime({ env: { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.7' } });
  t.after(() => a.stop());
  const b = await startRuntime({ env: { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.8' } });
  t.after(() => b.stop());
  for (const runtime of [a, b]) await runtime.client.call('settings.update', { devices: { relay: meeting.url } });
  for (const [name, runtime] of [['A', a], ['B', b]]) {
    await until(() => runtime.client.call('remote.relay').then((state) => state.status), (status) => status === 'connected', `${name} at the meeting server`);
  }
  assert.deepEqual(await b.client.call('remote.nearby', { refresh: true }), [], 'nobody on "this network"');

  const aState = await a.client.call('remote.state');
  const aId = aState.self.deviceId;
  const bId = (await b.client.call('remote.state')).self.deviceId;
  const started = Date.now();
  const out = await b.client.call('remote.connect', { target: group(aState.self.remoteId) });
  assert.equal(out.status, 'waiting', JSON.stringify(out));
  assert.equal(out.deviceId, aId);
  const incoming = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  assert.equal(incoming[0].code, out.code, 'the same code on both screens');
  assert.match(String(incoming[0].address ?? ''), /^relay:[0-9a-f]{16}$/, 'it came through the meeting server');
  await a.client.call('remote.decide', { id: incoming[0].id, accept: true });
  await until(() => b.client.call('remote.state').then((state) => state.outgoing?.status), (status) => status === 'accepted', 'B to hear the acceptance');
  await until(() => a.client.call('devices.list').then((list) => list.find((device) => device.id === bId)?.status), (status) => status === 'online', 'A to list B online');
  await until(() => b.client.call('devices.list').then((list) => list.find((device) => device.id === aId)?.status), (status) => status === 'online', 'B to list A online');
  const relayed = (await b.client.call('remote.relay')).relayed;
  t.diagnostic(`meeting server: Remote ID → accepted → both online in ${Date.now() - started} ms (${relayed.length ? 'through the tunnel' : 'direct'})`);
  await b.client.call('remote.cancel');

  // Requests off on A: the server no longer finds it; the text says nobody with this Remote ID is online. A few tries a
  // second apart (the server hears A's change on A's own connection; it allows 10 lookups a minute per address).
  await a.client.call('settings.update', { devices: { findable: false } });
  let text = '';
  for (let attempt = 0; attempt < 3 && !/^No PC with this Remote ID is online\./.test(text); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    text = await b.client.call('remote.connect', { target: aState.self.remoteId }).then((result) => `a request went out: ${JSON.stringify(result)}`, (cause) => cause.message);
  }
  assert.match(text, /^No PC with this Remote ID is online\. Open Autark on that PC – Settings › Devices shows its Remote ID\.$/);
});
