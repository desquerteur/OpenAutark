// Owns: privacy/auth/image behaviour against a GitHub HTTP fixture. Never: uses live credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { appToken, createIssue, crypt, repository } from '../src/github.ts';
import type { Env, Fetch, Payload } from '../src/types.ts';

test('server key encryption authenticates ciphertext; app JWT is valid and short-lived', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } as Env;
  const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
  const encrypted = await crypt(env, pem);
  assert.equal(encrypted.includes('PRIVATE KEY'), false);
  assert.equal(await crypt(env, encrypted, true), pem);
  await assert.rejects(crypt({ ...env, APP_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') }, encrypted, true));
  env.DB = { prepare: () => ({ bind: (key: string) => ({ first: async () => ({ value: key === 'app_id' ? '123' : encrypted }) }) }) } as unknown as Env['DB'];
  const jwt = (await appToken(env))!;
  const [head, body, signature] = jwt.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.publicKey, Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(claims.iss, '123'); assert.ok(claims.exp - claims.iat <= 600);
  const fetches: string[] = [];
  const run: Fetch = async (input) => {
    const url = String(input); fetches.push(url);
    if (url.endsWith('/installation')) return Response.json({ id: 3 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-only' });
    return Response.json({ private: false, visibility: 'public', has_issues: true });
  };
  Object.assign(env, { GITHUB_OWNER: 'teydra', PRIVATE_REPO: 'teydra/private', PUBLIC_REPO: 'teydra/public' });
  const p: Payload = { requestId: crypto.randomUUID(), visibility: 'private', title: 'Private', body: 'Confidential' };
  await assert.rejects(repository(env, p, run), /visibility/);
  assert.equal(fetches.some((url) => url.includes('/teydra/public')), false, 'private never falls back');
});

test('screenshots go into the same repository before issue creation; no external image host', async () => {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const run: Fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return String(input).includes('/contents/') ? Response.json({}, { status: 201 }) : Response.json({ number: 4, html_url: 'https://github.com/teydra/private/issues/4' }, { status: 201 });
  };
  const p: Payload = { requestId: crypto.randomUUID(), visibility: 'private', title: 'Marked image', body: 'Details', image: { mime: 'image/png', base64: 'fixture-image' } };
  assert.equal(await createIssue(run, { repo: 'teydra/private', token: 'fixture-only' }, p), 'https://github.com/teydra/private/issues/4');
  assert.equal(calls.length, 2); assert.ok(calls[0].url.includes('/teydra/private/contents/'));
  assert.match(calls[1].body.body, /\[Screenshot\]\(https:\/\/github.com\/teydra\/private\/blob\/main/);
  assert.ok(calls[1].body.body.includes(`workforce-feedback:${p.requestId}`));
  await assert.rejects(createIssue(async () => Response.json({}, { status: 403 }), { repo: 'teydra/private', token: 'fixture-only' }, p), /Screenshot/);
});
