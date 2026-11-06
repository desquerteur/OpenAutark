// The iPhone web app's streams, HTTP and WebSocket (src/ui/hosted/streams.ts, http.ts, ws.ts) against the runtime's
// real phone bridge end (rendezvous/phone.ts serveStreams) and a local node:http server with a `ws` server at /ws:
// Content-Length, chunked, 304, Range/206, a 3 MB body under the 256 KiB window, 40 parallel requests through the six
// HTTP slots (never more than 24 streams at the PC), and WebSocket text, fragments, ping and close code 4403. The
// response parser also gets bodies read until the end and chunks split at every byte.
// Owns: these assertions. Never: a meeting server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { acceptSecure, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { serveStreams } from '../../../src/runtime/devices/rendezvous/phone.ts';
import { connectChannel } from '../../../src/ui/hosted/channel.ts';
import { fromLatin1, fromUtf8, latin1 } from '../../../src/ui/hosted/bytes.ts';
import { headerOf, httpFetch, requestHead, responseParser, type HttpHead } from '../../../src/ui/hosted/http.ts';
import { StreamMux } from '../../../src/ui/hosted/streams.ts';
import { StreamSocket } from '../../../src/ui/hosted/ws.ts';
import { silentLog } from '../devices/fakes.ts';
import { pcIdentity, phoneKey, tunnelPair, until } from './rig.ts';

const BIG = Buffer.alloc(3 * 1024 * 1024 + 17, 9);

