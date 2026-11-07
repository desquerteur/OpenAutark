// Client WebSockets on `/ws` (PWA, phone, local CLI, C8 external agents): the
// first frame must be a Hello within 10 s; its token decides the scope (owner/device, else an
// external agent's token through `external` – bridges/external-agents.ts, which also judges the
// transport) or the socket closes with 4401 (4403 for a removed device or external agent);
// whether the socket's peer is on a secure transport is passed along for device scopes. AF-001: an owner Hello may carry
// `agent` (the identity of the agent whose wf it is): the scope stays owner with that agent's id, a refused one closes 4406. The authenticated
// socket is adapted to an RpcConnection (B-050 K8 d: `view` may wrap it) and attached to the RPC server. External
// agents hold ≤ 2 sockets each, ≤ 8 together (more close with 1013); one closes with 4403 once its
// access ends (`external.watch`, armed with the first external socket); a device's sockets close when its row is
// revoked or removed (closeDevice – B-078 D5: no phone switch any more).
// Owns: the Hello handshake and client limits and the socket → RpcConnection adapter (the shared
// 30 s ping keepalive is http/keepalive.ts, re-exported here).
// Never: dispatches RPC itself, logs tokens, or keeps a slow client's backlog in RAM.

import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/api/protocol.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';
import type { Logger } from '../contracts.ts';
import type { Keepalive } from './keepalive.ts';
import type { RpcAttach, RpcConnection } from './types.ts';

export { Keepalive } from './keepalive.ts';

/**
 * Max incoming frame: one `files.uploadChunk` request (≤ 4 MB raw = 5.6 MB base64, rpc/uploads.ts,
 * ui/blocks/host.ts) plus its JSON envelope. Larger inline uploads must use chunks.
 */
export const CLIENT_MAX_PAYLOAD = 6 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
/** A client that lets this much pile up unread is dropped (it reconnects and reloads). */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** Frames at least this large (files.read replies …) are tracked while they are being written. */
const LARGE_FRAME = 1024 * 1024;
const MAX_CLIENTS = 64;
/** Sockets still waiting for their Hello: each may buffer one max-size frame (RAM bound). */
const MAX_PENDING = 16;
/** C8: live sockets per external agent, and of all external agents together. */
const MAX_EXTERNAL_PER_AGENT = 2;
const MAX_EXTERNAL = 8;

export const CLOSE = {
  badHello: 4400,
  unauthorized: 4401,
  revoked: 4403,
  agentRefused: 4406, // AF-001: an owner Hello whose `agent` identity this runtime did not issue or whose agent is gone
  helloTimeout: 4408,
  slowConsumer: 4429,
  busy: 1013,
  internal: 1011,
  goingAway: 1001,
} as const;

/** Adapts an authenticated ws to RpcConnection; frames that arrive before a listener is registered are queued. */
function adapt(ws: WebSocket, log: () => Logger): RpcConnection & { deliver(text: string): void; closed(): void } {
  const messageListeners: Array<(data: unknown) => void> = [];
  const closeListeners: Array<() => void> = [];
  const early: string[] = [];
  let isClosed = false;
  /** Bytes of large frames handed to the socket and not yet written out. */
  let large = 0;
  return {
    send(frame) {
      if (isClosed || ws.readyState !== ws.OPEN) return;
      // Only backlog beyond our own large frames still in flight counts: one big reply
      // (e.g. files.read) must not get the connection dropped by the next small event.
      if (ws.bufferedAmount - large > MAX_BUFFERED) {
        log().warn('dropping slow client connection', { buffered: ws.bufferedAmount });
        ws.close(CLOSE.slowConsumer, 'too slow');
        return;
      }
      let text: string;
      try {
        text = typeof frame === 'string' ? frame : JSON.stringify(frame);
      } catch (error) {
        log().error('rpc frame could not be encoded', { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (text.length < LARGE_FRAME) {
        ws.send(text);
        return;
      }
      const bytes = Buffer.byteLength(text);
      large += bytes;
      ws.send(text, () => { large -= bytes; }); // called once written (or with an error on close)
    },
    close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, 'bye');
    },
    onMessage(listener) {
      messageListeners.push(listener);
      for (const text of early.splice(0)) for (const fn of messageListeners) fn(text);
    },
    onClose(listener) {
      if (isClosed) listener();
      else closeListeners.push(listener);
    },
    deliver(text) {
      if (isClosed) return;
      if (!messageListeners.length) { early.push(text); return; }
      for (const fn of messageListeners) {
        try { fn(text); } catch (error) { log().error('rpc message listener failed', { error: error instanceof Error ? error.message : String(error) }); }
      }
    },
    closed() {
      if (isClosed) return;
      isClosed = true;
      for (const fn of closeListeners.splice(0)) {
        try { fn(); } catch { /* listener errors must not break cleanup */ }
      }
    },
  };
}

interface Hello { token: string; client?: string; agent?: string }

/** Validates the first frame; undefined when it is not a Hello. */
function parseHello(text: string): Hello | 'protocol' | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const hello = value as Record<string, unknown>;
  if (typeof hello.token !== 'string' || hello.token.length > 512) return undefined;
  if (hello.agent !== undefined && (typeof hello.agent !== 'string' || !hello.agent || hello.agent.length > 512)) return undefined; // AF-001
  if (hello.protocol !== undefined && hello.protocol !== PROTOCOL_VERSION) return 'protocol';
  return { token: hello.token, client: typeof hello.client === 'string' ? hello.client.slice(0, 20) : undefined, ...(typeof hello.agent === 'string' ? { agent: hello.agent } : {}) };
}

