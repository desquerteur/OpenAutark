// B-050 K8 (d) on the real HttpServer (fake RPC behind it): POST /rpc with a bearer token runs one
// request with the token's scope (the /ws Hello's tokens: owner from this PC, device, connector), 401
// without a valid token, 403 for a revoked one, and without the header the tokenless path stays;
// GET /events streams Server-Sent Events – `ready`, then each event with message payloads carrying
// author, chat and level – needs a token and valid topics, refuses a foreign Origin, and its RPC
// connection is detached when the reader goes; a connector's /ws socket gets the same message view;
// a wrong bearer token counts in the per-address limit on both routes (429 before any token lookup).
// Owns: these checks. Never: opens a socket beyond loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { handleBearerRpc } from '../../../src/runtime/http/rpc.ts';
import { RateLimiter } from '../../../src/runtime/http/security.ts';
import { EventStreams } from '../../../src/runtime/http/sse.ts';
import { DEVICE_TOKEN, LAUNCH_TOKEN, REMOVED_TOKEN, fixture, nextMessage, openSocket, request } from './fixture.ts';

const CONNECTOR = `wfx_${'B'.repeat(43)}`;
const MEMBER = 'ext:api:0123456789:Bridge';
const CHAT = 'ch_01jab3k9z7mx2c4q';

