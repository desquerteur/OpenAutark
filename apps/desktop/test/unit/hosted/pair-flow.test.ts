// The iPhone web app end to end without an iPhone: the real meeting server (services/remote-relay via
// rendezvous/rig.ts), a PC with its real Meeting, RemoteWithPhones, PwaService.pairPhone and PhoneBridge, and the hosted
// pair() and Connection (src/ui/hosted) on Node's global WebSocket and WebCrypto. The same code on both screens, Accept
// → token and the PC pins the phone; presence → tunnel → handshake → the PC's '/' and a /ws session through the
// bridge; after the meeting server dropped, the phone comes back; after Remove, no tunnel, and after the window the
// shell hears "unanswered"; a socket killed while the code is up (a locked iPhone) still ends with the token.
// Owns: these assertions. Never: a browser (test/e2e/hosted-iphone.test.mjs) or a real iPhone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, type Timers } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { RemoteWithPhones } from '../../../src/runtime/devices/rendezvous/phone-pair.ts';
import { PhoneBridge } from '../../../src/runtime/devices/rendezvous/phone.ts';
import { Meeting } from '../../../src/runtime/devices/rendezvous/service.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fromUtf8 } from '../../../src/ui/hosted/bytes.ts';
import { Connection, UNANSWERED_TEXT } from '../../../src/ui/hosted/connection.ts';
import type { WsFactory, WsLike } from '../../../src/ui/hosted/relay.ts';
import { httpFetch } from '../../../src/ui/hosted/http.ts';
import { pairByRemoteId, Pairing } from '../../../src/ui/hosted/pair.ts';
import { HostedStore, memoryBackend, pcEntry, type Saved } from '../../../src/ui/hosted/store.ts';
import { StreamSocket } from '../../../src/ui/hosted/ws.ts';
import { fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';
import { startRelay, until, type RelayHandle } from '../rendezvous/rig.ts';

const realTimers: Timers = { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

async function pcUi(t: { after(fn: () => void): void }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta name="autark-hosted" content="1"><link rel="stylesheet" href="main.css"><script type="module" src="main.js"></script><div id="app"></div>'); return; }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as { id?: number; method?: string };
    if (frame.method === 'session.info') ws.send(JSON.stringify({ id: frame.id, result: { scope: 'device' } }));
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { wss.close(); server.closeAllConnections(); server.close(); });
  return (server.address() as { port: number }).port;
}

async function desk(relay: () => string, uiPort: number) {
  const db = memoryDb();
  const { bus } = recordingBus();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock: systemClock, name: 'Desk' });
  const mesh = new DeviceMesh({ db, identity, clock: systemClock, log: silentLog, bus, timers: realTimers, dial: async () => { throw new Error('no direct path'); } });
  const settings = { get: () => ({ pwa: { enabled: false, bind: 'localhost' } }), update: () => undefined } as never;
  const push = { subscribedDevices: () => new Set<string>(), publicKey: async () => 'key', removeDevice: () => undefined } as never;
  const pwa = new PwaService({ db, clock: systemClock, bus, log: silentLog, settings, push, port: () => uiPort, qr: async () => '', serveStatus: async () => undefined, interfaces: () => ({}) });
  const remote = new RemoteWithPhones({
    identity, clock: systemClock, bus, log: silentLog, mesh, timers: realTimers, findable: () => true,
    post: async () => { throw new Error('unused'); }, pair: (phone) => pwa.pairPhone(phone),
  });
  const phones = new PhoneBridge({ identity, log: silentLog, port: () => uiPort });
  const meeting = new Meeting({
    db, bus, log: silentLog, clock: systemClock, identity, mesh, timers: realTimers, phones,
    remote: { handle: (body, from) => remote.handle(body, from), wellKnown: () => ({ deviceId: identity.deviceId, name: 'Desk', fingerprint: identity.fingerprint }), kinds: new Set(['remote1', 'remote2', 'remote3', 'remoteCancel']) },
    relayUrl: relay, findable: () => true, port: () => undefined,
  });
  meeting.start();
  return { identity, remote, pwa, meeting, phones, repo: new DevicesRepo(db), stop: () => { meeting.stop(); phones.closeAll(); mesh.close(); } };
}

