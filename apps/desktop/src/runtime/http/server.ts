// The runtime's HTTP server: PWA (static UI + sandbox apps), WebSocket RPC (`/ws`), the
// unauthenticated pairing exchange (`POST /rpc`), B-050 K8 (d) for other programs `POST /rpc` with a bearer token
// (http/rpc.ts) and `GET /events` as Server-Sent Events (http/sse.ts) – the /ws Hello's tokens, scopes and transport
// rules (bearerScope) –, the MCP hub (`/mcp`, loopback only), blobs
// (`/files/<sha256>`), linked-PC connect requests and peer sockets. Other PCs normally reach the dedicated
// peer listener (peer-server.ts); this server keeps the peer routes for same-host use and while
// it already listens on the LAN or tailnet.
// Owns: listening (port fallback, rebind when settings.pwa.bind changes), the per-request
// security gate (Host allowlist, Origin check, bind gate: with bind 'tailscale' client routes
// answer 403 to LAN peers and client sockets opened over the LAN before the switch are closed;
// the linked-PC routes follow settings.devices.peer instead, like the peer listener: 'off' this
// computer only – never proxied requests –, 'tailscale' tailnet peers only), the transport ceiling (device scopes carry
// `secure` from the socket's remote and local address), routing and socket lifecycle.
// Never: business logic (routes delegate), CORS headers, stack traces in responses, tokens in logs.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientScope } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Logger } from '../contracts.ts';
import { externalAgentSockets } from '../bridges/external-agents.ts';
import { sendError, sendJson } from './body.ts';
import { serveFile } from './files.ts';
import { listenWithFallback, relisten } from './listen.ts';
import { handleMcp } from './mcp.ts';
import { acceptPeer, MAX_PEERS, PEER_MAX_PAYLOAD, PEER_PATHS, servePair, serveWellKnown } from './peer.ts';
import { closedSocket, header, rejectUpgrade, requestInfo, safePath } from './request.ts';
import { withMessageViews } from './message-view.ts';
import { handleBearerRpc, handleRpcPost } from './rpc.ts';
import { EventStreams } from './sse.ts';
import { SandboxRoute } from './sandbox.ts';
import { HostGuard, RateLimiter, bindAllows, isLoopback, isSecureTransport, normalizeAddress, tokensEqual } from './security.ts';
import { StaticFiles } from './static.ts';
import type { HttpServerDeps, RequestInfo } from './types.ts';
import { CLIENT_MAX_PAYLOAD, CLOSE, ClientSockets, Keepalive, type ExternalSocketAuth } from './ws.ts';

const MCP_PATH = /^\/mcp(?:\/([A-Za-z0-9_-]{16,256}))?\/?$/;
const FILE_PATH = /^\/files\/([0-9a-fA-F]{64})$/;
const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Request facts plus the address the connection arrived on (tailnet peers must reach the tailnet IP). */
type Facts = RequestInfo & { local: string };

/** Where linked PCs may reach the peer routes: settings.devices.peer, or the headless CLI's `--peer`. */
export type HttpServerOptions = HttpServerDeps & { peerMode?: () => 'lan' | 'tailscale' | 'off' };