function withConnector() {
  const f = fixture();
  (f.services as unknown as { chats: Record<string, unknown> }).chats.members = (conversationId: string) =>
    conversationId === CHAT ? [{ memberId: MEMBER, kind: 'external', role: 'member', joinedAt: 0, readSeq: 0 }] : [];
  f.services.db.run('INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['tok_connector001', MEMBER, 'external-agent', createHash('sha256').update(CONNECTOR).digest('hex'), JSON.stringify({ conversationId: CHAT }), 'Bridge', 1000]);
  return f;
}

const call = (port: number, token: string | undefined, body: unknown, headers: Record<string, string> = {}) => request(port, {
  method: 'POST', path: '/rpc', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});

test('POST /rpc with a bearer token: one call with its scope; 401 unknown, 403 revoked; the tokenless path stays', async () => {
  const f = withConnector();
  try {
    const { port } = await f.server.listen();
    const owner = await call(port, LAUNCH_TOKEN, { id: 7, method: 'chats.list' });
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.json(), { id: 7, result: { method: 'chats.list', scope: 'owner' } });
    assert.equal(f.rpc.detached, 1, 'the one-shot connection is closed after its answer');
    assert.deepEqual((await call(port, DEVICE_TOKEN, { id: 1, method: 'todos.list' })).json().result, { method: 'todos.list', scope: 'device' });
    assert.deepEqual((await call(port, CONNECTOR, { method: 'messages.list', params: { conversationId: CHAT } })).json(), { id: 0, result: { method: 'messages.list', scope: 'external' } });
    assert.equal(f.rpc.attached.at(-1)?.scope.kind, 'external');

    const unknown = await call(port, 'not-a-known-token-0123456789', { id: 1, method: 'chats.list' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.headers['www-authenticate'], 'Bearer');
    assert.equal((await call(port, REMOVED_TOKEN, { id: 1, method: 'chats.list' })).status, 403);
    assert.equal((await call(port, LAUNCH_TOKEN, ['not', 'a', 'frame'])).status, 400);
    assert.equal((await request(port, { path: '/rpc', headers: { authorization: `Bearer ${LAUNCH_TOKEN}` } })).status, 405);

    const tokenless = await call(port, undefined, { id: 2, method: 'pwa.exchange', params: { secret: 's' } });
    assert.equal(tokenless.status, 200);
    assert.equal(tokenless.json().result.token, 'new-device-token');
    assert.equal(f.rpc.http.length, 1, 'only the call without a token took the pairing path');
  } finally {
    await f.close();
  }
});

/** Opens GET /events and collects its text until `until` holds (or 5 s pass). */
function stream(port: number, path: string, headers: Record<string, string>) {
  let text = '';
  let response: IncomingMessage | undefined;
  const waiters: Array<{ until: (text: string) => boolean; resolve: () => void }> = [];
  const req = httpRequest({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
      for (const waiter of [...waiters]) if (waiter.until(text)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return {
    get text() { return text; },
    get status() { return response?.statusCode; },
    get headers() { return response?.headers; },
    wait(until: (text: string) => boolean): Promise<void> {
      if (until(text)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stream wait timed out: ${text}`)), 5_000);
        waiters.push({ until, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    close() { req.destroy(); },
  };
}

/** The events written as `event:` / `data:` pairs. */
const events = (text: string) => text.split('\n\n').map((block) => {
  const event = /^event: (.+)$/m.exec(block)?.[1];
  const data = /^data: (.+)$/m.exec(block)?.[1];
  return event ? { event, data: data ? JSON.parse(data) : undefined } : undefined;
}).filter((entry): entry is { event: string; data: any } => entry !== undefined);

test('GET /events: ready, then events with author, chat and level; the connection goes with the reader', async () => {
  const f = withConnector();
  try {
    const { port } = await f.server.listen();
    const sse = stream(port, `/events?topics=chat:${CHAT},chats`, { authorization: `Bearer ${LAUNCH_TOKEN}` });
    await sse.wait((text) => text.includes('event: ready'));
    assert.equal(sse.status, 200);
    assert.equal(sse.headers?.['content-type'], 'text/event-stream; charset=utf-8');
    assert.deepEqual(events(sse.text)[0], { event: 'ready', data: { topics: [`chat:${CHAT}`, 'chats'] } });
    const attached = f.rpc.attached.at(-1)!;
    assert.equal(attached.scope.kind, 'owner');
    attached.connection.send({
      event: 'message.created',
      data: { id: 'msg_1', conversationId: CHAT, seq: 4, authorId: 'human', authorKind: 'human', kind: 'text', body: 'Hi', attachments: [], mentions: [], priority: 'normal', silent: true, state: 'final', meta: {}, createdAt: 1 },
    });
    attached.connection.send({ event: 'conversation.removed', data: { id: 'ch_gone' } });
    await sse.wait((text) => text.includes('conversation.removed'));
    const [created, removed] = events(sse.text).slice(1);
    assert.equal(created.event, 'message.created');
    assert.deepEqual([created.data.id, created.data.level, created.data.author, created.data.chat.id], ['msg_1', 'silent', { id: 'human', kind: 'human', name: 'Owner' }, CHAT]);
    assert.deepEqual(removed, { event: 'conversation.removed', data: { id: 'ch_gone' } });
    const before = f.rpc.detached;
    sse.close();
    for (let i = 0; i < 100 && f.rpc.detached === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.rpc.detached, before + 1, 'the reader went: its RPC connection is detached');
  } finally {
    await f.close();
  }
});

test('GET /events refuses a missing token, bad topics and a foreign Origin; a connector streams too', async () => {
  const f = withConnector();
  try {
    const { port } = await f.server.listen();
    assert.equal((await request(port, { path: '/events?topics=chats' })).status, 401);
    assert.equal((await request(port, { path: '/events?topics=chats', headers: { authorization: `Bearer ${REMOVED_TOKEN}` } })).status, 403);
    assert.equal((await request(port, { path: '/events', headers: { authorization: `Bearer ${LAUNCH_TOKEN}` } })).status, 400);
    assert.equal((await request(port, { path: '/events?topics=nonsense', headers: { authorization: `Bearer ${LAUNCH_TOKEN}` } })).status, 400);
    assert.equal((await request(port, { path: '/events?topics=chats', headers: { authorization: `Bearer ${LAUNCH_TOKEN}`, origin: 'https://evil.example' } })).status, 403);
    const sse = stream(port, `/events?topics=chat:${CHAT}`, { authorization: `Bearer ${CONNECTOR}` });
    await sse.wait((text) => text.includes('event: ready'));
    assert.equal(f.rpc.attached.at(-1)?.scope.kind, 'external');
    sse.close();
  } finally {
    await f.close();
  }
});

test('/ws: a connector socket gets message events with author, chat and level; the desktop window does not', async () => {
  const f = withConnector();
  try {
    const { port } = await f.server.listen();
    const message = { id: 'msg_2', conversationId: CHAT, seq: 5, authorId: MEMBER, authorKind: 'external', kind: 'text', body: 'Hi', attachments: [], mentions: [], priority: 'important', silent: false, state: 'final', meta: {}, createdAt: 1 };
    const connector = await openSocket(`ws://127.0.0.1:${port}/ws`);
    connector.send(JSON.stringify({ protocol: 1, token: CONNECTOR, client: 'external' }));
    connector.send(JSON.stringify({ id: 1, method: 'chats.get', params: { id: CHAT } }));
    await nextMessage(connector);
    f.rpc.attached.at(-1)!.connection.send({ event: 'message.created', data: message });
    const seen = await nextMessage(connector);
    assert.deepEqual([seen.data.level, seen.data.author, seen.data.chat.id], ['important', { id: MEMBER, kind: 'external', name: 'Bridge' }, CHAT]);
    connector.close();
    const desktop = await openSocket(`ws://127.0.0.1:${port}/ws`);
    desktop.send(JSON.stringify({ protocol: 1, token: LAUNCH_TOKEN, client: 'desktop' }));
    desktop.send(JSON.stringify({ id: 1, method: 'chats.list' }));
    await nextMessage(desktop);
    f.rpc.attached.at(-1)!.connection.send({ event: 'message.created', data: message });
    const plain = await nextMessage(desktop);
    assert.equal(plain.data.level, undefined, "the app's own windows get the stored message as it is");
    desktop.close();
  } finally {
    await f.close();
  }
});

test('a wrong bearer token counts in the per-address limit: POST /rpc and GET /events answer 429 before any token lookup', async () => {
  const limiter = new RateLimiter(2, 60_000);
  let lookups = 0;
  const scope = () => { lookups++; return undefined; };
  const streams = new EventStreams({ rpc: {} as never, services: () => ({}) as never, log: () => ({}) as never });
  const server = createServer((req, res) => {
    const info = { url: new URL(req.url ?? '/', 'http://127.0.0.1'), remote: '10.0.0.9', loopback: false, local: '10.0.0.1' };
    if (info.url.pathname === '/rpc') void handleBearerRpc(req, res, info, { rpc: {} as never, limiter, log: () => ({}) as never, scope });
    else streams.serve(req, res, info, scope, limiter);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const guess = { authorization: 'Bearer wrong-token-0123456789' };
    assert.equal((await call(port, 'wrong-token-0123456789', { id: 1, method: 'chats.list' })).status, 401);
    assert.equal((await request(port, { path: '/events?topics=chats', headers: guess })).status, 401);
    assert.equal((await call(port, 'wrong-token-0123456789', { id: 1, method: 'chats.list' })).status, 429);
    assert.equal((await request(port, { path: '/events?topics=chats', headers: guess })).status, 429);
    assert.equal(lookups, 2, 'throttled requests look up no token');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