async function rig(t: { after(fn: () => void): void }) {
  let active = 0;
  let maxActive = 0;
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/len') { res.setHeader('content-length', '5'); res.end('hello'); return; }
    if (url.pathname === '/chunked') { res.setHeader('transfer-encoding', 'chunked'); res.write('ab'); setTimeout(() => { res.write('cde'); res.end('f'); }, 5); return; }
    if (url.pathname === '/etag') {
      if (req.headers['if-none-match'] === '"v1"') { res.statusCode = 304; res.end(); return; }
      res.setHeader('etag', '"v1"'); res.setHeader('content-length', '4'); res.end('body'); return;
    }
    if (url.pathname === '/range') {
      const all = Buffer.from('0123456789abcdef');
      const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
      if (!m) { res.end(all); return; }
      const part = all.subarray(Number(m[1]), Number(m[2]) + 1);
      res.writeHead(206, { 'content-range': `bytes ${m[1]}-${m[2]}/${all.length}`, 'content-length': String(part.length) });
      res.end(part); return;
    }
    if (url.pathname === '/big') { res.setHeader('content-length', String(BIG.length)); res.end(BIG); return; }
    if (url.pathname === '/post') { const parts: Buffer[] = []; req.on('data', (d) => parts.push(d)); req.on('end', () => res.end(`got ${Buffer.concat(parts).length}`)); return; }
    if (url.pathname === '/slow') { setTimeout(() => res.end(url.searchParams.get('i') ?? ''), 20); return; }
    res.statusCode = 404; res.end();
  });
  server.on('connection', (socket) => { active++; maxActive = Math.max(maxActive, active); socket.on('close', () => { active--; }); });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const origins: Array<string | undefined> = [];
  wss.on('connection', (ws, req) => {
    origins.push(req.headers.origin);
    ws.on('pong', () => ws.send('ponged'));
    ws.on('message', (data) => {
      const text = data.toString();
      if (text === 'frag') { ws.send('ab', { fin: false }); ws.send('cd', { fin: true }); }
      else if (text === 'ping') ws.ping('p');
      else if (text === 'close') ws.close(4403, 'removed');
      else ws.send(`echo ${text}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(() => { wss.close(); server.close(); server.closeAllConnections(); });
  const pc = await pcIdentity();
  const key = await phoneKey();
  const pair = await tunnelPair();
  const accepted = acceptSecure(pair.runtime as SocketLike, pc, () => 'dev_phone0000000001');
  const channel = await connectChannel(pair.hosted, { key, deviceId: 'dev_phone0000000001' }, pc.publicKey);
  serveStreams(await accepted, () => port, silentLog);
  const mux = new StreamMux(channel);
  return { mux, channel, seen, origins, maxActive: () => maxActive };
}

const text = (body: Uint8Array) => fromUtf8(body);

test('HTTP over a stream: length, chunked, 304, Range/206, a POST body, and what the PC sees', async (t) => {
  const { mux, seen } = await rig(t);
  const len = await httpFetch(mux, { method: 'GET', path: '/len', headers: [['Accept', '*/*'], ['Origin', 'https://site.example'], ['Cookie', 'a=b']] });
  assert.equal(len.head.status, 200);
  assert.equal(text(len.body), 'hello');
  assert.equal(seen[0].host, '127.0.0.1');
  assert.equal(seen[0].origin, undefined, 'no Origin reaches the PC');
  assert.equal(seen[0].cookie, undefined);
  assert.equal(seen[0]['accept-encoding'], undefined, 'identity bodies');
  const chunked = await httpFetch(mux, { method: 'GET', path: '/chunked' });
  assert.equal(text(chunked.body), 'abcdef');
  assert.equal(headerOf(chunked.head, 'transfer-encoding'), undefined, 'hop-by-hop headers are dropped');
  const first = await httpFetch(mux, { method: 'GET', path: '/etag' });
  assert.equal(headerOf(first.head, 'etag'), '"v1"');
  const again = await httpFetch(mux, { method: 'GET', path: '/etag', headers: [['If-None-Match', '"v1"']] });
  assert.equal(again.head.status, 304);
  assert.equal(again.body.length, 0);
  const range = await httpFetch(mux, { method: 'GET', path: '/range', headers: [['Range', 'bytes=2-5']] });
  assert.equal(range.head.status, 206);
  assert.equal(text(range.body), '2345');
  assert.equal(headerOf(range.head, 'content-range'), 'bytes 2-5/16');
  const post = await httpFetch(mux, { method: 'POST', path: '/post', body: new Uint8Array(100_000) });
  assert.equal(text(post.body), 'got 100000');
  const head = await httpFetch(mux, { method: 'HEAD', path: '/len' });
  assert.equal(head.body.length, 0);
});

test('a 3 MB body under the window, and 40 parallel requests through six slots', async (t) => {
  const { mux, maxActive } = await rig(t);
  const big = await httpFetch(mux, { method: 'GET', path: '/big' });
  assert.equal(big.body.length, BIG.length);
  assert.ok(big.body.every((b) => b === 9));
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, mux.taken); }, 1);
  const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => httpFetch(mux, { method: 'GET', path: `/slow?i=${i}` })));
  clearInterval(watch);
  assert.deepEqual(answers.map((a) => text(a.body)), Array.from({ length: 40 }, (_, i) => String(i)));
  assert.ok(most <= 6, `slots taken ${most}`);
  assert.ok(maxActive() <= 24, `streams at the PC ${maxActive()}`);
  await until(() => mux.open, (n) => n === 0, 'every stream ends');
});

test('WebSocket over a stream: upgrade without Origin, text, fragments, ping, the PC\'s close code', async (t) => {
  const { mux, origins } = await rig(t);
  const socket = new StreamSocket(async () => mux);
  const got: string[] = [];
  let closed: { code: number } | undefined;
  socket.onmessage = (event) => got.push(String(event.data));
  socket.onclose = (event) => { closed = event; };
  await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
  assert.equal(socket.readyState, 1);
  assert.deepEqual(origins, [undefined]);
  socket.send('hi');
  socket.send('frag');
  socket.send('ping');
  socket.send('x'.repeat(70_000));
  await until(() => got.length, (n) => n === 4, 'answers');
  assert.deepEqual(got.slice(0, 2), ['echo hi', 'abcd']);
  assert.deepEqual(got.slice(2).map((text) => (text.length > 100 ? text.length : text)).sort(), ['ponged', 'echo '.length + 70_000].sort());
  socket.send('close');
  await until(() => closed, Boolean, 'close');
  assert.equal(closed!.code, 4403, 'the PC\'s close code reaches lib/rpc.ts');
  const offline = new StreamSocket(async () => undefined);
  const code = await new Promise<number>((resolve) => { offline.onclose = (event) => resolve(event.code); });
  assert.equal(code, 1006);
});


test('the response parser: until the end, chunks split at every byte, a short body fails', () => {
  const run = (raw: string, method = 'GET', step = 1) => {
    let head: HttpHead | undefined; let body = ''; let ended = false; let failed = '';
    const parser = responseParser(method, { head: (h) => { head = h; }, data: (b) => { body += latin1(b); }, end: () => { ended = true; }, fail: (e) => { failed = e.message; } }, () => undefined);
    const bytes = fromLatin1(raw);
    for (let i = 0; i < bytes.length; i += step) parser.data(bytes.slice(i, i + step));
    parser.end();
    return { head, body, ended, failed };
  };
  const plain = run('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nall of it');
  assert.equal(plain.body, 'all of it');
  assert.equal(plain.ended, true);
  const chunked = run('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 99\r\n\r\n3;x=y\r\nabc\r\n10\r\n0123456789abcdef\r\n0\r\nX-T: 1\r\n\r\n');
  assert.equal(chunked.body, 'abc0123456789abcdef');
  assert.equal(headerOf(chunked.head!, 'content-length'), undefined);
  const short = run('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc', 'GET', 4);
  assert.match(short.failed, /early/);
  assert.match(latin1(requestHead({ method: 'POST', path: '/rpc', headers: [['Host', 'evil'], ['X\r\nY', 'z']], body: new Uint8Array(3) })), /^POST \/rpc HTTP\/1\.1\r\nHost: 127\.0\.0\.1\r\nConnection: close\r\nContent-Length: 3\r\n\r\n$/);
});
