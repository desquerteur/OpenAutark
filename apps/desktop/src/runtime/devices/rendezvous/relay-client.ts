// The one outbound WebSocket to the self-hosted meeting server (services/remote-relay, protocol v1)
// while settings.devices.relay has an address. Registers this PC's key (signed challenge), a
// per-session box key (rendezvous/seal.ts), its peer listener port (the server adds the address it
// sees this PC on) and the fingerprints of its linked PCs; learns which of them are online there and
// the addresses the server saw them on (only PCs that pinned this one too); opens and accepts tunnels
// (rendezvous/tunnel.ts – the last fallback) and passes sealed connect requests for PCs found by
// Remote ID. Reconnects with backoff after a failure (1 s … 5 min, one-shot timers); a host resume
// probes the connection once (nudge). The server pings every 30 s; no ping or message for 90 s ends
// the connection (one watchdog timer, re-armed by traffic – no polling).
// A malicious server can drop traffic or hand out wrong addresses (the pinned-key handshake refuses
// them) but not make this PC hold much: incoming tunnels need the opener's signed ephemeral key and
// are capped (2 per PC, 32 in all); a send buffer the server does not drain ends the tunnel.
// Owns: the server connection, its requests and tunnels. Never: trusts a box key that its pinned
// or registered device key did not sign, accepts a tunnel from an unpinned PC, or logs keys.

import WebSocket from 'ws';
import type { Logger } from '../../contracts.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { remoteIdOf } from '../../remote/id.ts';
import { b64url, fingerprintOf, fromB64url, verifyEd25519 } from '../keys.ts';
import type { Timers } from '../mesh.ts';
import { PAIR_INFO, TUNNEL_INFO, boxSigned, boxText, fromSender, helloText, newBox, openJson, sealJson, toBox, tunnelText, type Box } from './seal.ts';
import { RelayTunnel } from './tunnel.ts';

export interface RelayPeer { fp: string; pub: string }
export interface RelayEntry { fp: string; pub: string; box: string }
export type RelayStatus = 'off' | 'connecting' | 'connected' | 'error';

export interface RelayEvents {
  changed(): void;
  presence(fp: string, online: boolean): void;
  incoming(tunnel: RelayTunnel): void;
  /**
   * A sealed pairing message from the key `from` (already opened); the reply is sealed back.
   * `source`: the relay's opaque tag of the sender's network source (one per address, unlike keys).
   */
  pair(from: string, body: unknown, source: string | undefined): Promise<unknown>;
}

export interface RelayClientDeps {
  identity: { publicKey: Buffer; sign(data: Uint8Array): Buffer };
  log: Logger;
  events: RelayEvents;
  timers?: Timers;
  random?: () => number;
  socket?: (url: string) => WebSocket;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const WATCHDOG_MS = 90_000;
const PROBE_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;
const MAX_INCOMING_PER_PEER = 2;
const MAX_INCOMING = 32;
/** A relay that does not take tunnel data this fast loses the tunnel (memory stays bounded). */
const MAX_SEND_BUFFER = 16 * 1024 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const DIRECT = /^https?:\/\/[^/?#@\s]{1,120}$/;

/** At most 4 http(s) addresses from a presence entry. */
function addressesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && DIRECT.test(item)).slice(0, 4) : [];
}
const SOURCE_TAG = /^[0-9a-f]{16}$/;

const realTimers: Timers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const openSocket = (url: string) => new WebSocket(url, { maxPayload: 70 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false });
const unavailable = (message: string) => new WorkforceError('unavailable', message);

interface Pending { expect: string; resolve(frame: Record<string, unknown>): void; reject(error: Error): void; handle: unknown }

