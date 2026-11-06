// Wire side of connectors: an entry's headers are filled once per connection and an Authorization of its own replaces
// the sign-in's; retire() lets a running call finish; close() aborts
// a hanging handshake (connections.ts); the HTTP wire's header-build failures (nothing sent), a 400 session expiry and
// SSE resumption (client/http.ts); tools/call deadlines renewed by progress (client/session.ts); the OAuth URL rule for
// apps not on this PC, checked redirects and registration auth methods (oauth/*).
// Owns: these assertions. Never: a real server (fetch and connections are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { AppConnections, setHeader } from '../../../src/runtime/apps/connections.ts';
import { HttpWire } from '../../../src/runtime/apps/client/http.ts';
import { McpSession, McpTimeout } from '../../../src/runtime/apps/client/session.ts';
import type { RpcReply, RpcRequest, Wire } from '../../../src/runtime/apps/client/rpc.ts';
import { McpTransportError, type Connector, type McpConnection, type McpConnectOptions, type McpTarget } from '../../../src/runtime/apps/types.ts';
import { callJson, endpointUrl } from '../../../src/runtime/apps/oauth/http.ts';
import { discover } from '../../../src/runtime/apps/oauth/discover.ts';
import { askedAuthMethod, authMethodOf } from '../../../src/runtime/apps/oauth/register.ts';
import { ManualTimers } from './service-fakes.ts';

const CLIENT = { name: 'workforce', version: '0.2.0' };

function connector(patch: Partial<Connector> = {}): Connector {
  return { id: 'linear', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true, fingerprint: 'f', ...patch };
}

function connections(current: Connector, connect: (target: McpTarget, opts: McpConnectOptions) => Promise<McpConnection>, resolved: string[] = []) {
  return new AppConnections({
    connect, clientInfo: CLIENT, oauth: { authHeaders: async () => ({ authorization: 'Bearer fresh' }) },
    resolve: async (text) => { resolved.push(text); return text.replace('secret://team', 'team-1').replace('secret://key', 'k-123'); },
    mailServers: async () => { throw new Error('no mail here'); },
    connector: () => current, onToolsChanged: () => {}, timers: new ManualTimers(), env: {}, platform: 'linux',
  });
}

function fakeConn(): McpConnection & { closed: boolean } {
  const conn = {
    closed: false, info: { protocolVersion: '2025-11-25' },
    listTools: async () => [], callTool: async () => ({ content: [] }), onToolsChanged: () => () => {},
    close: async () => { conn.closed = true; },
  };
  return conn as unknown as McpConnection & { closed: boolean };
}

test('headers: filled once per connection; without an Authorization of its own the sign-in\'s goes along; one value per name', async () => {
  const resolved: string[] = [];
  const current = connector({ headers: { 'X-Team': 'secret://team' } });
  let target: McpTarget | undefined;
  const conns = connections(current, async (t) => { target = t; return fakeConn(); }, resolved);
  await conns.use(current, async () => undefined);
  const headers = await (target as { headers: () => Promise<Record<string, string>> }).headers();
  assert.deepEqual(headers, { 'X-Team': 'team-1', authorization: 'Bearer fresh' });
  await (target as { headers: () => Promise<Record<string, string>> }).headers();
  assert.equal(resolved.length, 1, 'the entry\'s headers were filled once for this connection');
  const own = connector({ headers: { Authorization: 'secret://key' } });
  let ownTarget: McpTarget | undefined;
  await connections(own, async (t) => { ownTarget = t; return fakeConn(); }).use(own, async () => undefined);
  assert.deepEqual(await (ownTarget as { headers: () => Promise<Record<string, string>> }).headers(), { Authorization: 'Bearer k-123' }, 'its own key wins, a bare token gets Bearer');
  const out: Record<string, string> = { Authorization: 'a' };
  setHeader(out, 'authorization', 'b');
  assert.deepEqual(out, { authorization: 'b' });
});

