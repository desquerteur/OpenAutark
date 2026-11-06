// `GET /events` (B-050 K8 d, docs/EXTERNAL_PROTOCOL.md): the runtime's events as Server-Sent Events for
// other programs. `Authorization: Bearer <token>` – the /ws Hello's tokens with their transport rules
// (the server's `scope`; each request, a wrong token included, counts in POST /rpc's per-address
// bearer limit); `?topics=chats,chat:<id>,…` (the /ws topic syntax, ≤ 64). The stream is a
// connection of the RPC server like a socket: it subscribes with events.subscribe, so maySubscribe,
// mayReceive, visibleData and the people's rules apply unchanged; then every event is written as
// `event: <name>` + `data: <json>`, message events with author, chat and level (message-view.ts).
// First `event: ready` with the requested topics (topics the token may not hear stay silent), or
// `event: error` and the end when the subscription is refused. A comment line every HEARTBEAT_MS keeps
// proxies from closing a quiet stream (one interval while streams exist); a reader that leaves more
// than MAX_BUFFERED unread is cut. At most MAX_STREAMS streams, an external agent at most 2. A stream
// ends when the RPC server drops its connection (a revoked device or person), when an external agent's
// access ends, when
// access narrows to this computer or the tailnet (closeWhere), and at shutdown.
// Owns: the stream transport and its limits. Never: authentication, dispatch, or a token in a log or URL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientScope, Topic } from '../../shared/api/protocol.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { isTopic } from '../rpc/scopes.ts';
import { BASE_HEADERS, sendError } from './body.ts';
import { viewerOf, viewFrame } from './message-view.ts';
import { header } from './request.ts';
import type { BearerScope } from './rpc.ts';
import { bearerToken, type RateLimiter } from './security.ts';
import type { RequestInfo, RpcAttach, RpcConnection } from './types.ts';
import type { ExternalSocketAuth } from './ws.ts';

export const MAX_STREAMS = 16;
const MAX_EXTERNAL_PER_AGENT = 2;
const MAX_TOPICS = 64;
const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED = 8 * 1024 * 1024;
const SUBSCRIBE_ID = 1;

interface Stream {
  scope: ClientScope;
  remote: string;
  local: string;
  loopback: boolean;
  res: ServerResponse;
  end(): void;
}

export interface EventStreamDeps {
  rpc: RpcAttach;
  services: () => RuntimeServices;
  /** C8: ends the streams of external agents whose access ended. */
  external?: ExternalSocketAuth;
  log: () => Logger;
  heartbeatMs?: number;
}

/** The `topics` query parameter as topics; undefined when it is missing or holds an invalid one. */
export function topicsOf(url: URL): Topic[] | undefined {
  const parts = (url.searchParams.get('topics') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_TOPICS || !parts.every(isTopic)) return undefined;
  return [...new Set(parts)] as Topic[];
}

export class EventStreams {
  private readonly deps: EventStreamDeps;
  private readonly live = new Set<Stream>();
  private timer?: ReturnType<typeof setInterval>;
  private unwatch?: () => void;

  constructor(deps: EventStreamDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.live.size;
  }

