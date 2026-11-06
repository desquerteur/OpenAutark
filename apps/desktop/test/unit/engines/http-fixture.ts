// Test helper: a scripted local HTTP server for engine adapters (provider APIs).
// Owns: listening on 127.0.0.1:<free port>, recording every request (method, path, headers,
// parsed JSON body) and small JSON/SSE writers in the providers' wire format.
// Never: imported by src/, reaches the network beyond loopback, or keeps sockets open after close().

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/** Handles one request; `index` counts requests from 0 (all paths). */
export type Route = (req: Recorded, res: ServerResponse, index: number) => void | Promise<void>;

export interface TestServer {
  url: string;
  port: number;
  requests: Recorded[];
  /** Requests whose path starts with `prefix`. */
  hits(prefix: string): Recorded[];
  close(): Promise<void>;
}

export async function serve(route: Route): Promise<TestServer> {
  const requests: Recorded[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = text || undefined;
      try { if (text) body = JSON.parse(text); } catch { /* keep raw text */ }
      const recorded: Recorded = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      requests.push(recorded);
      Promise.resolve(route(recorded, res, requests.length - 1)).catch(() => res.destroy());
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    hits: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function sseHead(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
  res.flushHeaders();
}

/** Writes one SSE event; strings are sent verbatim (e.g. `[DONE]`). */
export function sseEvent(res: ServerResponse, data: unknown, event?: string): void {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/** Writes a whole SSE response. Items with a string `event` field (Anthropic, Responses) get an `event:` line. */
export function sendSse(res: ServerResponse, events: unknown[]): void {
  sseHead(res);
  for (const data of events) {
    const name = data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string' ? (data as { type: string }).type : undefined;
    sseEvent(res, data, name);
  }
  res.end();
}

/** Resolves on the next macrotask (lets sockets deliver what was written). */
export const turnOver = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ in-process SSE (PR4)

/** A streaming `text/event-stream` Response for fake fetches (no socket): write events, end or break it. */
export function sseStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; }, cancel: () => { open = false; } });
  const close = (error?: Error) => {
    if (!open) return;
    open = false;
    if (error) controller.error(error); else controller.close();
  };
  signal?.addEventListener('abort', () => close(new Error('aborted')), { once: true });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    get open() { return open; },
    send(data: unknown): void { if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); },
    end: () => close(),
    fail: () => close(new Error('stream broke')),
  };
}