/** C8: the second token kind on `/ws` – external agents docked into one chat (bridges/external-agents.ts). */
export interface ExternalSocketAuth {
  /** Hello token → external-agent scope; undefined when it is no live external-agent token or the transport does not admit it. */
  authenticate(token: string, loopback: boolean, secure: boolean): ClientScope | undefined;
  /** A refused token of a removed external agent (closed with 4403 instead of 4401). */
  revoked?(token: string): boolean;
  /** Calls `ended` when an external agent's access ends (a member, or every member of a chat); returns the unsubscribe. */
  watch(ended: (end: { memberId?: string; conversationId: string }) => void): () => void;
}

export interface ClientSocketDeps {
  rpc: RpcAttach;
  /** Hello token → scope (owner only from loopback; `secure` for devices); undefined rejects the socket. */
  authenticate(token: string, loopback: boolean, secure: boolean): ClientScope | undefined;
  /** A refused token of a removed device: closed with 4403 (revoked) instead of 4401. */
  revoked?(token: string): boolean;
  /** C8: external-agent tokens, tried after `authenticate` refused a token. */
  external?: ExternalSocketAuth;
  /** AF-001: Hello `agent` (an agent's wf, engines/agent-token.ts) → that agent's id; undefined refuses the socket (4406). Owner Hellos only. */
  agent?(token: string): string | undefined;
  view?(connection: RpcConnection, scope: ClientScope, client: string | undefined): RpcConnection; // B-050 K8 (d): by scope and Hello `client` (other programs' message view)
  keepalive: Keepalive;
  log: () => Logger;
  helloTimeoutMs?: number;
}

/** Live client connections (by scope, so revoked devices can be dropped). */
export class ClientSockets {
  private readonly deps: ClientSocketDeps;
  private readonly live = new Map<WebSocket, ClientScope | undefined>();
  private unwatch?: () => void;

  constructor(deps: ClientSocketDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.live.size;
  }

  /** True when another client may connect (checked before the upgrade completes). */
  hasRoom(): boolean {
    if (this.live.size >= MAX_CLIENTS) return false;
    let pending = 0;
    for (const scope of this.live.values()) if (!scope) pending++;
    return pending < MAX_PENDING;
  }