test('retire: a running call finishes on the old connection, the next use opens a fresh one; close aborts a hanging handshake', async () => {
  const current = connector();
  const opened: Array<McpConnection & { closed: boolean }> = [];
  const conns = connections(current, async () => { const conn = fakeConn(); opened.push(conn); return conn; });
  let release!: () => void;
  const running = conns.use(current, () => new Promise<string>((resolve) => { release = () => resolve('done'); }));
  await new Promise((resolve) => setImmediate(resolve));
  await conns.retire(current.id);
  assert.equal(opened[0].closed, false, 'the running call keeps its connection');
  await conns.use(current, async () => undefined);
  assert.equal(opened.length, 2, 'a fresh connection for new uses');
  release();
  assert.equal(await running, 'done');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened[0].closed, true, 'ended once its call was done');

  let aborted = false;
  const hanging = connections(current, (_t, opts) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => { aborted = true; reject(new McpTransportError('aborted', false)); });
  }));
  const use = hanging.use(current, async () => undefined).catch((error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await hanging.close(current.id);
  assert.ok(aborted && Date.now() - started < 1_000, 'close does not wait for the handshake');
  assert.ok(await use instanceof McpTransportError);
});

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const call: RpcRequest = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x', arguments: {} } };

test('HTTP wire: a header-building failure sent nothing; duplicate spellings become one header', async () => {
  const failing = new HttpWire({ kind: 'http', url: 'https://app.example/mcp', headers: async () => { throw new WorkforceError('unavailable', 'The sign-in server could not be reached.'); } },
    { fetch: async () => { throw new Error('never'); }, incoming: () => {} });
  await assert.rejects(failing.send(call, new AbortController().signal, true), (error: unknown) => error instanceof McpTransportError && error.sent === false);
  let seen: Record<string, string> = {};
  const wire = new HttpWire({ kind: 'http', url: 'https://app.example/mcp', headers: async () => ({ Authorization: 'old', authorization: 'new' }) },
    { fetch: async (_url, init) => { seen = init!.headers as Record<string, string>; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }), { headers: { 'content-type': 'application/json' } }); }, incoming: () => {} });
  await wire.send(call, new AbortController().signal, true);
  assert.deepEqual(Object.keys(seen).filter((key) => key.toLowerCase() === 'authorization').map((key) => seen[key]), ['new']);
});

test('HTTP wire: an SSE answer stream closed after an event id is resumed with GET and Last-Event-ID', async () => {
  const asked: Array<{ method: string; headers: Record<string, string> }> = [];
  const wire = new HttpWire({ kind: 'http', url: 'https://app.example/mcp' }, {
    incoming: () => {},
    fetch: async (_url, init) => {
      asked.push({ method: String(init!.method), headers: init!.headers as Record<string, string> });
      if (init!.method === 'POST') return sse('retry: 0\nid: e1\ndata:\n\n');
      return sse(`id: e2\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } })}\n\n`);
    },
  });
  const reply = await wire.send(call, new AbortController().signal, true);
  assert.deepEqual(reply.result, { ok: true });
  assert.deepEqual(asked.map((entry) => entry.method), ['POST', 'GET']);
  assert.equal(asked[1].headers['Last-Event-ID'], 'e1');
  assert.equal(asked[1].headers.Accept, 'text/event-stream');
  const ended = new HttpWire({ kind: 'http', url: 'https://app.example/mcp' }, { incoming: () => {}, fetch: async () => sse('data: {"jsonrpc":"2.0","method":"x"}\n\n') });
  await assert.rejects(ended.send(call, new AbortController().signal, true), /closed the connection without an answer/, 'no event id: nothing to resume');
});

test('a 400 to a request with a session (no other cause) is an expired session: initialized again, the request once more', async () => {
  const methods: string[] = [];
  let lists = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { id?: number; method: string };
    methods.push(body.method);
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } }),
        { headers: { 'content-type': 'application/json', 'mcp-session-id': `s${methods.length}` } });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    lists += 1;
    if (lists === 1) return new Response('Bad Request: No valid session ID provided', { status: 400, headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }), { headers: { 'content-type': 'application/json' } });
  };
  const session = new McpSession({ clientInfo: CLIENT, transport: 'http' });
  session.attach(new HttpWire({ kind: 'http', url: 'https://app.example/mcp' }, { fetch: fetchFn, incoming: session.incoming }));
  await session.open();
  assert.deepEqual(await session.listTools(), []);
  assert.deepEqual(methods.filter((method) => method === 'initialize').length, 2);
});