test('pair by Remote ID, then the PC\'s UI and its /ws through the meeting server; reconnect; Remove ends it', async (t) => {
  let relay: RelayHandle = await startRelay();
  const port = relay.port;
  t.after(() => relay.close());
  const uiPort = await pcUi(t);
  const pc = await desk(() => relay.url, uiPort);
  t.after(() => pc.stop());
  await until(() => pc.meeting.state().status, (status) => status === 'connected', 'the PC at the meeting server');

  // ── pairing: the same code on both screens, Accept on the PC
  const shown: string[] = [];
  const pairing = new Pairing();
  const paired = pairByRemoteId({ relay: relay.url, remoteId: remoteIdOf(pc.identity.fingerprint), name: 'iPhone', pairing, code: (code) => shown.push(code) });
  const request = await until(() => pc.remote.state().incoming[0], Boolean, 'the request on the PC');
  await until(() => shown.length, (n) => n === 1, 'the code on the phone');
  assert.equal(request.role as string, 'phone');
  assert.equal(request.name, 'iPhone');
  assert.equal(request.code, shown[0], 'both screens show the same code');
  pc.remote.decide(request.id, true);
  const result = await paired;
  assert.equal(result.key.privateKey.extractable, false);
  const record = pc.repo.get(result.deviceId)!;
  assert.equal(record.kind, 'phone');
  assert.equal(pc.pwa.authenticate(result.token)?.kind, 'device', 'the token in the sealed answer works');
  assert.deepEqual(result.pcs.map((row) => row.fingerprint), [pc.identity.fingerprint]);

  // ── storage round trip (what the shell keeps in IndexedDB)
  const store = new HostedStore(memoryBackend());
  const saved: Saved = { key: result.key, deviceId: result.deviceId, relay: result.relay, token: result.token, pcs: result.pcs };
  await store.save(saved);
  const loaded = (await store.load())!;
  assert.equal(loaded.token, result.token);

  // ── the connection: presence → tunnel → handshake → '/' and /ws
  const statuses: string[] = [];
  const connection = new Connection({ saved: loaded, status: (text) => statuses.push(text) });
  t.after(() => connection.stop());
  connection.start();
  const mux = await connection.awaitMux(10_000);
  assert.ok(mux, `a channel came up (${statuses.join(' | ')})`);
  const index = await httpFetch(mux, { method: 'GET', path: '/' });
  assert.deepEqual(pcEntry(fromUtf8(index.body)), { css: 'main.css', js: 'main.js' }, 'the marker check passes');
  const socket = new StreamSocket((ms) => connection.awaitMux(ms));
  const reply = await new Promise<unknown>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ id: 7, method: 'session.info' }));
    socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
    socket.onclose = (event) => reject(new Error(`closed ${event.code}`));
  });
  assert.deepEqual(reply, { id: 7, result: { scope: 'device' } });
  assert.ok(statuses.includes('Connected to Desk.'));

  // ── the meeting server drops and comes back: the phone reconnects
  await relay.close();
  await until(() => connection.mux, (value) => value === undefined, 'the channel ends with the server');
  relay = await startRelay(port);
  pc.meeting.nudge();
  connection.nudge(Number.MAX_SAFE_INTEGER);
  assert.ok(await connection.awaitMux(20_000), 'back after the server restarted');

  // ── Remove on the PC: the pin ends, the tunnel goes, no new one opens
  await pc.pwa.revoke(result.deviceId);
  await until(() => connection.mux, (value) => value === undefined, 'the channel ends after Remove', 10_000);
  await until(() => relay.stats().tunnels, (n) => n === 0, 'no tunnel at the server');
  connection.nudge(Number.MAX_SAFE_INTEGER);
  assert.equal(await connection.awaitMux(3_000), undefined, 'a removed phone gets no channel');
  socket.close();

  // ── a removed phone hears nothing (its pin is gone): after the window the shell learns it, with the honest line
  const heard: boolean[] = [];
  const after: string[] = [];
  const removed = new Connection({ saved: loaded, unansweredMs: 400, unanswered: (on) => heard.push(on), status: (text) => after.push(text) });
  t.after(() => removed.stop());
  removed.start();
  await until(() => heard.length, (n) => n === 1, 'unanswered after the window', 5_000);
  assert.deepEqual(heard, [true]);
  assert.equal(after.at(-1), UNANSWERED_TEXT);
});

test('the iPhone locks while the code is up: the wait registers the same key again and still gets the token', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const uiPort = await pcUi(t);
  const pc = await desk(() => relay.url, uiPort);
  t.after(() => pc.stop());
  await until(() => pc.meeting.state().status, (status) => status === 'connected', 'the PC at the meeting server');
  const sockets: WebSocket[] = [];
  const socket: WsFactory = (url) => { const ws = new WebSocket(url); sockets.push(ws); return ws as unknown as WsLike; };
  const pairing = new Pairing();
  let shown = false;
  const paired = pairByRemoteId({ relay: relay.url, remoteId: remoteIdOf(pc.identity.fingerprint), name: 'iPhone', pairing, socket, code: () => { shown = true; } });
  const request = await until(() => pc.remote.state().incoming[0], Boolean, 'the request on the PC');
  await until(() => shown, Boolean, 'the code on the phone');
  await new Promise((resolve) => setTimeout(resolve, 100)); // remote3 is waiting at the PC
  sockets.at(-1)!.close(); // iOS froze the page and killed its socket
  await until(() => sockets.length, (n) => n === 2, 'a second registration with the same key');
  pc.remote.decide(request.id, true);
  const result = await paired;
  assert.equal(pc.pwa.authenticate(result.token)?.kind, 'device', 'the token arrived after the reconnect');
  assert.equal(pc.repo.list({ kinds: ['phone'] }).length, 1, 'one phone row, not one per retry');
});

test('a typo in the Remote ID is caught before anything is sent; Cancel during the code tells the PC', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const uiPort = await pcUi(t);
  const pc = await desk(() => relay.url, uiPort);
  t.after(() => pc.stop());
  await until(() => pc.meeting.state().status, (status) => status === 'connected', 'the PC at the meeting server');
  const id = remoteIdOf(pc.identity.fingerprint);
  const typo = id.slice(0, 8) + String((Number(id[8]) + 1) % 10);
  await assert.rejects(pairByRemoteId({ relay: relay.url, remoteId: typo, name: 'iPhone', pairing: new Pairing(), code: () => undefined }), /typo/);
  const pairing = new Pairing();
  const asked = pairByRemoteId({ relay: relay.url, remoteId: id, name: 'iPhone', pairing, code: () => pairing.cancel() });
  await assert.rejects(asked, /Cancelled/);
  await until(() => pc.remote.state().incoming.length, (n) => n === 0, 'the request is gone on the PC');
});
