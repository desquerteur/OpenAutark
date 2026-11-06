// DEV5B: the tokenless `POST /rpc` transport hands the RPC server the caller's address and a
// signal that aborts when the page goes away before the answer (so a long `pwa.awaitAccess`
// ends at once); a normal answer arrives as before. Real HTTP on 127.0.0.1 only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRpcPost } from '../../../src/runtime/http/rpc.ts';
import { RateLimiter } from '../../../src/runtime/http/security.ts';
import type { RpcAttach } from '../../../src/runtime/http/types.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import type { RpcResponse } from '../../../src/shared/api/protocol.ts';

interface Seen { frame: unknown; remote?: string; signal?: AbortSignal }

function serve(answer: (seen: Seen) => Promise<RpcResponse>): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const rpc = {
    attach: () => () => {},
    handleHttp: (frame: unknown, meta?: { remote?: string; signal?: AbortSignal }) => {
      const entry = { frame, remote: meta?.remote, signal: meta?.signal };
      seen.push(entry);
      return answer(entry);
    },
  } as RpcAttach;
  const server = createServer((req, res) => {
    void handleRpcPost(req, res, { url: new URL(req.url ?? '/', 'http://127.0.0.1'), remote: '127.0.0.1', loopback: true }, { rpc, limiter: new RateLimiter(30, 60_000), log: () => nullLogger });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen })));
}

function post(port: number, body: unknown): { done: Promise<{ status: number; body: string }>; abort: () => void } {
  let abort = () => {};
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    abort = () => req.destroy();
    req.end(JSON.stringify(body));
  });
  return { done, abort };
}

test('the answer arrives with the caller\'s address passed along', async (t) => {
  const { server, port, seen } = await serve(async () => ({ id: 1, result: { status: 'pending', expiresAt: 1 } }));
  t.after(() => server.close());
  const reply = await post(port, { id: 1, method: 'pwa.awaitAccess', params: { ticket: 'x'.repeat(43) } }).done;
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { id: 1, result: { status: 'pending', expiresAt: 1 } });
  assert.equal(seen[0].remote, '127.0.0.1');
  assert.equal(seen[0].signal?.aborted, false, 'a finished request is not aborted');
});

test('a page that goes away aborts the long request', async (t) => {
  let release: (() => void) | undefined;
  const { server, port, seen } = await serve((entry) => new Promise<RpcResponse>((resolve) => {
    release = () => resolve({ id: 1, result: { status: 'pending', expiresAt: 1 } });
    entry.signal?.addEventListener('abort', () => release?.(), { once: true });
  }));
  t.after(() => server.close());
  const call = post(port, { id: 1, method: 'pwa.awaitAccess', params: { ticket: 'x'.repeat(43) } });
  call.done.catch(() => undefined);
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.length, 1);
  call.abort();
  for (let i = 0; i < 100 && !seen[0].signal?.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen[0].signal?.aborted, true, 'the wait ends when the connection closes');
});
