// Small request/socket helpers shared by the HTTP server's request and upgrade paths.
// Owns: request-target parsing into RequestInfo, log-safe paths and refused upgrades.
// Never: decides access (security.ts / server.ts do).

import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import { isLoopback, normalizeAddress } from './security.ts';
import type { RequestInfo } from './types.ts';

/** First value of a possibly repeated header. */
export function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A local reverse proxy (`tailscale serve`) forwards remote devices from 127.0.0.1; it adds
 * forwarding/identity headers, so such requests never count as "from this computer".
 */
export function proxied(req: IncomingMessage): boolean {
  const h = req.headers;
  return h['x-forwarded-for'] !== undefined || h['x-forwarded-host'] !== undefined || h.forwarded !== undefined || h['tailscale-user-login'] !== undefined;
}

/**
 * Parses origin-form (`/path?q`) and absolute-form request targets; undefined when malformed.
 * `viaProxyHost` marks requests whose Host is a proxied (served) name as remote.
 */
export function requestInfo(req: IncomingMessage, viaProxyHost: (host: string | undefined) => boolean = () => false): RequestInfo | undefined {
  const raw = req.url ?? '/';
  let url: URL;
  try {
    url = raw.startsWith('/') ? new URL(`http://localhost${raw}`) : new URL(raw);
  } catch {
    return undefined;
  }
  const remote = normalizeAddress(req.socket.remoteAddress);
  const loopback = isLoopback(remote) && !proxied(req) && !viaProxyHost(req.headers.host);
  return { url, remote, loopback };
}

/** Path for logs: never the query (it may carry `?token=`). */
export function safePath(req: IncomingMessage): string {
  return (req.url ?? '').split('?')[0].slice(0, 200);
}

/** Answers a refused WebSocket upgrade with a bare status line and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

/** Resolves when a WebSocket has closed. */
export function closedSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once('close', () => resolve()));
}
