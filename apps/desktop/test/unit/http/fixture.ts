// Test fixture for the runtime HTTP server: a temp UI directory, a stored blob, fake RPC / MCP /
// PWA / pairing / mesh collaborators and a real HttpServer on an ephemeral loopback port.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Bus } from '../../../src/runtime/bus.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SocketLike } from '../../../src/runtime/devices/channel.ts';
import { HttpServer } from '../../../src/runtime/http/server.ts';
import type { HttpServerDeps, McpReply, RpcConnection } from '../../../src/runtime/http/types.ts';
import type { ClientScope, RpcResponse } from '../../../src/shared/api/protocol.ts';
import type { PwaApi } from '../../../src/runtime/rpc/extras.ts';
import { ManualClock, memoryDb, silentLog } from '../devices/fakes.ts';

export const LAUNCH_TOKEN = 'launch-token-0123456789abcdefghijkl';
export const DEVICE_TOKEN = 'device-token-0123456789abcdefghijkl';
export const REMOVED_TOKEN = 'removed-token-0123456789abcdefghijk';
export const BLOB_ID = 'a'.repeat(64);
export const BLOB_TEXT = '0123456789abcdefghijklmnopqrstuvwxyz';
export const MESSAGE_ID = 'msg_01jab3k9z7mx2c4q';

export class FakeRpc {
  attached: Array<{ scope: ClientScope; connection: RpcConnection }> = [];
  detached = 0;
  http: unknown[] = [];

  attach(connection: RpcConnection, scope: ClientScope): () => void {
    this.attached.push({ scope, connection });
    connection.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { id: number; method: string };
      connection.send({ id: frame.id, result: { method: frame.method, scope: scope.kind } });
    });
    return () => { this.detached++; };
  }

  async handleHttp(frame: unknown): Promise<RpcResponse> {
    this.http.push(frame);
    const request = frame as { id: number; method: string };
    if (request.method !== 'pwa.exchange') return { id: request.id, error: { code: 'forbidden', message: 'Not allowed without a token.' } };
    return { id: request.id, result: { token: 'new-device-token', deviceId: 'dev_new' } };
  }
}

export function fixture(options: { port?: number; pwaEnabled?: boolean; bindHost?: string; allowedHosts?: HttpServerDeps['allowedHosts'] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-http-'));
  const ui = path.join(root, 'ui');
  mkdirSync(path.join(ui, 'chunks'), { recursive: true });
  mkdirSync(path.join(ui, 'sandbox'), { recursive: true });
  mkdirSync(path.join(ui, 'icons'), { recursive: true });
  writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Workforce</title>');
  writeFileSync(path.join(ui, 'main.js'), 'console.log("main")');
  writeFileSync(path.join(ui, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  writeFileSync(path.join(ui, 'manifest.webmanifest'), '{"name":"Workforce"}');
  writeFileSync(path.join(ui, 'chunks', 'chat-ABCDEFGH.js'), 'export const x = 1');
  writeFileSync(path.join(ui, 'sandbox', 'wf.js'), 'window.wf = { ready: true }; // </script> inside');
  writeFileSync(path.join(ui, 'icons', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, 'secret.txt'), 'top secret');
  const blob = path.join(root, 'blob.bin');
  writeFileSync(blob, BLOB_TEXT);

  const clock = new ManualClock();
  const bus = new Bus((error) => { throw error; });
  const settings = { pwa: { enabled: options.pwaEnabled ?? false, bind: 'localhost' as const } };
  const services = {
    log: silentLog,
    clock,
    db: memoryDb(),
    bus,
    settings: { get: () => settings, update: () => settings },
    files: {
      get: (id: string) => (id === BLOB_ID ? { id, name: 'clip ä.webm', mime: 'audio/webm', size: BLOB_TEXT.length, createdAt: 0 } : undefined),
      path: () => blob,
    },
    chats: {
      message: (id: string) => (id === MESSAGE_ID
        ? { id, body: 'Here:\n```app\n<button>Go</button>\n```\n', state: 'final' }
        : undefined),
    },
  } as unknown as RuntimeServices;

  const rpc = new FakeRpc();
  const mcpCalls: Array<{ token: string | undefined; body: unknown; headers?: Record<string, string | undefined> }> = [];
  const mcp = {
    async handle(token: string | undefined, body: unknown, headers?: Record<string, string | undefined>): Promise<McpReply> {
      mcpCalls.push({ token, body, headers });
      if (token !== 'lease-token-0123456789abcdef') return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown token' } } };
      if ((body as { method?: string }).method?.startsWith('notifications/')) return { status: 202 };
      return { status: 200, body: { jsonrpc: '2.0', id: (body as { id?: number }).id ?? null, result: { ok: true } }, headers: { 'Mcp-Session-Id': 'session-1' } };
    },
  };
  let servedUrls: string[] = ['http://localhost:47811'];
  const authCalls: string[] = [];
  const pwa = {
    authenticate: (token: string): ClientScope | undefined => {
      authCalls.push(token);
      return token === DEVICE_TOKEN ? { kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo'] } : undefined;
    },
    state: async () => ({ enabled: true, urls: servedUrls, secure: false, devices: [], pushReady: false }),
    revoked: (token: string) => token === REMOVED_TOKEN,
  } as unknown as PwaApi;
  const pairCalls: Array<{ body: unknown; remote: { address?: string } }> = [];
  const pairing = {
    wellKnown: () => ({ app: 'workforce', protocol: 1, deviceId: 'dev_self00000001', name: 'Desk', fingerprint: 'ff' }),
    handle: async (body: unknown, remote: { address?: string }) => { pairCalls.push({ body, remote }); return { ok: true }; },
  };
  const accepted: SocketLike[] = [];
  const mesh = { accept: async (socket: SocketLike) => { accepted.push(socket); return 'dev_peer0000001'; } };

  const server = new HttpServer({
    services: () => services,
    rpc,
    mcp,
    pwa,
    pairing,
    mesh,
    staticDir: ui,
    launchToken: LAUNCH_TOKEN,
    bind: () => ({ host: options.bindHost ?? '127.0.0.1', port: options.port ?? 0 }),
    allowedHosts: options.allowedHosts,
    log: silentLog,
    helloTimeoutMs: 2_000,
  });

  return {
    root, ui, services, clock, bus, settings, rpc, mcpCalls, pairCalls, accepted, server, authCalls,
    setServedUrls(urls: string[]) { servedUrls = urls; },
    async close() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; json(): any }

/** Raw HTTP request (path is sent as-is, so traversal attempts reach the server unchanged). */
export function request(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: options.host ?? '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Opens a WebSocket and resolves once open (or rejects with the HTTP status of a refused upgrade). */
export function openSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => { reject(new Error(`status ${res.statusCode}`)); ws.terminate(); });
    ws.once('error', reject);
  });
}

/** Resolves with the close code of a socket. */
export function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) resolve(-1);
    ws.once('close', (code) => resolve(code));
  });
}

export function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('close', closed); ws.off('error', failed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = (code: number) => failed(new Error(`Socket closed before its reply (${code}).`));
    const message = (data: unknown) => { cleanup(); try { resolve(JSON.parse(String(data))); } catch (error) { reject(error); } };
    const timer = setTimeout(() => failed(new Error('Socket reply timed out.')), 5_000);
    ws.once('message', message);
    ws.once('close', closed);
    ws.once('error', failed);
    if (ws.readyState !== ws.OPEN) failed(new Error('Socket is not open.'));
  });
}
