// Workforce meeting server (self-hostable, in-memory only): Workforce PCs that cannot reach each
// other directly meet here and exchange where they are, then talk directly. A device registers
// under its public key (signed challenge) with the fingerprints of the devices it has pinned and
// its peer listener port; the server builds its public address from the source it sees and the
// port, and shares it – with the box key – only between two devices that pinned each other
// (presence). When no direct path answers, a tunnel forwards opaque binary frames (the devices'
// own end-to-end-encrypted peer channel) as the last fallback. Devices that accept connection
// requests are also found by their Remote ID, and sealed connect messages are passed to them
// (rate-limited per key and per client source); each carries an opaque per-source tag (HMAC of
// the source under a per-process secret, never the address) so the target PC counts requests per
// real source. Nothing here can accept a request – the person on the target PC does.
// It listens on its own port, or (noServer) is mounted on another program's HTTP server, which hands
// it the WebSocket upgrades of its path (e.g. /autark on the TeleCoding relay: one host for both).
// Owns: connections, registration, the pin/presence graph with addresses, tunnel and request
// forwarding, limits and keepalive pings. Never: stores anything on disk, logs keys/addresses/content,
// decrypts, or shares anything between devices that did not both pin each other.

import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { Bucket, DEFAULT_LIMITS, KeyedBuckets, sourceOf, type Limits } from './limits.ts';
import {
  DATA_HEADER, MAX_DATA_PAYLOAD, PROTOCOL, b64url, boxText, fingerprintOf, helloText, isFingerprint, isRef, key32,
  newChallenge, opaque, parseControl, peerList, remoteIdOf, signed, tunnelOf, type Frame,
} from './protocol.ts';

export interface RelayOptions {
  port?: number;
  host?: string;
  limits?: Partial<Limits>;
  /** Behind a reverse proxy (TLS termination): take the client address from X-Forwarded-For. */
  trustProxy?: boolean;
  /**
   * With trustProxy: the header the proxy puts the client address in (default x-forwarded-for, its
   * last entry). Behind Cloudflare (Render) `cf-connecting-ip` – there X-Forwarded-For ends with a
   * Cloudflare address. Without the header the socket address counts.
   */
  ipHeader?: string;
  /** Mounted on another HTTP server instead of listening: that server passes upgrades to `handleUpgrade`. */
  noServer?: boolean;
  log?: (message: string, data?: Record<string, number | string>) => void;
  now?: () => number;
  /** The `ws` server class (default: this package's dependency; tests elsewhere may pass their own copy). */
  WebSocketServer?: typeof WebSocketServer;
}

export interface Relay {
  /** The port it listens on (0 when mounted). */
  port: number;
  stats(): { connections: number; devices: number; tunnels: number; pairs: number };
  /** Mounted (noServer): takes one WebSocket upgrade from the host server. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): Promise<void>;
}

interface Conn {
  ws: WebSocket;
  /** The client source limits count under (limits.ts sourceOf). */
  source: string;
  /** The client address as seen (for the public address it is reached on). */
  ip: string;
  /** Its peer listener port (hello / update), 0 = none. */
  port: number;
  challenge: string;
  fp?: string;
  pub?: string;
  box?: string;
  boxSig?: string;
  peers: Set<string>;
  findable: boolean;
  remoteId?: string;
  tunnels: Set<number>;
  control: Bucket;
  bytes: Bucket;
  /** Out of byte tokens (a one-shot timer resumes it). */
  paused: boolean;
  /** Waits for a lagging receiver (its send-callback resumes it; stallMs closes that tunnel). */
  stalled?: { on: Conn; tid: number; timer: ReturnType<typeof setTimeout> };
  /** Senders that wait for this connection's send buffer to drain. */
  waiters: Set<Conn>;
  alive: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
}

interface Pending { from: Conn; ref: number; to: Conn; timer: ReturnType<typeof setTimeout> }

const ERROR_CODE = /^[a-z_]{1,20}$/;

