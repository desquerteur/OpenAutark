// A stable MCP endpoint per ACP session in front of the runtime's per-run MCP hub leases.
// ACP fixes a session's MCP servers at session/new|load, but every turn gets a fresh hub lease
// (new token, released when the turn ends). The proxy gives the agent one loopback URL per session
// (`http://127.0.0.1:<port>/mcp/<random key>`) and forwards each POST to the lease of the turn that
// currently runs in that session; between turns it answers 401 like an expired lease.
// Forwarding uses node:http without a response timeout (loopbackFetch): a hub tools/call answers
// only when the tool returns, which may wait for a person's approval for longer than fetch's
// (undici's) 300 s headers/body timeouts. The forward ends when the agent hangs up or the lease
// is released (the hub aborts its calls then).
// Owns: the loopback listener, key → current lease, body limit, MCP header pass-through.
// Never: interprets MCP messages, logs keys, tokens or bodies, serves browser requests (an Origin
// header is refused), follows redirects or forwards anywhere but the bound lease URL.

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchFn } from '../http/common.ts';

export interface McpTarget { url: string; token: string }

const BODY_LIMIT = 4 * 1024 * 1024;
const PATH = /^\/mcp\/([A-Za-z0-9_-]{32,128})\/?$/;
const PASS_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const PASS_REPLY = ['content-type', 'mcp-session-id', 'www-authenticate'];

const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } });

export class McpProxy {
  private readonly fetchFn: FetchFn;
  private readonly routes = new Map<string, McpTarget | null>();
  private server: http.Server | undefined;
  private base: Promise<string> | undefined;

  constructor(deps: { fetch?: FetchFn } = {}) {
    this.fetchFn = deps.fetch ?? loopbackFetch;
  }

  /** A new session key (unbound until a turn binds its lease) and the URL the agent gets. */
  async endpoint(): Promise<{ key: string; url: string }> {
    const base = await this.open();
    const key = randomBytes(32).toString('base64url');
    this.routes.set(key, null);
    return { key, url: `${base}/mcp/${key}` };
  }

  /** Points a session key at the running turn's lease (undefined = between turns: 401). */
  bind(key: string, target: McpTarget | undefined): void {
    if (this.routes.has(key)) this.routes.set(key, target ?? null);
  }

  drop(key: string): void {
    this.routes.delete(key);
  }

  close(): void {
    this.routes.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.base = undefined;
  }

  private open(): Promise<string> {
    if (!this.base) {
      this.base = new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => { void this.serve(req, res); });
        server.once('error', (error) => { this.base = undefined; reject(error); });
        server.listen(0, '127.0.0.1', () => {
          server.unref();
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
        this.server = server;
      });
    }
    return this.base;
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: string, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Cache-Control': 'no-store', ...(body === undefined ? { 'Content-Length': '0' } : { 'Content-Type': 'application/json' }), ...headers });
      res.end(body);
    };
    const key = PATH.exec((req.url ?? '').split('?')[0])?.[1];
    if (req.headers.origin !== undefined) { req.resume(); send(403, rpcError(-32600, 'Origin not allowed.')); return; }
    if (req.method !== 'POST') { req.resume(); send(405, undefined, { Allow: 'POST' }); return; }
    const target = key ? this.routes.get(key) : undefined;
    if (!target) { req.resume(); send(401, rpcError(-32001, 'No Autark turn is running for this session.'), { 'WWW-Authenticate': 'Bearer' }); return; }
    let body: Buffer;
    try { body = await readBody(req); } catch { send(413, rpcError(-32600, 'Request too large.')); return; }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const headers: Record<string, string> = { Authorization: `Bearer ${target.token}` };
    for (const name of PASS_REQUEST) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    try {
      const reply = await this.fetchFn(target.url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: controller.signal });
      const out: Record<string, string> = {};
      for (const name of PASS_REPLY) {
        const value = reply.headers.get(name);
        if (value && !/[\r\n]/.test(value)) out[name] = value;
      }
      const data = Buffer.from(await reply.arrayBuffer());
      if (res.headersSent) return;
      res.writeHead(reply.status, { 'Cache-Control': 'no-store', ...out, 'Content-Length': String(data.length) });
      res.end(data);
    } catch {
      send(502, rpcError(-32603, 'The Autark tool hub did not answer.'));
    }
  }
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * The default forwarder: one node:http request (no keep-alive pool) with no headers or body
 * timeout. Aborting `init.signal` destroys it; a redirect fails like fetch's redirect: 'error'.
 */
export function loopbackFetch(url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = http.request(url, { method: init.method ?? 'GET', headers, agent: false, signal: init.signal ?? undefined }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { parts.push(chunk); });
      res.once('error', reject);
      res.once('close', () => { if (!res.complete) reject(new Error('The reply was cut off.')); });
      res.once('end', () => {
        try {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) throw new Error('Redirects are not followed.');
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const one of value === undefined ? [] : Array.isArray(value) ? value : [value]) out.append(name, one);
          }
          resolve(new Response(NULL_BODY.has(status) ? null : new Uint8Array(Buffer.concat(parts)), { status, headers: out }));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
    req.end(typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : undefined);
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { req.destroy(); reject(new Error('too large')); return; }
      parts.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(parts)));
    req.once('error', reject);
  });
}
