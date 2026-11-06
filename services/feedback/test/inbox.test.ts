// Owns: receiver behaviour against real SQLite with a GitHub fixture. Never: remote writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { receiver } from '../src/worker.ts';
import type { Database, Env, Payload, Statement } from '../src/types.ts';

class Query implements Statement {
  db: DatabaseSync; sql: string; args: unknown[] = [];
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]): Query { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return this.db.prepare(this.sql).get(...this.args as never[]) as T ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args as never[]) as T[] }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.args as never[]); return { meta: { changes: Number(result.changes) } }; }
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env: Env = { DB: { prepare: (sql) => new Query(db, sql) } as Database, GITHUB_OWNER: 'teydra', PUBLIC_REPO: 'teydra/public', PRIVATE_REPO: 'teydra/private', APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
  const payload: Payload = { requestId: crypto.randomUUID(), visibility: 'private', title: 'Feedback', body: 'Private details that must never be readable.' };
  const post = (p = payload) => new Request('https://feedback.test/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(p) });
  return { db, env, payload, post };
}

test('unconfigured GitHub still durably receives privately; no read/list/image route exists', async () => {
  const f = fixture();
  const server = receiver();
  const response = await server.fetch(f.post(), f.env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { receiptId: f.payload.requestId, state: 'received' });
  assert.equal(f.db.prepare('SELECT payload FROM reports').get()?.payload, JSON.stringify(f.payload));
  for (const route of ['/v1/reports', `/v1/reports/${f.payload.requestId}`, '/v1/attachments/a.png']) {
    const denied = await server.fetch(new Request(`https://feedback.test${route}`), f.env);
    assert.ok([404, 405].includes(denied.status));
    assert.equal((await denied.text()).includes('Private details'), false);
  }
  f.db.close();
});

test('private/public route server-side; private receipt reveals neither issue URL nor report text', async () => {
  const f = fixture(); let creates = 0;
  const server = receiver({ target: async (_env, p) => ({ repo: p.visibility === 'private' ? 'teydra/private' : 'teydra/public', token: 'fixture-only' }),
    create: async (_run, target) => { creates++; return `https://github.com/${target.repo}/issues/1`; } });
  const privateResponse = await server.fetch(f.post(), f.env);
  assert.deepEqual(await privateResponse.json(), { receiptId: f.payload.requestId, state: 'sent' });
  const again = await server.fetch(f.post(), f.env);
  assert.equal(again.status, 200); assert.equal(creates, 1);
  const publicPayload = { ...f.payload, requestId: crypto.randomUUID(), visibility: 'public' as const };
  const publicResponse = await server.fetch(f.post(publicPayload), f.env);
  assert.deepEqual(await publicResponse.json(), { receiptId: publicPayload.requestId, state: 'sent', url: 'https://github.com/teydra/public/issues/1' });
  assert.equal(creates, 2);
  const changed = await server.fetch(f.post({ ...f.payload, visibility: 'public' }), f.env);
  assert.equal(changed.status, 409); assert.equal(creates, 2);
  f.db.close();
});

test('concurrent submissions create one issue; an uncertain create is only reconciled', async () => {
  const f = fixture(); let creates = 0;
  const server = receiver({ target: async () => ({ repo: 'teydra/private', token: 'fixture-only' }),
    create: async () => { creates++; throw new Error('connection lost after GitHub accepted'); },
    run: async () => Response.json([]) });
  const results = await Promise.all([server.fetch(f.post(), f.env), server.fetch(f.post(), f.env)]);
  assert.equal(creates, 1); assert.ok(results.every((r) => r.status === 202));
  await server.fetch(f.post(), f.env);
  assert.equal(creates, 1, 'no blind second create');
  assert.equal(f.db.prepare('SELECT state FROM reports').get()?.state, 'uncertain');
  f.db.close();
});

test('bad images and sender-chosen repositories are refused; repeated new submissions are throttled', async () => {
  const f = fixture(); const server = receiver();
  const invalid = await server.fetch(f.post({ ...f.payload, image: { mime: 'image/png', base64: Buffer.from('<svg/>').toString('base64') } }), f.env);
  assert.equal(invalid.status, 400);
  assert.equal((await server.fetch(f.post({ ...f.payload, repo: 'attacker/target' } as Payload), f.env)).status, 400);
  for (let index = 0; index < 5; index++) assert.equal((await server.fetch(f.post({ ...f.payload, requestId: crypto.randomUUID() }), f.env)).status, 202);
  assert.equal((await server.fetch(f.post(), f.env)).status, 429);
  f.db.close();
});
