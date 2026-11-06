// The iPhone web app's one connection to Autark's meeting server (B-078 follow-up; services/remote-relay protocol v1), as
// Android's relay/RelayLink.java and the PC's rendezvous/relay-client.ts: registration with the phone's own device key
// (challenge → hello, never findable), the PCs it pins, their presence (only with a box key the PC's device key signed),
// finding a PC by Remote ID, sealed pairing requests (PAIR_INFO) and tunnels it opens (TUNNEL_INFO, the ephemeral key
// signed with the phone's key). A browser cannot see WebSocket pings, so a resume asks one `find` as a probe instead of a
// watchdog; more than 16 MiB waiting in the socket's send buffer ends the tunnel that filled it (MAX_SEND_BUFFER).
// Owns: this connection's frames and requests. Never: accepts tunnels, answers pairing requests, or trusts a box key its
// PC's device key did not sign.

import { b64url, fromB64url, fromUtf8, readU32, utf8, type Bytes } from './bytes.ts';
import { CounterCipher, fingerprint, hkdf, newX25519, remoteIdOf, Serial, sign, toBox, verify, x25519, type DeviceKey } from './crypto.ts';
import { Tunnel } from './tunnel.ts';

export const PAIR_INFO = 'wf-relay-pair-v1';
export const TUNNEL_INFO = 'wf-relay-tunnel-v1';
const MAX_SEND_BUFFER = 16 * 1024 * 1024;

/** The few WebSocket members used here (the browser's, or Node's global one in tests). */
export interface WsLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Bytes): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export const browserSocket: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export interface RelayEvents {
  /** A pinned PC came online (with a signed box key) or left. */
  presence(fp: string, online: boolean): void;
  /** The connection ended. */
  down(reason: string): void;
}

/** A PC found under a Remote ID: its key matches the ID, its box key is signed by that key. */
export interface Found { fp: string; pub: Bytes; box: string }

type Frame = Record<string, unknown>;

export async function boxSigned(pub: Uint8Array, box: unknown, boxSig: unknown): Promise<boolean> {
  if (typeof box !== 'string' || typeof boxSig !== 'string' || box.length > 64 || boxSig.length > 128) return false;
  try {
    return fromB64url(box).length === 32 && (await verify(pub, utf8(`wf-relay-v1|box|${box}`), fromB64url(boxSig)));
  } catch {
    return false;
  }
}

export class RelayLink {
  private readonly key: DeviceKey;
  /** fingerprint → raw Ed25519 key of each pinned PC, in the order the app keeps them. */
  private pins: Map<string, Bytes>;
  private readonly events: RelayEvents;
  private readonly factory: WsFactory;
  private socket: WsLike | undefined;
  private box: { privateKey: CryptoKey; pub: string } | undefined;
  private readonly boxes = new Map<string, string>();
  private readonly pending = new Map<number, (frame: Frame | undefined) => void>();
  private readonly tunnels = new Map<number, Tunnel>();
  private readonly inbound = new Serial();
  private nextRef = 1;
  private ready = false;
  private down = false;

  constructor(options: { key: DeviceKey; pins: Map<string, Bytes>; events: RelayEvents; socket?: WsFactory }) {
    this.key = options.key;
    this.pins = new Map(options.pins);
    this.events = options.events;
    this.factory = options.socket ?? browserSocket;
  }

