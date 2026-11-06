// The relay connection itself (rendezvous/relay-client.ts) against a scripted socket and manual
// timers: it registers with a signature of the challenge and a signed box key, reconnects with
// growing pauses only while an address is set, trusts presence only with a box its pinned key
// signed, ends a silent connection (watchdog) and probes it once on resume – never polling;
// pins changed during registration are sent after 'ready'; incoming tunnels need the opener's
// signed ephemeral key and stay within caps; pairing senders must be key fingerprints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { b64url, fingerprintOf, fromB64url, generateEd25519, rawPublic, signEd25519, verifyEd25519 } from '../../../src/runtime/devices/keys.ts';
import { RelayClient } from '../../../src/runtime/devices/rendezvous/relay-client.ts';
import { PAIR_INFO, boxText, helloText, newBox, sealJson, toBox, tunnelText } from '../../../src/runtime/devices/rendezvous/seal.ts';
import type { RelayTunnel } from '../../../src/runtime/devices/rendezvous/tunnel.ts';
import { silentLog } from '../devices/fakes.ts';

class FakeWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  pings = 0;
  terminated = false;
  send(data: string | Buffer): void { if (typeof data === 'string') this.sent.push(JSON.parse(data)); }
  ping(): void { this.pings++; }
  close(): void { this.terminate(); }
  terminate(): void { if (this.terminated) return; this.terminated = true; this.emit('close', 1006); }
  frame(value: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}

function manualTimers() {
  const queue = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    set: (fn: () => void, ms: number) => { queue.set(++next, { fn, ms }); return next; },
    clear: (handle: unknown) => { queue.delete(handle as number); },
    delays: () => [...queue.values()].map((entry) => entry.ms),
    fire: (ms: number) => { for (const [id, entry] of [...queue]) if (entry.ms === ms) { queue.delete(id); entry.fn(); } },
  };
}

function setup() {
  const keys = generateEd25519();
  const identity = { publicKey: rawPublic(keys.publicKey), sign: (data: Uint8Array) => signEd25519(keys.privateKey, data) };
  const sockets: FakeWs[] = [];
  const timers = manualTimers();
  const presence: string[] = [];
  const incoming: RelayTunnel[] = [];
  const pairs: Array<{ from: string; source: string | undefined }> = [];
  const client = new RelayClient({
    identity, log: silentLog, timers, random: () => 0.5,
    socket: () => { const ws = new FakeWs(); sockets.push(ws); return ws as unknown as WebSocket; },
    events: {
      changed: () => undefined, presence: (fp, online) => presence.push(`${fp.slice(0, 4)}:${online}`),
      incoming: (tunnel) => incoming.push(tunnel), pair: async (from, _body, source) => { pairs.push({ from, source }); return { ok: true }; },
    },
  });
  return { client, identity, sockets, timers, presence, incoming, pairs };
}

