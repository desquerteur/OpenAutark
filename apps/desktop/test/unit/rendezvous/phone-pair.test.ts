// B-078 (D5): the phone pairs like a PC – remote1…remote3 with role 'phone' and its own key, the same code on both
// screens, Accept on the PC (rendezvous/phone-pair.ts). The requester here is written the way the Android app does it
// (apps/android relay/RemotePair.java): only the public sas.ts / pair-proof.ts steps, JSON round trips in between.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { b64url, fingerprintOf, fromB64url } from '../../../src/runtime/devices/keys.ts';
import { mac, macOk } from '../../../src/runtime/devices/pair-proof.ts';
import { isPhoneStep, RemoteWithPhones } from '../../../src/runtime/devices/rendezvous/phone-pair.ts';
import { phoneInfo, TargetRequests } from '../../../src/runtime/remote/requests.ts';
import { bytes, commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from '../../../src/runtime/remote/sas.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import type { RemoteState } from '../../../src/shared/model/remote.ts';
import { HandTimers } from '../remote/rig.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function pcWithPhones() {
  const db = memoryDb();
  const { bus, events } = recordingBus();
  const clock = new ManualClock();
  const timers = new HandTimers();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name: 'Desk' });
  const mesh = new DeviceMesh({ db, identity, clock, log: silentLog, bus, timers, dial: async () => { throw new Error('no network'); } });
  const settings = { get: () => ({ pwa: { enabled: false, bind: 'localhost' } }), update: () => undefined } as never;
  const push = { subscribedDevices: () => new Set<string>(), publicKey: async () => 'key', removeDevice: () => undefined } as never;
  const pwa = new PwaService({ db, clock, bus, log: silentLog, settings, push, port: () => 1, qr: async () => '', serveStatus: async () => undefined, interfaces: () => ({}) });
  const shown: unknown[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const remote = new RemoteWithPhones({
    identity, clock, bus, log: silentLog, mesh, timers, findable: () => true,
    post: async () => { throw new Error('unused'); },
    notify: (view) => shown.push(view), linked: (note) => notes.push(note),
    pair: (phone) => pwa.pairPhone(phone),
  });
  return { remote, pwa, repo: new DevicesRepo(db), identity, events, shown, notes, mesh };
}

/** The Android app's side of the exchange. */
async function phoneAsks(target: { handle(body: Record<string, unknown>, from: { address?: string }): Promise<unknown> }, name = 'Pixel 8') {
  const key = await DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: new ManualClock(), name: 'phone' });
  const info = { id: `dev_${randomBytes(8).toString('hex')}`, name, role: 'client', pub: b64url(key.publicKey), addresses: [] as string[] };
  const eph = newEphemeral();
  const call = async (body: Record<string, unknown>) => json(await target.handle(json(body), { address: 'relay:phone' })) as Record<string, unknown>;
  const first = await call({ kind: 'remote1', v: 1, role: 'phone', device: info, eph: b64url(eph.pub) });
  assert.equal(first.ok, true, JSON.stringify(first));
  const pc = first.device as { pub: string };
  const ephA = bytes(first.eph)!;
  const t = transcript({ a: first.device as never, b: info as never, ephA, ephB: eph.pub, commit: first.commit as string, role: 'phone' as never });
  const nb = newNonce();
  const second = await call({ kind: 'remote2', session: first.session, nb: b64url(nb), sig: b64url(key.sign(signedBytes('B', t))) });
  const na = bytes(second.na, 16)!;
  assert.equal(commitment(ephA, eph.pub, na), first.commit, 'the PC committed to its nonce first');
  assert.ok(verifySide(pc.pub, 'A', t, second.sig), 'the PC signed the transcript with its own key');
  const session = sessionKey(eph.privateKey, ephA, t);
  const wait = () => call({ kind: 'remote3', session: first.session, mac: mac(session, 'remote-wait', first.session) });
  return { info, code: matchCode(t, na, nb), wait, session, t, key, sessionId: first.session as string };
}

