// Owns: manifest setup ownership, one-time state and server-only encrypted keys. Never: live registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiver } from '../src/worker.ts';
import { databaseFixture } from './fixture.ts';
import type { Env } from '../src/types.ts';

test('manifest callback accepts only the configured owner, consumes state and never returns a key', async () => {
  for (const owner of ['teydra', 'another-owner']) {
    const { db, binding } = databaseFixture();
    const env: Env = { DB: binding, APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), GITHUB_OWNER: 'teydra', PUBLIC_REPO: 'teydra/public', PRIVATE_REPO: 'teydra/private' };
    let calls = 0;
    const server = receiver({ run: async (_url, options) => {
      calls++;
      assert.equal(new Headers(options?.headers).has('Authorization'), false, 'manifest conversion is unauthenticated');
      return Response.json({ id: 123, slug: 'workforce-feedback', pem: 'fixture-private-key', owner: { login: owner } });
    } });
    const start = await server.fetch(new Request('https://feedback.test/setup'), env);
    assert.equal(start.status, 200);
    const form = await start.text();
    const state = /apps\/new\?state=([^"&]+)/.exec(form)?.[1]; assert.ok(state);
    const callback = () => new Request(`https://feedback.test/setup/callback?state=${state}&code=fixture-code-123`);
    const result = await server.fetch(callback(), env);
    assert.equal(result.status, owner === 'teydra' ? 303 : 403);
    assert.equal((await result.text()).includes('fixture-private-key'), false);
    const saved = db.prepare("SELECT value FROM config WHERE key = 'app_key'").get();
    if (owner === 'teydra') {
      assert.ok(saved); assert.equal(String(saved.value).includes('fixture-private-key'), false);
      assert.equal(result.headers.get('location'), 'https://github.com/apps/workforce-feedback/installations/new');
    } else assert.equal(saved, undefined);
    await server.fetch(callback(), env); assert.equal(calls, 1, 'callback is never converted twice');
    db.close();
  }
});
