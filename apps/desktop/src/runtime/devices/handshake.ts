// Peer handshake for linked runtimes: ephemeral X25519 key agreement, authenticated by the
// long-term Ed25519 device keys (both sides sign the transcript), then HKDF into one AES-256
// key per direction. Gives mutual authentication and forward secrecy over any WebSocket
// (LAN, cable, Tailscale – defence in depth on top of WireGuard).
// Owns: message shapes, transcript and key derivation. Never: sockets or trust decisions.
//
//   C → S  hello   { v, id, pub, eph, n }
//   S → C  welcome { id, pub, eph, sig = Ed25519_S("server" ‖ H) }
//   C → S  auth    { sig = Ed25519_C("client" ‖ H) }
//   H = SHA256("wf-peer-v1" ‖ pubC ‖ ephC ‖ n ‖ pubS ‖ ephS)
//   c2s ‖ s2c = HKDF-SHA256(X25519(eph, eph'), salt = H, info = "wf-peer-v1 keys", 64)

import { hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { b64url, fromB64url, generateX25519, rawPublic, sha256, verifyEd25519, x25519Shared } from './keys.ts';

export const PEER_PROTOCOL = 1;

export interface HelloMessage { t: 'hello'; v: number; id: string; pub: string; eph: string; n: string }
export interface WelcomeMessage { t: 'welcome'; id: string; pub: string; eph: string; sig: string }
export interface AuthMessage { t: 'auth'; sig: string }

export interface SessionKeys {
  send: Buffer; // 32-byte AES key for my outgoing frames
  receive: Buffer;
}

export interface Signer {
  deviceId: string;
  publicKey: Buffer;
  sign(data: Uint8Array): Buffer;
}

function transcript(pubC: Buffer, ephC: Buffer, nonce: Buffer, pubS: Buffer, ephS: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from('wf-peer-v1'), pubC, ephC, nonce, pubS, ephS]));
}

function derive(shared: Buffer, hash: Buffer): { c2s: Buffer; s2c: Buffer } {
  const okm = Buffer.from(hkdfSync('sha256', shared, hash, Buffer.from('wf-peer-v1 keys'), 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

function bytes32(value: unknown, field: string): Buffer {
  if (typeof value !== 'string') throw new Error(`Handshake: missing ${field}`);
  const out = fromB64url(value);
  if (out.length !== 32) throw new Error(`Handshake: invalid ${field}`);
  return out;
}

/** Client side, step 1. */
export function clientHello(self: Signer): { message: HelloMessage; state: { eph: KeyObject; ephPub: Buffer; nonce: Buffer } } {
  const pair = generateX25519();
  const ephPub = rawPublic(pair.publicKey);
  const nonce = randomBytes(16);
  return {
    message: { t: 'hello', v: PEER_PROTOCOL, id: self.deviceId, pub: b64url(self.publicKey), eph: b64url(ephPub), n: b64url(nonce) },
    state: { eph: pair.privateKey, ephPub, nonce },
  };
}

/** Server side: answers a hello. `peerPub` is returned so the caller can check trust. */
export function serverWelcome(self: Signer, hello: HelloMessage): {
  message: WelcomeMessage;
  peerPub: Buffer;
  peerId: string;
  verifyAuth(auth: AuthMessage): SessionKeys | undefined;
} {
  if (hello?.t !== 'hello' || hello.v !== PEER_PROTOCOL || typeof hello.id !== 'string') throw new Error('Handshake: bad hello');
  const pubC = bytes32(hello.pub, 'pub');
  const ephC = bytes32(hello.eph, 'eph');
  const nonce = fromB64url(String(hello.n ?? ''));
  if (nonce.length !== 16) throw new Error('Handshake: bad nonce');
  const pair = generateX25519();
  const ephS = rawPublic(pair.publicKey);
  const hash = transcript(pubC, ephC, nonce, self.publicKey, ephS);
  const sig = self.sign(Buffer.concat([Buffer.from('server'), hash]));
  const keys = derive(x25519Shared(pair.privateKey, ephC), hash);
  return {
    message: { t: 'welcome', id: self.deviceId, pub: b64url(self.publicKey), eph: b64url(ephS), sig: b64url(sig) },
    peerPub: pubC,
    peerId: hello.id,
    verifyAuth(auth) {
      if (auth?.t !== 'auth' || typeof auth.sig !== 'string') return undefined;
      const ok = verifyEd25519(pubC, Buffer.concat([Buffer.from('client'), hash]), fromB64url(auth.sig));
      return ok ? { send: keys.s2c, receive: keys.c2s } : undefined;
    },
  };
}

/** Client side, step 2: verifies the server and produces the auth message + keys. */
export function clientFinish(
  self: Signer,
  state: { eph: KeyObject; ephPub: Buffer; nonce: Buffer },
  welcome: WelcomeMessage,
): { message: AuthMessage; keys: SessionKeys; peerPub: Buffer; peerId: string } {
  if (welcome?.t !== 'welcome' || typeof welcome.id !== 'string') throw new Error('Handshake: bad welcome');
  const pubS = bytes32(welcome.pub, 'pub');
  const ephS = bytes32(welcome.eph, 'eph');
  const hash = transcript(self.publicKey, state.ephPub, state.nonce, pubS, ephS);
  if (!verifyEd25519(pubS, Buffer.concat([Buffer.from('server'), hash]), fromB64url(String(welcome.sig ?? '')))) {
    throw new Error('Handshake: server signature invalid');
  }
  const keys = derive(x25519Shared(state.eph, ephS), hash);
  const sig = self.sign(Buffer.concat([Buffer.from('client'), hash]));
  return { message: { t: 'auth', sig: b64url(sig) }, keys: { send: keys.c2s, receive: keys.s2c }, peerPub: pubS, peerId: welcome.id };
}
