// B-058 T6: a fake provider server (node:http on 127.0.0.1) for the media adapter tests – it records every
// request (method, path, headers, body) and answers through the test's handler, like the documented APIs.
// Owns: the server, request records, a target/context builder and small sample files. Never: a real provider call.

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Account, ProviderId } from '../../../src/shared/model/providers.ts';
import type { GenerationContext, GenerationTarget } from '../../../src/runtime/media/providers/types.ts';
import { encodeWav } from '../../../src/shared/voice/wav.ts';

export const KEY = 'test-key-0123456789abcdef';

export interface Seen { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer; json?: any }
export type Handler = (request: Seen, response: ServerResponse, origin: string) => void | Promise<void>;

export interface FakeServer { origin: string; seen: Seen[]; close(): Promise<void> }

/** A server answering every request through `handle` (unanswered requests stay open – deadline tests). */
export async function fakeServer(handle: Handler): Promise<FakeServer> {
  const seen: Seen[] = [];
  let origin = '';
  const open = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let json: unknown;
    try { json = body.length ? JSON.parse(body.toString('utf8')) : undefined; } catch { json = undefined; }
    const request: Seen = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body, json };
    seen.push(request);
    open.add(res);
    res.on('close', () => open.delete(res));
    try { await handle(request, res, origin); } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, seen,
    close: () => new Promise<void>((resolve) => { for (const res of open) res.destroy(); server.close(() => resolve()); }),
  };
}

/** Sends JSON (or bytes with a type). */
export function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const raw = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': type, 'content-length': String(raw.byteLength) });
  res.end(raw);
}

export function account(provider: ProviderId, baseUrl: string): Account {
  return { id: `acc_${provider}`, provider, label: provider, auth: 'api_key', baseUrl, secretId: 'sec_1', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0 };
}

export function target(provider: ProviderId, baseUrl: string, model: string, key: string | undefined = KEY): GenerationTarget {
  return { account: account(provider, baseUrl), model, key: async () => key };
}

export function ctx(ms = 10_000, signal?: AbortSignal): GenerationContext {
  return { fetch: (url, init) => fetch(url, init), deadlineMs: Date.now() + ms, signal };
}

/** Small sample files with the right magic bytes. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
export const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 2)]);
export const WAV = Buffer.from(encodeWav(new Float32Array(480).fill(0.25), 24_000));
/** 480 samples of raw PCM16 LE (20 ms at 24 kHz). */
export const PCM = Buffer.alloc(960, 3);
