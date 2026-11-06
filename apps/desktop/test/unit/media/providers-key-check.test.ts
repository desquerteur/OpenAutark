// B-058 i1 (t6 review cross-track 4): the account check of a media-only key – ElevenLabs GET {base}/user with
// xi-api-key, fal GET api.fal.ai/v1/models/pricing with `Authorization: Key …` (official docs, 30.10.2026). 200 'ok',
// 401 'needs_login', 403 a valid scope-restricted key ('ok'), anything else unknown: a rejected key stays rejected,
// any other stays 'ok'. Fake servers on 127.0.0.1 and a fake fetch only – no real provider, no real key.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FAL_PLATFORM, keyProbe, mediaKeyState, probeMediaKey } from '../../../src/runtime/media/providers/key-check.ts';
import { harness } from '../accounts/harness.ts';

const GOOD = 'test-good-key-0123456789';
const SCOPED = 'test-scoped-key-0123456789';

test('keyProbe: the documented request per provider; no probe for a custom fal host', () => {
  assert.deepEqual(keyProbe({ provider: 'elevenlabs' }, 'k'), { url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': 'k' } });
  assert.equal(keyProbe({ provider: 'elevenlabs', baseUrl: 'https://api.eu.residency.elevenlabs.io/v1/' }, 'k')?.url, 'https://api.eu.residency.elevenlabs.io/v1/user');
  assert.deepEqual(keyProbe({ provider: 'fal' }, 'k'), { url: `${FAL_PLATFORM}/models/pricing?endpoint_id=fal-ai%2Fz-image%2Fturbo`, headers: { authorization: 'Key k' } });
  assert.equal(FAL_PLATFORM, 'https://api.fal.ai/v1');
  assert.equal(keyProbe({ provider: 'fal', baseUrl: 'https://fal-proxy.example.com' }, 'k'), undefined, 'a proxy\'s key never goes to fal');
  assert.equal(keyProbe({ provider: 'elevenlabs', baseUrl: 'http://example.com/v1' }, 'k'), undefined, 'no plain-HTTP host');
  assert.equal(keyProbe({ provider: 'openai' }, 'k'), undefined);
});

async function fakeProvider() {
  const seen: Array<{ method?: string; url?: string; headers: IncomingMessage['headers'] }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const key = String(req.headers['xi-api-key'] ?? req.headers.authorization ?? '').replace(/^Key /, '');
    const status = key === GOOD ? 200 : key === SCOPED ? 403 : key === 'boom' ? 503 : 401;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? '{"user_id":"u1","prices":[]}' : '{"detail":{"status":"invalid_api_key"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

test('probeMediaKey against fake ElevenLabs and fal servers: 200 ok, 401 needs_login, 403 ok, 503 / offline / no vault answer unknown', async () => {
  const fake = await fakeProvider();
  try {
    const eleven = { provider: 'elevenlabs' as const, baseUrl: `${fake.base}/v1` };
    const key = (value: string | undefined) => async () => value;
    assert.equal(await probeMediaKey(eleven, key(GOOD)), 'ok');
    assert.deepEqual([fake.seen[0].method, fake.seen[0].url, fake.seen[0].headers['xi-api-key']], ['GET', '/v1/user', GOOD]);
    assert.equal(fake.seen[0].headers.authorization, undefined, 'the key only in its own header');
    assert.equal(await probeMediaKey(eleven, key('wrong')), 'needs_login');
    assert.equal(await probeMediaKey(eleven, key(SCOPED)), 'ok', '403: a valid key restricted to other endpoints');
    assert.equal(await probeMediaKey(eleven, key('boom')), undefined, 'a provider outage says nothing about the key');
    assert.equal(await probeMediaKey(eleven, key(undefined)), 'needs_login', 'no saved key');
    assert.equal(await probeMediaKey(eleven, async () => { throw new Error('vault locked'); }), undefined);
    assert.equal(await probeMediaKey(eleven, key(GOOD), async () => { throw new Error('offline'); }), undefined);

    const fal = { provider: 'fal' as const };
    const before = fake.seen.length;
    assert.equal(await probeMediaKey(fal, key(GOOD), undefined, `${fake.base}/v1`), 'ok');
    assert.deepEqual([fake.seen[before].url, fake.seen[before].headers.authorization], ['/v1/models/pricing?endpoint_id=fal-ai%2Fz-image%2Fturbo', `Key ${GOOD}`]);
    assert.equal(await probeMediaKey(fal, key('wrong'), undefined, `${fake.base}/v1`), 'needs_login');

    assert.equal(await mediaKeyState({ ...eleven, state: 'needs_login' }, key('boom')), 'needs_login', 'unknown keeps a rejected key rejected');
    assert.equal(await mediaKeyState({ ...eleven, state: 'unknown' }, key('boom')), 'ok', 'unknown leaves any other key usable (as before)');
  } finally { fake.close(); }
});

test('AccountService.check: a wrong ElevenLabs or fal key needs a new key; offline keeps the state; only the provider host is asked', async () => {
  const asked: Array<{ url: string; key?: string }> = [];
  let online = true;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (!online) throw new TypeError('fetch failed');
    const headers = new Headers(init.headers);
    const key = (headers.get('xi-api-key') ?? headers.get('authorization') ?? '').replace(/^Key /, '');
    asked.push({ url, key });
    if (!/^https:\/\/api\.(?:elevenlabs\.io\/v1\/user|fal\.ai\/v1\/models\/pricing\?)/.test(url)) return new Response('', { status: 404 });
    return new Response('{}', { status: key === GOOD ? 200 : 401 });
  };
  const h = harness({ fetch });
  try {
    for (const provider of ['elevenlabs', 'fal'] as const) {
      const wrong = await h.service.add({ provider, apiKey: 'test-wrong-key-0123456789' });
      await h.settle();
      assert.equal((await h.service.check(wrong.id)).state, 'needs_login', `${provider}: a wrong key`);
      online = false;
      assert.equal((await h.service.check(wrong.id)).state, 'needs_login', `${provider}: offline keeps it`);
      online = true;
      const right = await h.service.add({ provider, apiKey: GOOD });
      await h.settle();
      assert.equal((await h.service.check(right.id)).state, 'ok', `${provider}: a valid key`);
      assert.ok(!h.checks.includes(right.id), `${provider}: no engine check`);
    }
    const probes = asked.filter((call) => call.key);
    assert.ok(probes.length >= 4);
    for (const call of probes) assert.match(call.url, /^https:\/\/api\.(?:elevenlabs\.io|fal\.ai)\//, 'the key goes to its provider only');
  } finally { await h.service.dispose(); }
});
