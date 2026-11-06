// McpProxy's default forwarder (loopbackFetch) against a real loopback hub – network only on
// 127.0.0.1: a reply held back like a tools/call waiting for an approval is still forwarded (no
// fetch/undici 300 s timeouts: the global fetch is never used to forward), the forward ends when
// the agent hangs up, reply headers are filtered and a hub redirect is not followed.
// Bound keys, Origin, GET and unknown keys: acp.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpProxy } from '../../../src/runtime/engines/acp/mcp-proxy.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('acp: McpProxy forwards a long-held hub reply without fetch, ends the forward when the agent hangs up', async () => {
  const realFetch = globalThis.fetch;
  const slowArrived = deferred();
  const release = deferred();
  const hangArrived = deferred();
  const hangClosed = deferred();
  const hub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (body.includes('"slow"')) {
        slowArrived.resolve();
        void release.promise.then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'm1', 'Set-Cookie': 'a=b', 'X-Other': '1' });
          res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
        });
      } else if (body.includes('"hang"')) {
        res.once('close', () => hangClosed.resolve());
        hangArrived.resolve(); // never answers: the agent gives up first
      } else if (body.includes('"redirect"')) {
        res.writeHead(307, { Location: 'http://127.0.0.1:1/elsewhere' });
        res.end();
      } else {
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const port = (hub.address() as AddressInfo).port;
  const proxy = new McpProxy();
  globalThis.fetch = (() => Promise.reject(new Error('The proxy must not forward through the global fetch.'))) as typeof fetch;
  try {
    const { key, url } = await proxy.endpoint();
    proxy.bind(key, { url: `http://127.0.0.1:${port}/mcp/hubtoken_hubtoken_1`, token: 'hubtoken_hubtoken_1' });
    const post = (method: string, signal?: AbortSignal) => realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"jsonrpc":"2.0","id":1,"method":"${method}"}`, signal });

    const slow = post('slow');
    await slowArrived.promise;
    let settled = false;
    void slow.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the proxy waits as long as the hub holds the reply');
    release.resolve();
    const reply = await slow;
    assert.equal(reply.status, 200);
    assert.equal(await reply.text(), '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
    assert.equal(reply.headers.get('mcp-session-id'), 'm1');
    assert.equal(reply.headers.get('content-type'), 'application/json');
    assert.equal(reply.headers.get('set-cookie'), null);
    assert.equal(reply.headers.get('x-other'), null);

    const agentHangsUp = new AbortController();
    const hang = post('hang', agentHangsUp.signal);
    await hangArrived.promise;
    agentHangsUp.abort();
    await assert.rejects(hang);
    await hangClosed.promise; // the proxy dropped its forward to the hub

    const redirect = await post('redirect');
    assert.equal(redirect.status, 502);
    const empty = await post('ping');
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');
  } finally {
    globalThis.fetch = realFetch;
    proxy.close();
    hub.close();
  }
});