export async function createRelay(options: RelayOptions = {}): Promise<Relay> {
  const Server = options.WebSocketServer ?? (await import('ws')).WebSocketServer;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const conns = new Set<Conn>();
  const perIp = new Map<string, number>();
  const byFp = new Map<string, Conn>();
  const byRemoteId = new Map<string, Set<Conn>>();
  const tunnels = new Map<number, { a: Conn; b: Conn }>();
  const pairs = new Map<number, Pending>();
  const registrations = new KeyedBuckets(limits.registrationsPerMinute, now);
  const finds = new KeyedBuckets(limits.findsPerMinute, now);
  const pairsOut = new KeyedBuckets(limits.pairsPerMinute, now);
  const pairsIn = new KeyedBuckets(limits.pairsInPerMinute, now);
  const secret = randomBytes(32); // per process: tags cannot be linked across restarts
  const tagOf = (conn: Conn) => createHmac('sha256', secret).update(conn.source).digest('hex').slice(0, 16);
  /** Bucket keys of one connection: its device key and its client source. */
  const keysOf = (conn: Conn) => [`k:${conn.fp}`, `s:${conn.source}`];
  let nextTunnel = 1;
  let nextPair = 1;

  const send = (conn: Conn, frame: Frame) => { try { conn.ws.send(JSON.stringify(frame)); } catch { /* closing */ } };
  const fail = (conn: Conn, code: string, ref?: number) => send(conn, { t: 'error', code, ...(ref !== undefined ? { ref } : {}) });
  const mutual = (a: Conn, b: Conn) => a !== b && Boolean(a.fp && b.fp) && a.peers.has(b.fp!) && b.peers.has(a.fp!);
  const entry = (conn: Conn) => ({ fp: conn.fp, box: conn.box, boxSig: conn.boxSig, ...(conn.port ? { addrs: [addressOf(conn.ip, conn.port)] } : {}) });
  const presence = (to: Conn, about: Conn, online: boolean) => send(to, { t: 'presence', ...(online ? entry(about) : { fp: about.fp }), online });

  function closeTunnel(tid: number, notify: Conn | undefined, code = 'closed'): void {
    const tunnel = tunnels.get(tid);
    if (!tunnel) return;
    tunnels.delete(tid);
    tunnel.a.tunnels.delete(tid);
    tunnel.b.tunnels.delete(tid);
    for (const end of [tunnel.a, tunnel.b]) if (end === notify || notify === undefined) send(end, { t: 'closed', tid, code });
  }

  /** Closes every tunnel between two devices (they no longer pin each other). */
  function cutBetween(a: Conn, b: Conn): void {
    for (const tid of [...a.tunnels]) {
      const tunnel = tunnels.get(tid);
      if (tunnel && (tunnel.a === b || tunnel.b === b)) closeTunnel(tid, undefined, 'forbidden');
    }
  }

  function index(conn: Conn): void {
    if (conn.remoteId) byRemoteId.get(conn.remoteId)?.delete(conn);
    if (conn.remoteId && !byRemoteId.get(conn.remoteId)?.size) byRemoteId.delete(conn.remoteId);
    conn.remoteId = conn.findable && conn.fp ? remoteIdOf(conn.fp) : undefined;
    if (conn.remoteId) {
      const set = byRemoteId.get(conn.remoteId) ?? new Set<Conn>();
      set.add(conn);
      byRemoteId.set(conn.remoteId, set);
    }
  }

  /** New pin list: presence changes (and cut tunnels) for every device whose mutual pin changed. */
  function setPeers(conn: Conn, next: Set<string>): void {
    const before = conn.peers;
    conn.peers = next;
    for (const fp of new Set([...before, ...next])) {
      const other = byFp.get(fp);
      if (!other || other === conn || !other.peers.has(conn.fp!)) continue;
      const was = before.has(fp);
      const is = next.has(fp);
      if (was === is) continue;
      presence(conn, other, is);
      presence(other, conn, is);
      if (!is) cutBetween(conn, other);
    }
  }

  function register(conn: Conn, frame: Frame): void {
    if (!registrations.take(conn.source)) { // a fresh key per connection must not reset the limits
      fail(conn, 'rate_limited');
      conn.ws.close(1013, 'busy');
      return;
    }
    const pub = key32(frame.pub);
    const box = key32(frame.box);
    const peers = peerList(frame.peers ?? []);
    if (frame.v !== PROTOCOL || !pub || !box || !peers || !signed(pub, helloText(conn.challenge), frame.sig) || !opaque(frame.boxSig, 128)) {
      fail(conn, 'bad_request');
      conn.ws.close(4000, 'bad hello');
      return;
    }
    clearTimeout(conn.helloTimer);
    const fp = fingerprintOf(pub);
    const old = byFp.get(fp);
    if (old) { old.ws.close(4009, 'replaced'); drop(old); }
    Object.assign(conn, { fp, pub: b64url(pub), box: b64url(box), boxSig: frame.boxSig as string, findable: frame.findable === true, port: portOf(frame.port), peers: new Set<string>() });
    byFp.set(fp, conn);
    index(conn);
    conn.peers = peers;
    const online = [...peers].map((peer) => byFp.get(peer)).filter((other): other is Conn => Boolean(other && mutual(conn, other)));
    send(conn, { t: 'ready', fp, online: online.map(entry) });
    for (const other of online) presence(other, conn, true);
  }

  function open(conn: Conn, frame: Frame): void {
    const ref = frame.ref;
    if (!isRef(ref)) return fail(conn, 'bad_request');
    const other = isFingerprint(frame.to) ? byFp.get(frame.to) : undefined;
    if (!other || !mutual(conn, other)) return fail(conn, 'unavailable', ref);
    if (conn.tunnels.size >= limits.maxTunnelsPerConnection || other.tunnels.size >= limits.maxTunnelsPerConnection) return fail(conn, 'limit', ref);
    if (frame.e !== undefined && !opaque(frame.e, 64)) return fail(conn, 'bad_request', ref);
    if (frame.es !== undefined && !opaque(frame.es, 128)) return fail(conn, 'bad_request', ref);
    const tid = nextTunnel;
    nextTunnel = nextTunnel >= 0xffff_fff0 ? 1 : nextTunnel + 1;
    tunnels.set(tid, { a: conn, b: other });
    conn.tunnels.add(tid);
    other.tunnels.add(tid);
    send(conn, { t: 'opened', ref, tid });
    // e: the opener's ephemeral key, es: its device key's signature over it (checked by the receiver).
    send(other, { t: 'incoming', tid, from: conn.fp, ...(frame.e ? { e: frame.e } : {}), ...(frame.es ? { es: frame.es } : {}) });
  }

  function find(conn: Conn, frame: Frame): void {
    if (!isRef(frame.ref)) return fail(conn, 'bad_request');
    if (typeof frame.id !== 'string' || !/^\d{9}$/.test(frame.id)) return fail(conn, 'bad_request', frame.ref);
    if (!finds.takeAll(keysOf(conn))) return fail(conn, 'rate_limited', frame.ref);
    const found = [...(byRemoteId.get(frame.id) ?? [])].filter((other) => other !== conn).slice(0, 4);
    send(conn, { t: 'found', ref: frame.ref, entries: found.map((other) => ({ pub: other.pub, box: other.box, boxSig: other.boxSig })) });
  }

  function pair(conn: Conn, frame: Frame): void {
    const ref = frame.ref;
    if (!isRef(ref)) return fail(conn, 'bad_request');
    if (!isFingerprint(frame.to) || !opaque(frame.e, 64) || !opaque(frame.c, 22_000)) return fail(conn, 'bad_request', ref);
    const target = byFp.get(frame.to);
    if (!target || target === conn || !target.findable) return fail(conn, 'unavailable', ref);
    let open = 0;
    for (const pending of pairs.values()) if (pending.from === conn) open++;
    if (open >= limits.maxPendingPairs || !pairsOut.takeAll(keysOf(conn)) || !pairsIn.take(target.fp!)) return fail(conn, 'rate_limited', ref);
    const rid = nextPair++;
    const timer = setTimeout(() => { if (pairs.delete(rid)) fail(conn, 'timeout', ref); }, limits.pairTimeoutMs);
    timer.unref?.();
    pairs.set(rid, { from: conn, ref, to: target, timer });
    send(target, { t: 'pair', ref: rid, from: conn.fp, src: tagOf(conn), e: frame.e, c: frame.c });
  }

  function pairReply(conn: Conn, frame: Frame): void {
    const pending = isRef(frame.ref) ? pairs.get(frame.ref) : undefined;
    if (!pending || pending.to !== conn) return;
    clearTimeout(pending.timer);
    pairs.delete(frame.ref as number);
    if (opaque(frame.c, 22_000)) send(pending.from, { t: 'pairReply', ref: pending.ref, c: frame.c });
    else send(pending.from, { t: 'pairReply', ref: pending.ref, error: typeof frame.error === 'string' && ERROR_CODE.test(frame.error) ? frame.error : 'failed' });
  }

  function control(conn: Conn, data: Buffer): void {
    conn.alive = true; // traffic proves the connection (a paused reader may read its pong late)
    if (!conn.control.take()) { fail(conn, 'rate_limited'); return; }
    const frame = parseControl(data);
    if (!frame) { fail(conn, 'bad_request'); return; }
    if (!conn.fp) {
      if (frame.t === 'hello') register(conn, frame);
      else conn.ws.close(4000, 'hello first');
      return;
    }
    switch (frame.t) {
      case 'update': {
        const peers = peerList(frame.peers);
        if (!peers) return fail(conn, 'bad_request');
        setPeers(conn, peers);
        if (typeof frame.findable === 'boolean' && frame.findable !== conn.findable) { conn.findable = frame.findable; index(conn); }
        const port = portOf(frame.port);
        if (port !== conn.port) {
          conn.port = port; // its pinned peers learn the new address
          for (const fp of conn.peers) { const other = byFp.get(fp); if (other && mutual(conn, other)) presence(other, conn, true); }
        }
        return;
      }
      case 'open': return open(conn, frame);
      case 'close': {
        const tunnel = Number.isInteger(frame.tid) ? tunnels.get(frame.tid as number) : undefined;
        if (tunnel && (tunnel.a === conn || tunnel.b === conn)) closeTunnel(frame.tid as number, tunnel.a === conn ? tunnel.b : tunnel.a);
        return;
      }
      case 'find': return find(conn, frame);
      case 'pair': return pair(conn, frame);
      case 'pairReply': return pairReply(conn, frame);
      default: return fail(conn, 'bad_request');
    }
  }

  /** Reads from a sender only while it has byte tokens and its receiver keeps up (backpressure, nothing dropped). */
  function flow(conn: Conn): void {
    try { if (conn.paused || conn.stalled) conn.ws.pause(); else conn.ws.resume(); } catch { /* closing */ }
  }

  function unstall(conn: Conn): void {
    if (!conn.stalled) return;
    clearTimeout(conn.stalled.timer);
    conn.stalled.on.waiters.delete(conn);
    conn.stalled = undefined;
    flow(conn);
  }

  /** The receiver's socket took a frame: senders waiting for it go on once its buffer is low again. */
  function drained(receiver: Conn): void {
    if (!receiver.waiters.size || receiver.ws.bufferedAmount > limits.lowBufferedBytes) return;
    for (const sender of [...receiver.waiters]) unstall(sender);
  }

  function data(conn: Conn, frame: Buffer): void {
    if (!conn.fp) { conn.ws.close(4000, 'hello first'); return; }
    conn.alive = true;
    const tid = tunnelOf(frame);
    const tunnel = tid !== undefined ? tunnels.get(tid) : undefined;
    if (!tunnel || (tunnel.a !== conn && tunnel.b !== conn)) return; // closed a moment ago
    const other = tunnel.a === conn ? tunnel.b : tunnel.a;
    if (other.ws.bufferedAmount > limits.maxBufferedBytes) { closeTunnel(tid!, undefined, 'slow'); return; }
    other.ws.send(frame, () => drained(other));
    if (!conn.stalled && other.ws.bufferedAmount > limits.lowBufferedBytes) {
      // The receiver lags: stop reading from this sender until it caught up (or give up on this tunnel).
      const timer = setTimeout(() => { if (conn.stalled?.timer === timer) { closeTunnel(tid!, undefined, 'slow'); unstall(conn); } }, limits.stallMs);
      timer.unref?.();
      conn.stalled = { on: other, tid: tid!, timer };
      other.waiters.add(conn);
      flow(conn);
    }
    const wait = conn.bytes.spend(frame.length);
    if (wait > 0 && !conn.paused) {
      conn.paused = true;
      flow(conn); // the sender's TCP window fills instead of the relay's memory
      const timer = setTimeout(() => { conn.paused = false; flow(conn); }, Math.min(wait, 10_000));
      timer.unref?.();
    }
  }

  function drop(conn: Conn): void {
    if (!conns.delete(conn)) return;
    clearTimeout(conn.helloTimer);
    unstall(conn);
    for (const sender of [...conn.waiters]) unstall(sender);
    const left = (perIp.get(conn.source) ?? 1) - 1;
    if (left > 0) perIp.set(conn.source, left); else perIp.delete(conn.source);
    for (const tid of [...conn.tunnels]) {
      const tunnel = tunnels.get(tid);
      closeTunnel(tid, tunnel ? (tunnel.a === conn ? tunnel.b : tunnel.a) : undefined);
    }
    for (const [rid, pending] of pairs) {
      if (pending.from !== conn && pending.to !== conn) continue;
      clearTimeout(pending.timer);
      pairs.delete(rid);
      if (pending.to === conn) fail(pending.from, 'unavailable', pending.ref);
    }
    if (!conn.fp || byFp.get(conn.fp) !== conn) return;
    byFp.delete(conn.fp);
    conn.findable = false;
    index(conn);
    for (const fp of conn.peers) {
      const other = byFp.get(fp);
      if (other && mutual(conn, other)) presence(other, conn, false);
    }
  }

  const ipHeader = options.ipHeader?.toLowerCase() || 'x-forwarded-for';
  function clientIp(request: IncomingMessage): string {
    const forwarded = options.trustProxy ? String(request.headers[ipHeader] ?? '').split(',').map((part) => part.trim()).filter(Boolean).pop() : undefined;
    return (forwarded ?? request.socket.remoteAddress ?? 'unknown').slice(0, 64);
  }

  const server: Server | undefined = options.noServer ? undefined : createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...stats() }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Autark meeting server');
  });
  const wss = new Server({ ...(server ? { server } : { noServer: true }), maxPayload: DATA_HEADER + MAX_DATA_PAYLOAD, perMessageDeflate: false });
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    // First, before any early return: a socket without an 'error' listener that sends a bad frame while it closes
    // ('busy') would end the whole process – and with it a host program this server is mounted in.
    ws.on('error', () => undefined);
    const ip = clientIp(request);
    const source = sourceOf(ip);
    if (conns.size >= limits.maxConnections || (perIp.get(source) ?? 0) >= limits.maxPerIp) { ws.close(1013, 'busy'); return; }
    const conn: Conn = {
      ws, source, ip, port: 0, challenge: newChallenge(), peers: new Set(), findable: false, tunnels: new Set(), paused: false, waiters: new Set(), alive: true,
      control: new Bucket(limits.controlPerSecond, limits.controlPerSecond * 3, now),
      bytes: new Bucket(limits.bytesPerSecond, limits.bytesPerSecond * 8, now),
    };
    conns.add(conn);
    perIp.set(source, (perIp.get(source) ?? 0) + 1);
    conn.helloTimer = setTimeout(() => ws.close(4001, 'no hello'), limits.helloTimeoutMs);
    conn.helloTimer.unref?.();
    ws.on('message', (raw: Buffer, isBinary: boolean) => (isBinary ? data(conn, raw) : control(conn, raw)));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('close', () => drop(conn));
    ws.on('error', () => drop(conn));
    send(conn, { t: 'challenge', v: PROTOCOL, n: conn.challenge });
  });

  // Keepalive: one ping per interval; a connection that did not answer the last one is ended.
  const keepalive = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) { conn.ws.terminate(); drop(conn); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* closing */ }
    }
  }, limits.pingIntervalMs);
  keepalive.unref?.();

  function stats() {
    return { connections: conns.size, devices: byFp.size, tunnels: tunnels.size, pairs: pairs.size };
  }

  const close = () => new Promise<void>((done) => {
    clearInterval(keepalive);
    for (const conn of [...conns]) { conn.ws.terminate(); drop(conn); }
    wss.close();
    if (!server) { done(); return; }
    server.close(() => done());
    server.closeAllConnections?.();
  });
  if (!server) return { port: 0, stats, handleUpgrade, close };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      log('meeting server listening', { port });
      resolve({ port, stats, handleUpgrade, close });
    });
  });
}

/** A peer listener port from a client frame (0 = none). */
function portOf(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536 ? value as number : 0;
}

/** `http://<ip>:<port>` of a client as seen here (IPv6 in brackets, the IPv4-mapped prefix dropped). */
export function addressOf(ip: string, port: number): string {
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '');
  return `http://${plain.includes(':') ? `[${plain}]` : plain}:${port}`;
}

export { boxText, helloText, remoteIdOf, fingerprintOf };