test('a phone pairs by Remote ID: same code on both screens, Accept on the PC, its token in the sealed answer', async () => {
  const pc = await pcWithPhones();
  const phone = await phoneAsks(pc.remote);
  const state = pc.remote.state() as RemoteState;
  assert.equal(state.incoming.length, 1);
  const request = state.incoming[0];
  assert.equal(request.role as string, 'phone');
  assert.equal(request.name, 'Pixel 8');
  assert.equal(request.code, phone.code, 'both screens show the same code');
  assert.equal(pc.shown.length, 1, 'one notification');
  assert.ok(pc.events.some((event) => event.event === 'remote.updated'), 'the list updates');

  const waiting = phone.wait();
  pc.remote.decide(request.id, true);
  const answer = await waiting;
  assert.equal(answer.status, 'accepted');
  assert.ok(macOk(mac(phone.session, 'remote-accept', answer.device, b64url(phone.t)), answer.mac), 'the acceptance is the PC\'s');
  assert.equal(typeof answer.token, 'string');
  assert.equal(answer.deviceId, phone.info.id);
  const record = pc.repo.get(phone.info.id)!;
  assert.equal(record.kind, 'phone');
  assert.equal(record.publicKey, phone.info.pub, 'pinned by its own key');
  assert.equal(record.fingerprint, fingerprintOf(fromB64url(phone.info.pub)));
  assert.equal(pc.pwa.authenticate(answer.token as string)?.kind, 'device', 'the token works without any phone switch');
  assert.deepEqual(pc.pwa.authenticate(answer.token as string) && (pc.pwa.authenticate(answer.token as string) as { capabilities: string[] }).capabilities.includes('permissions'), true);
  assert.equal(pc.notes.length, 1);
  assert.match(pc.notes[0].title, /Pixel 8 is now linked/);
  const again = await phone.wait();
  assert.equal(again.token, answer.token, 'a repeated wait gets the same answer');
  assert.equal(pc.mesh.list().filter((device) => device.kind === 'pc' && !device.self).length, 0, 'no PC link came of it');

  await pc.pwa.revoke(phone.info.id);
  assert.equal(pc.pwa.authenticate(answer.token as string), undefined, 'Remove ends the access');
});

test('a declined phone gets no token; a wrong session key cannot collect the answer', async () => {
  const pc = await pcWithPhones();
  const phone = await phoneAsks(pc.remote);
  const forged = await pc.remote.handle({ kind: 'remote3', session: phone.sessionId, mac: 'x'.repeat(43) }, { address: 'relay:x' });
  assert.deepEqual(forged, { ok: true, status: 'expired' });
  const waiting = phone.wait();
  pc.remote.decide(pc.remote.state().incoming[0].id, false);
  const answer = await waiting;
  assert.equal(answer.status, 'declined');
  assert.equal(answer.token, undefined);
  assert.equal(pc.repo.get(phone.info.id), undefined);
});

test('PC requests never take the phone role and phone requests never become PC links', async () => {
  const plain = new TargetRequests({
    now: () => 0, timers: new HandTimers(), log: silentLog, signer: { sign: () => Buffer.alloc(64) }, findable: () => true,
    self: () => ({ id: 'dev_self000000', name: 'PC', role: 'home', pub: b64url(Buffer.alloc(32, 1)), addresses: [] }), link: () => undefined, shown: () => undefined, changed: () => undefined,
  });
  const reply = await plain.handle({ kind: 'remote1', v: 1, role: 'phone', device: {}, eph: b64url(Buffer.alloc(32, 2)) }, {});
  assert.equal(reply.ok, false);
  assert.equal(isPhoneStep({ kind: 'remote1', role: 'phone' }, { owns: () => false }), true);
  assert.equal(isPhoneStep({ kind: 'remote1', role: 'ceo' }, { owns: () => true }), false);
  assert.equal(isPhoneStep({ kind: 'remote2', session: 's' }, { owns: (session) => session === 's' }), true);
  assert.equal(phoneInfo({ id: 'dev_abcdefghij', name: ' Pixel ', role: 'client', pub: b64url(Buffer.alloc(32, 3)), addresses: ['http://x'] })?.addresses.length, 0);
  assert.equal(phoneInfo({ id: 'dev_abcdefghij', name: 'Pixel', role: 'home', pub: b64url(Buffer.alloc(32, 3)) }), undefined);
});