/** A wire that answers initialize at once and tools/call after `ms`, sending progress every `every` ms (0: none). */
function slowWire(session: McpSession, ms: number, every: number): Wire & { calls: RpcRequest[] } {
  const calls: RpcRequest[] = [];
  return {
    calls,
    async send(message, signal) {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } } as RpcReply;
      calls.push(message);
      const token = (message.params?._meta as { progressToken?: number } | undefined)?.progressToken;
      return new Promise<RpcReply>((resolve, reject) => {
        const tick = every ? setInterval(() => session.incoming({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1 } }), every) : undefined;
        const done = setTimeout(() => { clearInterval(tick); resolve({ jsonrpc: '2.0', id: message.id, result: { content: [] } }); }, ms);
        signal.addEventListener('abort', () => { clearInterval(tick); clearTimeout(done); reject(signal.reason); }, { once: true });
      });
    },
    async deliver() {}, negotiated() {}, reset() {}, hint: () => undefined, async close() {},
  };
}

test('tools/call: a progressToken rides along, every progress renews the deadline; without progress the deadline holds', async () => {
  const session = new McpSession({ clientInfo: CLIENT, transport: 'stdio' });
  const wire = slowWire(session, 150, 25);
  session.attach(wire);
  await session.open();
  await session.callTool('analyse', {}, { timeoutMs: 60 });
  assert.equal(typeof (wire.calls[0].params?._meta as { progressToken?: unknown }).progressToken, 'number');
  const quiet = new McpSession({ clientInfo: CLIENT, transport: 'stdio' });
  quiet.attach(slowWire(quiet, 150, 0));
  await quiet.open();
  await assert.rejects(quiet.callTool('analyse', {}, { timeoutMs: 60 }), McpTimeout);
});

test('OAuth URL rule: an app not on this PC never leads to this PC, a private address or through an unchecked redirect', async () => {
  assert.ok(endpointUrl('http://127.0.0.1:9/x'), 'a local app may use this PC');
  for (const bad of ['http://127.0.0.1:9/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'https://192.168.1.1/', 'https://[::1]/x']) {
    assert.equal(endpointUrl(bad, false), undefined, bad);
  }
  assert.ok(endpointUrl('https://mcp.notion.com/.well-known/oauth-protected-resource', false));
  let fetched = 0;
  const never: typeof fetch = async () => { fetched += 1; return new Response('{}'); };
  await assert.rejects(discover(never, 'https://app.example/mcp', 'http://127.0.0.1:33999/meta'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  assert.equal(fetched, 0, 'the local metadata address is never fetched');
  const redirects: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'manual');
    return String(url).startsWith('https://app.example/') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) : new Response('{}');
  };
  await assert.rejects(callJson(redirects, 'https://app.example/.well-known/x', { method: 'GET' }, 'X'), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
});

test('registration: a public client unless the server lists only secret methods; the answer\'s method wins, none stays none', () => {
  assert.equal(askedAuthMethod(undefined), 'none');
  assert.equal(askedAuthMethod(['client_secret_basic', 'none']), 'none');
  assert.equal(askedAuthMethod(['client_secret_basic', 'client_secret_post']), 'client_secret_basic', 'Supabase lists no "none"');
  assert.equal(askedAuthMethod(['client_secret_post']), 'client_secret_post');
  assert.equal(authMethodOf('none', true, 'none'), 'none', 'a secret with method none is never used');
  assert.equal(authMethodOf('client_secret_post', true, 'client_secret_basic'), 'client_secret_post');
  assert.equal(authMethodOf(undefined, true, 'none', ['client_secret_post']), 'client_secret_post');
  assert.equal(authMethodOf(undefined, false, 'client_secret_basic'), 'none', 'no secret issued');
});