  /**
   * Runs the Hello handshake on a freshly upgraded socket and attaches it to RPC. `secure`:
   * the peer is on loopback or the tailnet (defaults to `loopback`).
   */
  accept(ws: WebSocket, loopback: boolean, secure = loopback): void {
    const log = this.deps.log;
    this.live.set(ws, undefined);
    this.deps.keepalive.add(ws);
    let connection: ReturnType<typeof adapt> | undefined;
    let detach: (() => void) | undefined;
    /** 'hello' until the first frame; 'done' after a refused Hello (frames queued behind it are ignored). */
    let stage: 'hello' | 'open' | 'done' = 'hello';
    const timer = setTimeout(() => ws.close(CLOSE.helloTimeout, 'hello timeout'), this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    timer.unref?.();

    ws.on('error', (error) => log().debug('client socket error', { error: error.message }));
    ws.on('message', (data, isBinary) => {
      // `ws` still emits frames while closing (up to its 30 s close timeout): a device locked
      // out or revoked by our close() must not keep sending requests until it acknowledges.
      if (stage === 'done' || ws.readyState !== ws.OPEN) return;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      if (stage === 'open' && connection) { connection.deliver(text); return; }
      // Exactly one Hello per socket: a refused one is never retried on the same connection.
      stage = 'done';
      clearTimeout(timer);
      const hello = isBinary ? undefined : parseHello(text);
      if (hello === 'protocol') { ws.close(CLOSE.badHello, 'unsupported protocol'); return; }
      if (!hello) { ws.close(CLOSE.badHello, 'expected hello'); return; }
      let scope: ClientScope | undefined;
      try {
        scope = this.deps.authenticate(hello.token, loopback, secure);
        const external = scope ? undefined : this.deps.external?.authenticate(hello.token, loopback, secure);
        if (external?.kind === 'external') scope = external; // never any other scope from this path
      } catch (error) {
        log().error('client authentication failed', { error: error instanceof Error ? error.message : String(error) });
      }
      if (!scope) {
        let removed = false;
        try { removed = this.deps.revoked?.(hello.token) === true || this.deps.external?.revoked?.(hello.token) === true; } catch { removed = false; }
        if (removed) ws.close(CLOSE.revoked, 'revoked'); else ws.close(CLOSE.unauthorized, 'unauthorized');
        return;
      }
      if (hello.agent !== undefined) {
        // AF-001: wf run by an agent – owner access, but its chat lines are the agent's; never silently the person's.
        let agentId: string | undefined;
        try { agentId = scope.kind === 'owner' && !scope.main ? this.deps.agent?.(hello.agent) : undefined; } catch { agentId = undefined; }
        if (!agentId || scope.kind !== 'owner') { ws.close(CLOSE.agentRefused, 'agent refused'); return; }
        scope = { kind: 'owner', agentId };
      }
      if (scope.kind === 'external') {
        if (!this.externalRoom(scope.memberId)) { ws.close(CLOSE.busy, 'too many connections'); return; }
        this.watchExternal();
      }
      this.live.set(ws, scope);
      connection = adapt(ws, log);
      try {
        detach = this.deps.rpc.attach(this.deps.view?.(connection, scope, hello.client) ?? connection, scope);
        stage = 'open';
      } catch (error) {
        log().error('rpc attach failed', { error: error instanceof Error ? error.message : String(error) });
        ws.close(CLOSE.internal, 'internal error');
      }
    });
    ws.once('close', () => {
      clearTimeout(timer);
      this.live.delete(ws);
      connection?.closed();
      try { detach?.(); } catch (error) { log().error('rpc detach failed', { error: error instanceof Error ? error.message : String(error) }); }
    });
  }

  /** Drops the live connections of a revoked device. */
  closeDevice(deviceId: string): number {
    let closed = 0;
    for (const [ws, scope] of this.live) {
      if (scope && scope.kind !== 'owner' && 'deviceId' in scope && scope.deviceId === deviceId) {
        ws.close(CLOSE.revoked, 'revoked');
        closed++;
      }
    }
    return closed;
  }

  /** C8: drops the sockets of an external agent (or of every external agent of a chat) whose access ended. */
  closeExternal(end: { memberId?: string; conversationId: string }): number {
    let closed = 0;
    for (const [ws, scope] of this.live) {
      if (scope?.kind !== 'external' || scope.conversationId !== end.conversationId || (end.memberId && scope.memberId !== end.memberId)) continue;
      ws.close(CLOSE.revoked, 'removed');
      closed++;
    }
    return closed;
  }

  closeAll(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    for (const ws of this.live.keys()) ws.close(CLOSE.goingAway, 'server closing');
  }

  /** Room for one more socket of this external agent (MAX_EXTERNAL_PER_AGENT, MAX_EXTERNAL). */
  private externalRoom(memberId: string): boolean {
    let all = 0, own = 0;
    for (const scope of this.live.values()) {
      if (scope?.kind !== 'external') continue;
      all++;
      if (scope.memberId === memberId) own++;
    }
    return all < MAX_EXTERNAL && own < MAX_EXTERNAL_PER_AGENT;
  }

  /** Listens for ended external access once the first external agent is connected (event-driven, no timer). */
  private watchExternal(): void {
    if (this.unwatch || !this.deps.external) return;
    try {
      this.unwatch = this.deps.external.watch((end) => { this.closeExternal(end); });
    } catch (error) {
      this.deps.log().warn('external agent watch failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