export class RelayClient {
  private readonly deps: RelayClientDeps;
  private readonly timers: Timers;
  private readonly box: Box = newBox();
  private url?: string;
  private ws?: WebSocket;
  private ready = false;
  private status: RelayStatus = 'off';
  private error?: string;
  private attempt = 0;
  private retry?: unknown;
  private watchdog?: unknown;
  private probe?: unknown;
  private peers = new Map<string, string>();
  private findable = false;
  private port?: number;
  /** Pinned PCs online at the server: their box key and the addresses the server saw them on. */
  private present = new Map<string, { box: string; addrs: string[] }>();
  private pending = new Map<number, Pending>();
  private tunnels = new Map<number, RelayTunnel>();
  private inbound = new Set<RelayTunnel>();
  /** Ephemeral keys of tunnels already accepted in this session (a replay is refused). */
  private usedKeys = new Set<string>();
  /** Pins and findable as last sent to the relay (a change before 'ready' is sent after it). */
  private announced = '';
  private nextRef = 1;
  private stopped = false;

  constructor(deps: RelayClientDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  state(): { status: RelayStatus; url?: string; error?: string; online: string[]; tunnels: string[] } {
    return { status: this.status, ...(this.url ? { url: this.url } : {}), ...(this.error ? { error: this.error } : {}), online: [...this.present.keys()], tunnels: [...new Set([...this.tunnels.values()].map((tunnel) => tunnel.peer))] };
  }

  /** Relay address from settings (undefined/empty = off). A change reconnects at once. */
  configure(url: string | undefined): void {
    const next = url || undefined;
    if (next === this.url || this.stopped) return;
    this.url = next;
    this.disconnect();
    this.attempt = 0;
    this.error = undefined;
    this.setStatus(next ? 'connecting' : 'off');
    if (next) this.connect();
  }

  /** The linked PCs this PC pins (fingerprint + device key), whether it accepts requests here, and its peer port. */
  setPeers(peers: RelayPeer[], findable: boolean, port?: number): void {
    const next = new Map(peers.map((peer) => [peer.fp, peer.pub]));
    const same = findable === this.findable && port === this.port && next.size === this.peers.size && [...next].every(([fp, pub]) => this.peers.get(fp) === pub);
    if (same) return; // device events fire often; the server hears only real changes
    this.peers = next;
    this.findable = findable;
    this.port = port;
    for (const fp of [...this.present.keys()]) if (!this.peers.has(fp)) this.gone(fp);
    for (const tunnel of [...this.tunnels.values()]) if (!this.peers.has(tunnel.peer)) tunnel.close();
    if (this.ready) this.announce();
  }

  online(fp: string): boolean { return this.ready && this.present.has(fp); }

  /** The addresses the server saw a pinned, online PC on (tried directly before any tunnel). */
  addresses(fp: string): string[] { return this.ready ? [...(this.present.get(fp)?.addrs ?? [])] : []; }

  /** Host resume/unlock: probe a connection that may have died while asleep, or reconnect now. */
  nudge(): void {
    if (!this.url || this.stopped) return;
    if (this.ws && this.ready) {
      if (this.probe !== undefined) return;
      this.probe = this.timers.set(() => { this.probe = undefined; this.ws?.terminate(); }, PROBE_MS);
      try { this.ws.ping(); } catch { /* closing */ }
      return;
    }
    if (!this.ws) { this.cancelRetry(); this.connect(); }
  }

  /** A tunnel to a pinned PC online here; its text frames are sealed to that PC's box key. */
  async open(fp: string): Promise<RelayTunnel> {
    const box = this.present.get(fp)?.box;
    if (!this.ready || !box) throw unavailable('The other PC is not online at the meeting server.');
    const { e, cipher } = toBox(box, TUNNEL_INFO);
    const es = b64url(this.deps.identity.sign(Buffer.from(tunnelText(e, box), 'utf8')));
    const reply = await this.ask({ t: 'open', to: fp, e, es }, 'opened', OPEN_TIMEOUT_MS);
    const tid = reply.tid;
    if (!Number.isInteger(tid)) throw unavailable('The meeting server did not open a tunnel.');
    return this.track(new RelayTunnel(tid as number, fp, this.link(tid as number), cipher));
  }

  /** Devices accepting requests under this Remote ID (box key signed by the registered key). */
  async find(remoteId: string, signal?: AbortSignal): Promise<RelayEntry[]> {
    const reply = await this.ask({ t: 'find', id: remoteId }, 'found', OPEN_TIMEOUT_MS, signal);
    const entries = Array.isArray(reply.entries) ? reply.entries.slice(0, 4) as Array<Record<string, unknown>> : [];
    const out: RelayEntry[] = [];
    for (const entry of entries) {
      if (typeof entry.pub !== 'string' || !boxSigned(entry.pub, entry.box, entry.boxSig)) continue;
      const fp = fingerprintOf(fromB64url(entry.pub));
      if (remoteIdOf(fp) === remoteId) out.push({ fp, pub: entry.pub, box: entry.box as string });
    }
    return out;
  }

  /** One sealed pairing request to `fp` (box from find) and its opened reply. */
  async request(fp: string, box: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (!this.ready) throw new Error('The meeting server is not connected.');
    const { e, cipher } = toBox(box, PAIR_INFO);
    const reply = await this.ask({ t: 'pair', to: fp, e, c: sealJson(cipher, body) }, 'pairReply', options.timeoutMs, options.signal);
    if (typeof reply.error === 'string') throw new Error(`The meeting server could not deliver the request (${reply.error}).`);
    const value = openJson(cipher, reply.c);
    if (value === undefined) throw new Error('The reply could not be opened.');
    return value;
  }

  stop(): void {
    this.stopped = true;
    this.url = undefined;
    this.disconnect();
    this.setStatus('off');
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    const url = this.url;
    if (!url || this.ws || this.stopped) return;
    let ws: WebSocket;
    try { ws = (this.deps.socket ?? openSocket)(url); } catch (error) { this.failed(socketError(error)); return; }
    this.ws = ws;
    this.armWatchdog();
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.ws !== ws) return;
      this.armWatchdog();
      if (isBinary) { this.tunnels.get(data.length >= 4 ? data.readUInt32BE(0) : -1)?.receive(data); return; }
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>; } catch { return; }
      if (frame && typeof frame === 'object') this.control(ws, frame);
    });
    ws.on('ping', () => { if (this.ws === ws) this.armWatchdog(); });
    ws.on('pong', () => { if (this.probe !== undefined) { this.timers.clear(this.probe); this.probe = undefined; } });
    ws.on('close', (code: number) => { if (this.ws === ws) this.closed(code); });
    ws.on('error', (error: Error) => { if (this.ws === ws && !this.ready) this.error = socketError(error); });
  }

  private control(ws: WebSocket, frame: Record<string, unknown>): void {
    switch (frame.t) {
      case 'challenge': {
        if (typeof frame.n !== 'string' || frame.n.length > 64) { ws.close(); return; }
        const sign = (text: string) => b64url(this.deps.identity.sign(Buffer.from(text, 'utf8')));
        this.announced = this.pins();
        this.sendJson({ t: 'hello', v: 1, pub: b64url(this.deps.identity.publicKey), sig: sign(helloText(frame.n)), box: this.box.pub, boxSig: sign(boxText(this.box.pub)), peers: [...this.peers.keys()], findable: this.findable, ...(this.port ? { port: this.port } : {}) });
        return;
      }
      case 'ready':
        this.ready = true;
        this.attempt = 0;
        this.error = undefined;
        this.announce(); // pinned or revoked while 'hello' was on its way
        this.setStatus('connected');
        for (const entry of Array.isArray(frame.online) ? frame.online as Array<Record<string, unknown>> : []) this.seen(entry);
        return;
      case 'presence':
        if (frame.online === true) this.seen(frame);
        else if (typeof frame.fp === 'string') this.gone(frame.fp);
        return;
      case 'incoming': return this.incoming(frame);
      case 'closed': if (Number.isInteger(frame.tid)) this.tunnels.get(frame.tid as number)?.ended(); return;
      case 'pair': return this.pairIn(frame);
      default: {
        const pending = typeof frame.ref === 'number' ? this.pending.get(frame.ref) : undefined;
        if (!pending || (frame.t !== pending.expect && frame.t !== 'error')) return;
        this.pending.delete(frame.ref as number);
        this.timers.clear(pending.handle);
        if (frame.t === 'error') pending.reject(unavailable(`The meeting server refused this (${String(frame.code).slice(0, 20)}).`));
        else pending.resolve(frame);
      }
    }
  }

  private seen(entry: Record<string, unknown>): void {
    const fp = typeof entry.fp === 'string' ? entry.fp : '';
    const pub = this.peers.get(fp);
    if (!pub || !boxSigned(pub, entry.box, entry.boxSig)) return; // only pinned PCs with a box their own key signed
    const known = this.present.has(fp);
    this.present.set(fp, { box: entry.box as string, addrs: addressesOf(entry.addrs) });
    this.deps.events.changed();
    if (!known) this.deps.events.presence(fp, true);
  }

  private gone(fp: string): void {
    if (!this.present.delete(fp)) return;
    this.deps.events.changed();
    this.deps.events.presence(fp, false);
  }

  /** A tunnel a pinned PC opened: only with its device key's signature over the ephemeral key, within the caps. */
  private incoming(frame: Record<string, unknown>): void {
    const tid = frame.tid;
    if (!Number.isInteger(tid)) return;
    const from = typeof frame.from === 'string' ? frame.from : '';
    const pub = this.peers.get(from);
    const e = typeof frame.e === 'string' && frame.e.length <= 64 ? frame.e : '';
    const signedByPeer = Boolean(pub && e && typeof frame.es === 'string' && frame.es.length <= 128 && !this.usedKeys.has(e)
      && verifyEd25519(fromB64url(pub), Buffer.from(tunnelText(e, this.box.pub), 'utf8'), fromB64url(frame.es)));
    const fromPeer = [...this.inbound].filter((tunnel) => tunnel.peer === from).length;
    const cipher = signedByPeer && fromPeer < MAX_INCOMING_PER_PEER && this.inbound.size < MAX_INCOMING ? fromSender(this.box, e, TUNNEL_INFO) : undefined;
    if (!cipher) { this.sendJson({ t: 'close', tid }); return; }
    if (this.usedKeys.size >= 1_024) this.usedKeys.clear(); // e is fresh per tunnel; this only stops replays
    this.usedKeys.add(e);
    const tunnel = this.track(new RelayTunnel(tid as number, from, this.link(tid as number), cipher));
    this.inbound.add(tunnel);
    tunnel.onClose(() => this.inbound.delete(tunnel));
    this.deps.events.incoming(tunnel);
  }

  private pairIn(frame: Record<string, unknown>): void {
    const ref = frame.ref;
    const cipher = fromSender(this.box, frame.e, PAIR_INFO);
    const body = cipher ? openJson(cipher, frame.c) : undefined;
    if (!cipher || body === undefined || typeof frame.from !== 'string' || !FINGERPRINT.test(frame.from)) { this.sendJson({ t: 'pairReply', ref, error: 'stale' }); return; }
    const source = typeof frame.src === 'string' && SOURCE_TAG.test(frame.src) ? frame.src : undefined;
    this.deps.events.pair(frame.from, body, source).then(
      (reply) => this.sendJson({ t: 'pairReply', ref, c: sealJson(cipher, reply) }),
      () => this.sendJson({ t: 'pairReply', ref, error: 'failed' }),
    );
  }

  private track(tunnel: RelayTunnel): RelayTunnel {
    this.tunnels.set(tunnel.tid, tunnel);
    tunnel.onClose(() => { if (this.tunnels.get(tunnel.tid) === tunnel) { this.tunnels.delete(tunnel.tid); this.deps.events.changed(); } });
    this.deps.events.changed();
    return tunnel;
  }

  private link(tid: number) {
    return {
      send: (frame: Buffer) => {
        const ws = this.ws;
        if (!ws || !this.ready) return;
        // The relay paces this PC (it stops reading); past this, give the tunnel up instead of buffering on.
        if (ws.bufferedAmount > MAX_SEND_BUFFER) { this.tunnels.get(tid)?.close(); return; }
        ws.send(frame);
      },
      close: () => this.sendJson({ t: 'close', tid }),
    };
  }

  private pins(): string { return JSON.stringify([[...this.peers.keys()].sort(), this.findable, this.port ?? 0]); }

  /** Tells the server the current pins, findable and port when they differ from what it has. */
  private announce(): void {
    const now = this.pins();
    if (now === this.announced) return;
    this.announced = now;
    this.sendJson({ t: 'update', peers: [...this.peers.keys()], findable: this.findable, ...(this.port ? { port: this.port } : {}) });
  }

  private ask(frame: Record<string, unknown>, expect: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.ready) return Promise.reject(unavailable('The meeting server is not connected.'));
    if (signal?.aborted) return Promise.reject(new WorkforceError('cancelled', 'Cancelled.'));
    const ref = this.nextRef++;
    return new Promise((resolve, reject) => {
      const finish = () => { this.timers.clear(entry.handle); this.pending.delete(ref); signal?.removeEventListener('abort', abort); };
      const abort = () => { finish(); reject(new WorkforceError('cancelled', 'Cancelled.')); };
      const entry: Pending = {
        expect,
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
        handle: this.timers.set(() => { finish(); reject(new WorkforceError('timeout', 'The meeting server did not answer in time.')); }, timeoutMs),
      };
      this.pending.set(ref, entry);
      signal?.addEventListener('abort', abort, { once: true });
      this.sendJson({ ...frame, ref });
    });
  }

  private sendJson(frame: Record<string, unknown>): void {
    try { this.ws?.send(JSON.stringify(frame)); } catch { /* closing: the close handler cleans up */ }
  }

  private armWatchdog(): void {
    if (this.watchdog !== undefined) this.timers.clear(this.watchdog);
    const ws = this.ws;
    this.watchdog = this.timers.set(() => { this.watchdog = undefined; if (this.ws === ws) ws?.terminate(); }, WATCHDOG_MS);
  }

  /** The socket ended: everything on it ends, and (still configured) a reconnect is scheduled. */
  private closed(code: number): void {
    const wasReady = this.ready;
    this.drop();
    if (code === 4000) this.error = 'The meeting server refused this PC';
    else if (wasReady) this.error = 'Connection to the meeting server lost';
    else this.error ??= 'The meeting server is not reachable';
    if (code === 4009) this.attempt = Math.max(this.attempt, 3); // another start of this PC took over
    this.failed(this.error);
  }

  private failed(error: string): void {
    this.error = error;
    if (!this.url || this.stopped) { this.setStatus('off'); return; }
    this.setStatus('error');
    if (this.retry !== undefined) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const delay = Math.round(base * (0.8 + 0.4 * (this.deps.random ?? Math.random)()));
    this.attempt++;
    this.retry = this.timers.set(() => { this.retry = undefined; this.connect(); }, delay);
  }

  private disconnect(): void {
    this.cancelRetry();
    const ws = this.ws;
    this.drop();
    try { ws?.terminate(); } catch { /* already closed */ }
  }

  /** Forgets the socket and everything on it (pending requests fail, tunnels end, presence clears). */
  private drop(): void {
    this.ws = undefined;
    this.ready = false;
    for (const handle of [this.watchdog, this.probe]) if (handle !== undefined) this.timers.clear(handle);
    this.watchdog = undefined;
    this.probe = undefined;
    for (const pending of [...this.pending.values()]) pending.reject(unavailable('The meeting server connection ended.'));
    for (const tunnel of [...this.tunnels.values()]) tunnel.ended();
    for (const fp of [...this.present.keys()]) this.gone(fp);
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) this.timers.clear(this.retry);
    this.retry = undefined;
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.events.changed();
  }
}

function socketError(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `The meeting server is not reachable (${code})` : 'The meeting server is not reachable';
}