test('pins changed while registering reach the relay after ready; tunnels need the opener\'s signed key, within caps; pairing senders are checked', async () => {
  const { client, sockets, incoming, pairs } = setup();
  const peer = generateEd25519();
  const peerPub = b64url(rawPublic(peer.publicKey));
  const fp = fingerprintOf(rawPublic(peer.publicKey));
  client.configure('ws://127.0.0.1:9');
  const ws = sockets[0];
  ws.frame({ t: 'challenge', v: 1, n: 'n' });
  const hello = ws.sent[0] as Record<string, unknown>;
  assert.deepEqual(hello.peers, []);
  client.setPeers([{ fp, pub: peerPub }], false); // paired while 'hello' was on its way
  assert.equal(ws.sent.length, 1, 'nothing is sent before ready');
  ws.frame({ t: 'ready', fp: 'me', online: [] });
  assert.deepEqual(ws.sent[1], { t: 'update', peers: [fp], findable: false }, 'the relay learns the new pin at once');

  const box = hello.box as string;
  const open = (tid: number, e: string, es?: string) => ws.frame({ t: 'incoming', tid, from: fp, e, ...(es ? { es } : {}) });
  const signed = (e: string) => b64url(signEd25519(peer.privateKey, Buffer.from(tunnelText(e, box))));
  const closes = () => ws.sent.filter((frame) => frame.t === 'close').map((frame) => frame.tid);
  const e1 = newBox().pub;
  open(1, e1); // no signature: e.g. a relay standing in for the pinned PC
  open(2, e1, b64url(signEd25519(generateEd25519().privateKey, Buffer.from(tunnelText(e1, box)))));
  assert.deepEqual(closes(), [1, 2]);
  assert.equal(incoming.length, 0);
  open(3, e1, signed(e1));
  assert.equal(incoming.length, 1, 'signed by the pinned key: accepted');
  open(4, e1, signed(e1));
  assert.deepEqual(closes(), [1, 2, 4], 'a replayed key is refused');
  const e2 = newBox().pub;
  const e3 = newBox().pub;
  open(5, e2, signed(e2));
  open(6, e3, signed(e3));
  assert.equal(incoming.length, 2);
  assert.deepEqual(closes(), [1, 2, 4, 6], 'at most two incoming tunnels per PC');

  const { e, cipher } = toBox(box, PAIR_INFO); // a pairing message sealed to this client's box
  ws.frame({ t: 'pair', ref: 1, from: '[a](//ev.il)', src: '0123456789abcdef', e, c: sealJson(cipher, { op: 'wellKnown' }) });
  assert.deepEqual(ws.sent.at(-1), { t: 'pairReply', ref: 1, error: 'stale' }, 'a sender that is no key fingerprint is refused');
  const sealed = toBox(box, PAIR_INFO);
  ws.frame({ t: 'pair', ref: 2, from: 'c'.repeat(64), src: '0123456789abcdef', e: sealed.e, c: sealJson(sealed.cipher, { op: 'wellKnown' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pairs, [{ from: 'c'.repeat(64), source: '0123456789abcdef' }]);
  client.stop();
});

test('registration: signed challenge and box key; backoff only while configured; off stops everything', () => {
  const { client, identity, sockets, timers } = setup();
  client.configure('ws://127.0.0.1:9');
  assert.equal(sockets.length, 1);
  sockets[0].frame({ t: 'challenge', v: 1, n: 'abc' });
  const hello = sockets[0].sent[0] as Record<string, string>;
  assert.equal(hello.t, 'hello');
  assert.ok(verifyEd25519(identity.publicKey, Buffer.from(helloText('abc')), fromB64url(hello.sig)));
  assert.ok(verifyEd25519(identity.publicKey, Buffer.from(boxText(hello.box)), fromB64url(hello.boxSig)));
  assert.equal(hello.pub, b64url(identity.publicKey));

  sockets[0].terminate(); // closed before ready
  assert.equal(client.state().status, 'error');
  assert.deepEqual(timers.delays().filter((ms) => ms !== 90_000), [1_000], 'first pause about 1 s');
  timers.fire(1_000);
  assert.equal(sockets.length, 2);
  sockets[1].terminate();
  assert.ok(timers.delays().includes(2_000), 'then about 2 s');
  client.configure(undefined);
  assert.equal(client.state().status, 'off');
  assert.deepEqual(timers.delays(), [], 'no reconnect, no watchdog once off');
});

test('presence counts only with a box key the pinned device signed; watchdog and resume probe end a dead connection', () => {
  const { client, sockets, timers, presence } = setup();
  const peerKeys = generateEd25519();
  const peerPub = b64url(rawPublic(peerKeys.publicKey));
  const fp = 'f'.repeat(64);
  client.setPeers([{ fp, pub: peerPub }], true);
  client.configure('ws://127.0.0.1:9');
  const ws = sockets[0];
  ws.frame({ t: 'challenge', v: 1, n: 'n' });
  assert.equal(ws.sent[0].findable, true);
  assert.deepEqual(ws.sent[0].peers, [fp]);
  const box = newBox().pub;
  const forged = b64url(signEd25519(generateEd25519().privateKey, Buffer.from(boxText(box))));
  ws.frame({ t: 'ready', fp: 'me', online: [{ fp, box, boxSig: forged }] });
  assert.equal(client.state().status, 'connected');
  assert.equal(client.online(fp), false, 'a box not signed by the pinned key is ignored');
  ws.frame({ t: 'presence', fp, online: true, box, boxSig: b64url(signEd25519(peerKeys.privateKey, Buffer.from(boxText(box)))) });
  assert.equal(client.online(fp), true);
  ws.frame({ t: 'presence', fp: 'a'.repeat(64), online: true, box, boxSig: forged });
  assert.deepEqual(presence, ['ffff:true'], 'presence of unpinned PCs is ignored');

  client.setPeers([], true); // revoked here
  assert.equal(client.online(fp), false);
  assert.deepEqual(ws.sent.at(-1), { t: 'update', peers: [], findable: true });
  assert.deepEqual(presence, ['ffff:true', 'ffff:false']);

  client.nudge(); // host resume
  assert.equal(ws.pings, 1);
  ws.emit('pong');
  assert.equal(ws.terminated, false, 'an answered probe keeps the connection');
  client.nudge();
  timers.fire(5_000);
  assert.equal(ws.terminated, true, 'no pong within 5 s ends it');
  assert.equal(client.state().status, 'error');
  timers.fire(1_000);
  const next = sockets[1];
  next.frame({ t: 'challenge', v: 1, n: 'n2' });
  next.frame({ t: 'ready', fp: 'me', online: [] });
  timers.fire(90_000);
  assert.equal(next.terminated, true, 'a connection silent for 90 s is ended (the relay pings every 30 s)');
  client.stop();
});