  /** Connects and registers; resolves once the meeting server said ready (presence of pinned PCs checked). */
  async connect(url: string, timeoutMs = 15_000): Promise<void> {
    const eph = await newX25519();
    this.box = { privateKey: eph.privateKey, pub: b64url(eph.pub) };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('The meeting server did not register this phone.')); }, timeoutMs);
      const settle = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      let ws: WsLike;
      try { ws = this.factory(url); } catch (error) { settle(error as Error); return; }
      this.socket = ws;
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') { const text = event.data; void this.inbound.run(() => this.text(text, settle)); }
        else if (event.data instanceof ArrayBuffer) this.binary(new Uint8Array(event.data));
      };
      ws.onclose = (event) => { settle(new Error('The meeting server is not reachable.')); this.closed(`closed ${event.code ?? ''}`.trim()); };
      ws.onerror = () => undefined; // onclose follows
    });
  }

  isUp(): boolean { return this.ready && !this.down; }

  /** The first pinned PC online, in the app's order. */
  firstOnline(): string | undefined {
    for (const fp of this.pins.keys()) if (this.boxes.has(fp)) return fp;
    return undefined;
  }

  /** New pins (phone.pcs grew the list): the meeting server learns them without a new connection. */
  setPins(pins: Map<string, Bytes>): void {
    this.pins = new Map(pins);
    for (const fp of [...this.boxes.keys()]) if (!this.pins.has(fp)) this.boxes.delete(fp);
    this.sendJson({ t: 'update', peers: [...this.pins.keys()] });
  }

  close(): void {
    const ws = this.socket;
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* closing */ } }
    this.closed('closed');
  }

  // ---------------------------------------------------------------- requests

  /** The PCs that accept connect requests under this Remote ID (key checked against the ID, box signed by that key). */
  async find(remoteId: string, timeoutMs = 10_000): Promise<Found[]> {
    const reply = await this.ask({ t: 'find', id: remoteId }, timeoutMs);
    const out: Found[] = [];
    for (const entry of Array.isArray(reply.entries) ? reply.entries.slice(0, 4) : []) {
      const row = entry as Frame;
      if (typeof row?.pub !== 'string') continue;
      let pub: Bytes;
      try { pub = fromB64url(row.pub); } catch { continue; }
      if (pub.length !== 32 || !(await boxSigned(pub, row.box, row.boxSig))) continue;
      const fp = await fingerprint(pub);
      if ((await remoteIdOf(fp)) === remoteId) out.push({ fp, pub, box: row.box as string });
    }
    return out;
  }

  /** True when the meeting server still answers within `timeoutMs` (a resume probe). */
  async probe(timeoutMs = 3_000): Promise<boolean> {
    if (!this.isUp()) return false;
    try { await this.ask({ t: 'find', id: '000000000' }, timeoutMs); return true; } catch (error) {
      return /refused/.test(String((error as Error)?.message)); // an error frame is still an answer
    }
  }

  /** One sealed message to a PC found by Remote ID, and its opened reply. */
  async request(pc: Found, body: unknown, timeoutMs: number): Promise<Frame> {
    const sealed = await toBox(fromB64url(pc.box), PAIR_INFO);
    const c = b64url(await sealed.cipher.seal(utf8(JSON.stringify(body))));
    const reply = await this.ask({ t: 'pair', to: pc.fp, e: sealed.e, c }, timeoutMs);
    if (typeof reply.error === 'string') throw new Error(`The meeting server could not deliver the request (${reply.error}).`);
    let plain: Bytes | undefined;
    try { plain = typeof reply.c === 'string' && reply.c.length <= 22_000 ? await sealed.cipher.open(fromB64url(reply.c)) : undefined; } catch { plain = undefined; }
    if (!plain) throw new Error('The reply could not be opened.');
    return JSON.parse(fromUtf8(plain)) as Frame;
  }

  /** A tunnel to the pinned PC `fp`; the ephemeral key is signed with this phone's key. */
  async open(fp: string): Promise<Tunnel> {
    const box = this.boxes.get(fp);
    if (!box) throw new Error('Your PC is not online at the meeting server.');
    const boxRaw = fromB64url(box);
    const eph = await newX25519();
    const okm = await hkdf(await x25519(eph.privateKey, boxRaw), new Uint8Array([...eph.pub, ...boxRaw]), TUNNEL_INFO, 64);
    const e = b64url(eph.pub);
    const es = b64url(await sign(this.key.privateKey, utf8(`wf-relay-v1|tunnel|${e}|${box}`)));
    const reply = await this.ask({ t: 'open', to: fp, e, es }, 10_000);
    const tid = reply.tid;
    if (reply.t !== 'opened' || typeof tid !== 'number' || !Number.isInteger(tid) || tid < 0) throw new Error('The meeting server did not open a tunnel.');
    const tunnel = new Tunnel(tid, fp, {
      send: (frame) => {
        const ws = this.socket;
        if (!ws || this.down) return;
        try { ws.send(frame); } catch { ws.close(); return; }
        if (ws.bufferedAmount > MAX_SEND_BUFFER) this.tunnels.get(tid)?.close();
      },
      close: (id) => { this.tunnels.delete(id); this.sendJson({ t: 'close', tid: id }); },
    }, new CounterCipher(okm.slice(0, 32), okm.slice(32, 64)));
    this.tunnels.set(tid, tunnel);
    return tunnel;
  }

  private ask(frame: Frame, timeoutMs: number): Promise<Frame> {
    if (!this.isUp()) return Promise.reject(new Error('The meeting server is not connected.'));
    const ref = this.nextRef++;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error('The meeting server did not answer in time.')); }, timeoutMs);
      this.pending.set(ref, (reply) => {
        clearTimeout(timer);
        this.pending.delete(ref);
        if (!reply) reject(new Error('The meeting server connection ended.'));
        else if (reply.t === 'error') reject(new Error(`The meeting server refused this (${String(reply.code)}).`));
        else resolve(reply);
      });
      this.sendJson({ ...frame, ref });
    });
  }

  private sendJson(frame: Frame): void {
    const ws = this.socket;
    if (!ws || this.down) return;
    try { ws.send(JSON.stringify(frame)); } catch { ws.close(); }
  }

  // ---------------------------------------------------------------- frames from the server

  private async text(text: string, settle: (error?: Error) => void): Promise<void> {
    let frame: Frame;
    try { frame = JSON.parse(text) as Frame; } catch { return; }
    switch (frame?.t) {
      case 'challenge': {
        const n = frame.n;
        if (typeof n !== 'string' || n.length > 64 || !this.box) { this.close(); return; }
        const box = this.box.pub;
        const [sig, boxSig] = await Promise.all([sign(this.key.privateKey, utf8(`wf-relay-v1|hello|${n}`)), sign(this.key.privateKey, utf8(`wf-relay-v1|box|${box}`))]);
        this.sendJson({ t: 'hello', v: 1, pub: b64url(this.key.pub), sig: b64url(sig), box, boxSig: b64url(boxSig), peers: [...this.pins.keys()], findable: false });
        return;
      }
      case 'ready':
        for (const entry of Array.isArray(frame.online) ? frame.online : []) await this.seen(entry as Frame, false);
        this.ready = true;
        settle();
        return;
      case 'presence':
        if (frame.online === true) await this.seen(frame, true);
        else if (typeof frame.fp === 'string' && this.boxes.delete(frame.fp)) this.events.presence(frame.fp, false);
        return;
      case 'closed': {
        const tunnel = typeof frame.tid === 'number' ? this.tunnels.get(frame.tid) : undefined;
        if (tunnel) { this.tunnels.delete(tunnel.tid); tunnel.ended(); }
        return;
      }
      case 'incoming': this.sendJson({ t: 'close', tid: frame.tid }); return; // a phone accepts no tunnels
      case 'pair': this.sendJson({ t: 'pairReply', ref: frame.ref, error: 'failed' }); return; // nobody pairs with a phone
      default: {
        const waiter = typeof frame?.ref === 'number' ? this.pending.get(frame.ref) : undefined;
        waiter?.(frame);
      }
    }
  }

  private async seen(entry: Frame, tell: boolean): Promise<void> {
    const fp = typeof entry?.fp === 'string' ? entry.fp : undefined;
    const pub = fp ? this.pins.get(fp) : undefined;
    if (!fp || !pub || !(await boxSigned(pub, entry.box, entry.boxSig))) return;
    const was = this.boxes.has(fp);
    this.boxes.set(fp, entry.box as string);
    if (!was && tell) this.events.presence(fp, true);
  }

  private binary(data: Uint8Array): void {
    if (data.length < 5) return;
    this.tunnels.get(readU32(data, 0))?.receive(data);
  }

  private closed(reason: string): void {
    if (this.down) return;
    this.down = true;
    this.boxes.clear();
    for (const waiter of [...this.pending.values()]) waiter(undefined);
    for (const tunnel of [...this.tunnels.values()]) tunnel.ended();
    this.tunnels.clear();
    this.events.down(reason);
  }
}