  serve(req: IncomingMessage, res: ServerResponse, info: RequestInfo & { local: string }, scopeOf: BearerScope, limiter?: RateLimiter): void {
    if (req.method !== 'GET') return sendError(res, 405, 'bad_request', 'Use GET.', { Allow: 'GET' });
    // Counted before the token check (POST /rpc's bearer limit): a wrong token costs lookups too.
    if (limiter && !limiter.take(info.remote || 'unknown')) return sendError(res, 429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });
    const token = bearerToken(header(req.headers.authorization));
    const scope = token ? scopeOf(token) : undefined;
    if (scope === 'revoked') return sendError(res, 403, 'forbidden', 'This token was revoked.');
    if (!scope) return sendError(res, 401, 'forbidden', 'A valid token is required.', { 'WWW-Authenticate': 'Bearer' });
    const topics = topicsOf(info.url);
    if (!topics) return sendError(res, 400, 'bad_request', `Name 1 to ${MAX_TOPICS} topics: /events?topics=chats,chat:<id>.`);
    if (!this.room(scope)) return sendError(res, 503, 'unavailable', 'Too many event streams. Close one and try again.');
    this.open(res, scope, info, topics);
  }

  /** Ends the streams whose peer `drop` names (access narrowed to this computer or the tailnet). */
  closeWhere(drop: (remote: string, local: string) => boolean): void {
    for (const stream of [...this.live]) if (drop(stream.remote, stream.local)) stream.end();
  }

  closeAll(): void {
    for (const stream of [...this.live]) stream.end();
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private room(scope: ClientScope): boolean {
    if (this.live.size >= MAX_STREAMS) return false;
    if (scope.kind !== 'external') return true;
    return [...this.live].filter((stream) => stream.scope.kind === 'external' && stream.scope.memberId === scope.memberId).length < MAX_EXTERNAL_PER_AGENT;
  }

  private open(res: ServerResponse, scope: ClientScope, info: RequestInfo & { local: string }, topics: Topic[]): void {
    const listeners: Array<(data: unknown) => void> = [];
    const closers: Array<() => void> = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.live.delete(stream);
      for (const closed of closers.splice(0)) { try { closed(); } catch { /* cleanup only */ } }
      if (!res.writableEnded) res.end();
      this.disarm();
    };
    const stream: Stream = { scope, remote: info.remote, local: info.local, loopback: info.loopback, res, end };
    const write = (text: string) => {
      if (ended) return;
      if (res.writableLength > MAX_BUFFERED) { this.deps.log().warn('dropping slow event stream', { buffered: res.writableLength }); end(); return; }
      res.write(text);
    };
    const viewer = viewerOf(scope);
    const connection: RpcConnection = {
      send: (frame) => {
        const out = frame as { event?: unknown; id?: unknown; error?: unknown } | null;
        if (typeof out?.event === 'string') {
          let services: RuntimeServices | undefined;
          try { services = this.deps.services(); } catch { services = undefined; }
          const data = services ? (viewFrame(services, frame, viewer) as { data?: unknown }).data : (frame as { data?: unknown }).data;
          write(`event: ${out.event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
        } else if (out?.id === SUBSCRIBE_ID) {
          if (out.error) { write(`event: error\ndata: ${JSON.stringify(out.error)}\n\n`); end(); } else write(`event: ready\ndata: ${JSON.stringify({ topics })}\n\n`);
        }
      },
      close: end,
      onMessage: (listener) => { listeners.push(listener); },
      onClose: (listener) => { if (ended) listener(); else closers.push(listener); },
    };
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(': workforce events\n\n');
    res.once('close', end);
    this.live.add(stream);
    this.arm();
    if (scope.kind === 'external') this.watchExternal();
    let detach: (() => void) | undefined;
    try {
      detach = this.deps.rpc.attach(connection, scope);
    } catch (error) {
      this.deps.log().error('event stream attach failed', { error: error instanceof Error ? error.message : String(error) });
      end();
      return;
    }
    closers.push(() => detach?.());
    for (const listener of listeners) listener(JSON.stringify({ id: SUBSCRIBE_ID, method: 'events.subscribe', params: { topics } }));
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { for (const stream of this.live) if (!stream.res.writableEnded) stream.res.write(': ping\n\n'); }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.live.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** C8: listens for ended external access once the first external stream is open. */
  private watchExternal(): void {
    if (this.unwatch || !this.deps.external) return;
    try {
      this.unwatch = this.deps.external.watch((gone) => {
        for (const stream of [...this.live]) {
          const scope = stream.scope;
          if (scope.kind === 'external' && scope.conversationId === gone.conversationId && (!gone.memberId || scope.memberId === gone.memberId)) stream.end();
        }
      });
    } catch (error) {
      this.deps.log().warn('external agent watch failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
