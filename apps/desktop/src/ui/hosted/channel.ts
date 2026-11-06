// The iPhone web app's peer channel to its PC (B-078 follow-up): the dialing side of Autark's handshake
// (runtime/devices/handshake.ts – ephemeral X25519, both device keys sign the transcript, HKDF into one AES-256-GCM key
// per direction) and the encrypted JSON channel after it (devices/channel.ts: [u64 counter][ciphertext‖tag], counters
// strictly increasing), over one meeting-server tunnel – as Android's relay/PeerChannel.java does it. Sends and opens run
// through ordered queues (WebCrypto is asynchronous); a message that arrives before anyone listens waits for the first
// listener. Owns: the handshake and the framing. Never: accepts a PC key other than the paired one, or a text frame after
// the handshake.

import { b64url, concat, fromB64url, fromUtf8, random, readU64, same, u64, utf8, type Bytes } from './bytes.ts';
import { aesKey, hkdf, newX25519, open, seal, Serial, sha256, sign, verify, x25519, type DeviceKey } from './crypto.ts';
import { textOf, type Tunnel } from './tunnel.ts';

const MAX_FRAME = 8 * 1024 * 1024;
const BACKLOG = 256;

export class SecureChannel {
  closed = false;
  private readonly tunnel: Tunnel;
  private readonly send_: Promise<CryptoKey>;
  private readonly receive_: Promise<CryptoKey>;
  private sendCounter = 0n;
  private receiveCounter = -1n;
  private readonly sending = new Serial();
  private readonly receiving = new Serial();
  private readonly listeners: Array<(message: unknown) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private backlog: unknown[] = [];

  constructor(tunnel: Tunnel, sendKey: Bytes, receiveKey: Bytes) {
    this.tunnel = tunnel;
    this.send_ = aesKey(sendKey);
    this.receive_ = aesKey(receiveKey);
    tunnel.onClose(() => this.markClosed());
  }

  send(message: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    const counter = this.sendCounter++;
    const plain = utf8(JSON.stringify(message));
    return this.sending.run(async () => {
      if (this.closed) return;
      const body = await seal(await this.send_, counter, plain);
      void this.tunnel.sendBinary(concat(u64(counter), body));
    });
  }

  /** A frame of the tunnel after the handshake. */
  receive(data: Bytes, isText: boolean): void {
    if (this.closed) return;
    if (isText || data.length < 24 || data.length > MAX_FRAME) { this.close(); return; }
    void this.receiving.run(async () => {
      if (this.closed) return;
      const counter = readU64(data, 0);
      if (counter <= this.receiveCounter) { this.close(); return; } // replay or reorder
      const plain = await open(await this.receive_, counter, data.slice(8));
      if (!plain) { this.close(); return; }
      this.receiveCounter = counter;
      let message: unknown;
      try { message = JSON.parse(fromUtf8(plain)); } catch { return; }
      if (!this.listeners.length) {
        if (this.backlog.length >= BACKLOG) { this.close(); return; }
        this.backlog.push(message);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  onMessage(listener: (message: unknown) => void): void {
    this.listeners.push(listener);
    for (const message of this.backlog.splice(0)) listener(message);
  }

  onClose(listener: () => void): void { this.closeListeners.push(listener); }

  close(): void {
    this.tunnel.close();
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.backlog = [];
    for (const listener of this.closeListeners) listener();
  }
}

function key32(value: unknown): Bytes | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  try {
    const raw = fromB64url(value);
    return raw.length === 32 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the handshake as the dialing side over `tunnel`; the PC must prove the key `pcPub`. */
export async function connectChannel(tunnel: Tunnel, self: { key: DeviceKey; deviceId: string }, pcPub: Uint8Array, timeoutMs = 15_000): Promise<SecureChannel> {
  let channel: SecureChannel | undefined;
  let answer: ((text: string | undefined) => void) | undefined;
  const reply = new Promise<string | undefined>((resolve) => { answer = resolve; });
  tunnel.onMessage((data, isText) => {
    if (channel) { channel.receive(data, isText); return; }
    if (!isText || data.length > 4096) { tunnel.close(); answer?.(undefined); return; }
    answer?.(textOf(data));
  });
  tunnel.onClose(() => answer?.(undefined));
  if (tunnel.closed) throw new Error('The tunnel closed.');
  const eph = await newX25519();
  const n = random(16);
  void tunnel.sendText(JSON.stringify({ t: 'hello', v: 1, id: self.deviceId, pub: b64url(self.key.pub), eph: b64url(eph.pub), n: b64url(n) }));
  const timer = setTimeout(() => answer?.(undefined), timeoutMs);
  const text = await reply;
  clearTimeout(timer);
  const fail = (message: string): never => { tunnel.close(); throw new Error(message); };
  if (text === undefined) return fail('Your PC did not answer the handshake.');
  let welcome: Record<string, unknown>;
  try { welcome = JSON.parse(text) as Record<string, unknown>; } catch { return fail('Bad handshake answer.'); }
  const pubS = key32(welcome.pub);
  const ephS = key32(welcome.eph);
  if (welcome.t !== 'welcome' || !pubS || !ephS || typeof welcome.sig !== 'string' || !same(pubS, pcPub)) return fail('This is not the paired PC.');
  const hash = await sha256(concat(utf8('wf-peer-v1'), self.key.pub, eph.pub, n, pubS, ephS));
  let sig: Bytes;
  try { sig = fromB64url(welcome.sig); } catch { return fail('The PC\'s signature is not valid.'); }
  if (!(await verify(pubS, concat(utf8('server'), hash), sig))) return fail('The PC\'s signature is not valid.');
  const okm = await hkdf(await x25519(eph.privateKey, ephS), hash, 'wf-peer-v1 keys', 64);
  const auth = b64url(await sign(self.key.privateKey, concat(utf8('client'), hash)));
  channel = new SecureChannel(tunnel, okm.slice(0, 32), okm.slice(32, 64));
  void tunnel.sendText(JSON.stringify({ t: 'auth', sig: auth })); // queued before any channel frame
  return channel;
}