export class HttpServer {
  private readonly deps: HttpServerOptions;
  private readonly guard: HostGuard;
  private readonly files: StaticFiles;
  private readonly sandbox: SandboxRoute;
  private readonly keepalive = new Keepalive();
  private readonly clients: ClientSockets;
  private readonly external: ExternalSocketAuth;
  private readonly streams: EventStreams;
  private readonly clientWss = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  private readonly peerWss = new WebSocketServer({ noServer: true, maxPayload: PEER_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  private readonly peers = new Set<WebSocket>();
  /** TCP remote and local address of every upgraded socket (client + peer). */
  private readonly remotes = new Map<WebSocket, { remote: string; local: string }>();
  private readonly rpcLimiter = new RateLimiter(30, 60_000);
  private readonly pairLimiter = new RateLimiter(30, 60_000);
  private readonly bearerLimiter = new RateLimiter(600, 60_000);
  private readonly draining = new Set<Server>();
  private server?: Server;
  private boundHost = '';
  private chosenPort = 0;
  private started?: Promise<{ host: string; port: number }>;
  private rebinding: Promise<void> = Promise.resolve();
  private subscriptions: Array<() => void> = [];
  private closed = false;

  constructor(deps: HttpServerOptions) {
    this.deps = deps;
    this.guard = new HostGuard({ extra: deps.allowedHosts });
    this.files = new StaticFiles(deps.staticDir);
    this.sandbox = new SandboxRoute({ services: deps.services, staticDir: deps.staticDir, log: () => this.log() });
    this.external = externalAgentSockets(deps.services); // C8: external agents' tokens (and their transport rule)
    this.clients = new ClientSockets({
      rpc: deps.rpc,
      authenticate: (token, loopback, secure) => this.authenticate(token, loopback, secure),
      revoked: (token) => this.deps.pwa.revoked?.(token) === true || this.personRevoked(token),
      external: this.external,
      // B-050 K8 (d): other programs' sockets get message events with author, chat and level.
      view: (connection, scope, client) => (scope.kind === 'external' || client === 'external' ? withMessageViews(connection, deps.services, scope) : connection),
      keepalive: this.keepalive,
      log: () => this.log(),
      helloTimeoutMs: deps.helloTimeoutMs,
    });
    this.streams = new EventStreams({ rpc: deps.rpc, services: deps.services, external: this.external, log: () => this.log() });
  }

  /** The port actually listened on (0 before listen()). */
  get port(): number {
    return this.chosenPort;
  }

  /** Starts listening (idempotent): configured port, else the remembered fallback, else ephemeral. */
  listen(): Promise<{ host: string; port: number }> {
    this.started ??= this.start().catch((error: unknown) => {
      this.started = undefined; // a later listen() may try again
      throw error;
    });
    return this.started;
  }

  /** Stops listening, closes every socket and waits (bounded) for the servers to finish. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // A start still in progress gives its listener up (start() checks `closed`).
    await this.started?.catch(() => undefined);
    for (const off of this.subscriptions.splice(0)) off();
    await this.rebinding;
    const sockets = this.keepalive.all();
    this.clients.closeAll();
    this.streams.closeAll();
    for (const ws of this.peers) ws.close(1001, 'server closing');
    // Give close frames a moment, then cut whatever is left.
    await Promise.race([Promise.all(sockets.map(closedSocket)), delay(500, undefined, { ref: false })]);
    for (const ws of this.keepalive.all()) ws.terminate();
    this.keepalive.stop();
    const servers = [...this.draining, ...(this.server ? [this.server] : [])];
    this.server = undefined;
    await Promise.race([
      Promise.all(servers.map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }))),
      delay(2_000, undefined, { ref: false }),
    ]);
    this.draining.clear();
    this.clientWss.close();
    this.peerWss.close();
  }

  /** Re-listens on the bind host from settings, keeping the port (PWA origins stay valid). */
  rebind(): Promise<void> {
    this.rebinding = this.rebinding
      .then(() => this.moveTo(this.deps.bind().host))
      .catch((error: unknown) => { this.log().error('http rebind failed', { error: errorText(error) }); });
    return this.rebinding;
  }

  // ---------------------------------------------------------------- lifecycle

  private async start(): Promise<{ host: string; port: number }> {
    const { host, port } = this.deps.bind();
    const result = await listenWithFallback(() => this.createServer(), host, port, this.deps.services());
    if (this.closed) {
      result.server.close(); // close() ran while we were binding: never leak the listener
      throw new WorkforceError('unavailable', 'The HTTP server was closed while starting.');
    }
    this.server = result.server;
    this.boundHost = host;
    this.chosenPort = result.port;
    if (port > 0 && result.port !== port) this.log().warn('configured port busy; using another port', { configured: port, port: result.port });
    this.log().info('http server listening', { host, port: result.port });
    this.subscribe();
    // After the caller has seen the port (the PWA service reads it for `tailscale serve status`).
    setImmediate(() => { void this.learnServedHosts(); }).unref();
    return { host, port: result.port };
  }

  private createServer(): Server {
    const server = createServer((req, res) => this.onRequest(req, res));
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
    return server;
  }

  /**
   * Moves the listener to `host` on the same port; falls back to the previous host on failure.
   * Also recovers a listener lost by an earlier failed move.
   */
  private async moveTo(host: string): Promise<void> {
    if (this.closed || !this.started) return;
    await this.started; // a rebind during start waits for the first listener (and its port)
    if (this.closed) return;
    const current = this.server;
    if (current && host === this.boundHost) return;
    const previousHost = this.boundHost;
    if (current) {
      // Stop accepting on the old address; its open connections (WebSockets included) drain.
      this.draining.add(current);
      current.once('close', () => this.draining.delete(current));
      current.close();
      this.server = undefined;
    }
    const hosts = host === previousHost ? [host] : [host, previousHost];
    const next = await relisten(() => this.createServer(), hosts, this.chosenPort, () => this.closed);
    if (!next) {
      if (!this.closed) this.log().error('http server could not listen again', { host, port: this.chosenPort });
      return;
    }
    if (this.closed) {
      next.server.close();
      return;
    }
    this.server = next.server;
    this.boundHost = next.host;
    this.log().info('http server rebound', { host: next.host, port: this.chosenPort });
    if (isLoopback(next.host)) this.dropRemoteSockets();
  }

  private track(ws: WebSocket, info: Facts): void {
    this.remotes.set(ws, { remote: info.remote, local: info.local });
    ws.once('close', () => this.remotes.delete(ws));
  }

  /** Access is now limited to this computer: sockets of other machines must not outlive the old listener. */
  private dropRemoteSockets(): void {
    for (const [ws, { remote }] of this.remotes) {
      if (!isLoopback(remote)) ws.close(CLOSE.goingAway, 'access limited to this computer');
    }
    this.streams.closeWhere((remote) => !isLoopback(remote));
  }

  /** bind 'tailscale' keeps the 0.0.0.0 listener: client sockets already open over the LAN are cut here. */
  private dropOffTailnetClients(): void {
    for (const [ws, { remote, local }] of this.remotes) {
      if (!this.peers.has(ws) && !bindAllows('tailscale', remote, local)) ws.close(CLOSE.goingAway, 'access limited to the tailnet');
    }
    this.streams.closeWhere((remote, local) => !bindAllows('tailscale', remote, local));
  }

  private subscribe(): void {
    let bus;
    try { bus = this.deps.services().bus; } catch { return; }
    if (!bus) return;
    this.subscriptions.push(
      bus.on('device.upserted', (device) => { if (device.status === 'revoked') this.clients.closeDevice(device.id); }),
      bus.on('device.removed', ({ id }) => { this.clients.closeDevice(id); }),
      bus.on('pwa.updated', (state) => { this.guard.setServed(state?.urls ?? []); }),
      bus.on('settings.updated', (settings) => {
        // B-078 (D5): no phone switch – a device stays in while its accepted row exists (device.upserted/removed above).
        if (settings?.pwa?.bind === 'tailscale') this.dropOffTailnetClients();
        try { if (this.deps.bind().host !== this.boundHost || !this.server) void this.rebind(); } catch { /* bind() unavailable */ }
      }),
    );
  }

  /** Learns the phone addresses once at start. */
  private async learnServedHosts(): Promise<void> {
    try {
      if (this.closed) return;
      this.guard.setServed((await this.deps.pwa.state()).urls);
    } catch (error) {
      this.log().debug('pwa state at start failed', { error: errorText(error) });
    }
  }

  // ---------------------------------------------------------------- requests

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((error: unknown) => {
      this.log().error('http request failed', { path: safePath(req), error: errorText(error) });
      if (!res.headersSent) sendError(res, 500, 'internal', 'Something went wrong. It was logged.');
      else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const info = this.requestFacts(req);
    if (!info) return sendError(res, 400, 'bad_request', 'Invalid request URL.');
    if (!this.guard.allows(req.headers.host)) return sendError(res, 403, 'forbidden', 'Host not allowed.');
    if (!this.reachable(info)) {
      return sendError(res, 403, 'forbidden', PEER_PATHS.has(info.url.pathname) ? 'This PC does not accept linked PCs on this address.' : 'This PC accepts phones only over its tailnet.');
    }
    const method = req.method ?? 'GET';
    const path = info.url.pathname;
    if (((method !== 'GET' && method !== 'HEAD') || path === '/events') && !this.guard.allowsOrigin(header(req.headers.origin))) {
      return sendError(res, 403, 'forbidden', 'Origin not allowed.');
    }
    const log = () => this.log();
    if (path === '/rpc') {
      if (req.headers.authorization) return handleBearerRpc(req, res, info, { rpc: this.deps.rpc, limiter: this.bearerLimiter, log, scope: (token) => this.bearerScope(token, info) });
      return handleRpcPost(req, res, info, { rpc: this.deps.rpc, limiter: this.rpcLimiter, log });
    }
    if (path === '/events') return this.streams.serve(req, res, info, (token) => this.bearerScope(token, info), this.bearerLimiter);
    const mcp = MCP_PATH.exec(path);
    if (mcp) return handleMcp(req, res, info, { mcp: this.deps.mcp, log }, mcp[1]);
    const file = FILE_PATH.exec(path);
    if (file) {
      const authenticate = (token: string | undefined, loopback: boolean) => this.authenticate(token, loopback, isSecureTransport(info.remote, info.local));
      return serveFile(req, res, info, { services: this.deps.services, authenticate }, file[1].toLowerCase());
    }
    if (path === '/.well-known/workforce') return serveWellKnown(req, res, this.deps.pairing);
    if (path === '/peer/pair') return servePair(req, res, info, { pairing: this.deps.pairing, limiter: this.pairLimiter, log });
    if (path === '/sandbox/app') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'bad_request', 'Method not allowed.', { Allow: 'GET, HEAD' });
      return this.sandbox.serve(res, info.url, method === 'HEAD');
    }
    if (path === '/ws' || path === '/peer') return sendError(res, 426, 'bad_request', 'WebSocket upgrade required.', { Upgrade: 'websocket' });
    return this.files.serve(req, res, path);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const info = this.requestFacts(req);
    if (!info || this.closed) return rejectUpgrade(socket, 503);
    if (!this.guard.allows(req.headers.host) || !this.guard.allowsOrigin(header(req.headers.origin))) return rejectUpgrade(socket, 403);
    if (!this.reachable(info)) return rejectUpgrade(socket, 403);
    const path = info.url.pathname;
    if (path === '/ws') {
      if (!this.clients.hasRoom()) return rejectUpgrade(socket, 503);
      this.clientWss.handleUpgrade(req, socket, head, (ws) => {
        this.track(ws, info);
        this.clients.accept(ws, info.loopback, isSecureTransport(info.remote, info.local));
      });
      return;
    }
    if (path === '/peer') {
      if (this.peers.size >= MAX_PEERS) return rejectUpgrade(socket, 503);
      this.peerWss.handleUpgrade(req, socket, head, (ws) => {
        this.peers.add(ws);
        ws.once('close', () => this.peers.delete(ws));
        this.track(ws, info);
        this.keepalive.add(ws);
        acceptPeer(ws, { mesh: this.deps.mesh, log: () => this.log() }, info.remote);
      });
      return;
    }
    rejectUpgrade(socket, 404);
  }

  /** Facts about a request (remote/local address, loopback); one place so tests can stand in other peers. */
  private requestFacts(req: IncomingMessage): Facts | undefined {
    const info = requestInfo(req, (host) => this.guard.isServed(host));
    return info && { ...info, local: normalizeAddress(req.socket.localAddress) };
  }

  /**
   * The bind gate for client routes, the devices.peer gate for linked-PC routes (unreadable → this
   * computer only). "This computer" is `info.loopback`, not the raw socket address: traffic that a
   * local proxy (`tailscale serve`) forwards from 127.0.0.1 is remote and only passes in 'lan' or,
   * as tailnet traffic, in 'tailscale'.
   */
  private reachable(info: Facts): boolean {
    if (PEER_PATHS.has(info.url.pathname)) {
      if (info.loopback) return true; // same-host runtimes and tests
      let mode: 'lan' | 'tailscale' | 'off';
      try { mode = this.deps.peerMode?.() ?? this.deps.services().settings.get().devices?.peer ?? 'lan'; } catch { return false; }
      return mode === 'lan' || (mode === 'tailscale' && isSecureTransport(info.remote, info.local));
    }
    let bind: 'localhost' | 'lan' | 'tailscale';
    try { bind = this.deps.services().settings.get().pwa.bind; } catch { return isLoopback(info.remote); }
    return bindAllows(bind, info.remote, info.local);
  }

  /**
   * Token → scope: the launch token is owner scope from this computer only; else a device token
   * whose scope carries `secure` (loopback or tailnet peer) for the transport ceiling.
   */
  private authenticate(token: string | undefined, loopback: boolean, secure: boolean): ClientScope | undefined {
    if (!token) return undefined;
    if (tokensEqual(token, this.deps.launchToken)) return loopback ? { kind: 'owner' } : undefined;
    try {
      const scope = this.deps.pwa.authenticate(token);
      if (scope?.kind === 'device') return { ...scope, secure };
      // F-52: a person of the organisation (runtime/people) – never the owner's scope.
      const person = this.deps.services().people?.authenticate(token);
      return person?.kind === 'person' ? { ...person, secure } : undefined;
    } catch (error) {
      this.log().error('device token check failed', { error: errorText(error) });
      return undefined;
    }
  }

  /**
   * B-050 K8 (d): the scope a bearer token of POST /rpc or GET /events gets – exactly what a /ws Hello
   * with it gets (owner from this computer, device, person, else an external agent under its transport
   * rule); 'revoked' for a token that was taken back.
   */
  private bearerScope(token: string, info: Facts): ClientScope | 'revoked' | undefined {
    const secure = isSecureTransport(info.remote, info.local);
    const scope = this.authenticate(token, info.loopback, secure);
    if (scope) return scope;
    try {
      const external = this.external.authenticate(token, info.loopback, secure);
      if (external?.kind === 'external') return external;
      if (this.deps.pwa.revoked?.(token) === true || this.personRevoked(token) || this.external.revoked?.(token) === true) return 'revoked';
    } catch (error) {
      this.log().error('bearer token check failed', { error: errorText(error) });
    }
    return undefined;
  }

  /** F-52: a refused token of a removed person or device of a person (closed with 4403). */
  private personRevoked(token: string): boolean {
    try { return this.deps.services().people?.revoked(token) === true; } catch { return false; }
  }

  private log(): Logger {
    if (this.deps.log) return this.deps.log;
    try { return this.deps.services().log; } catch { return SILENT; }
  }
}
