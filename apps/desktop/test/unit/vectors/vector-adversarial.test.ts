// The vector system under attack: a memory tree is never cut by the folder rules meant for a PC's folders; what looks like a
// secret export stays out of a folder embed; a search embeds nothing new, not even when a file turned into a folder; a model
// change says so instead of "embed it first"; a removed folder leaves whole; paid embedding reaches the spend journal.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { sql } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import { HttpEmbedder, unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';
import { excluded } from '../../../src/runtime/vectors/places.ts';
import { EmbedSpend } from '../../../src/runtime/vectors/spend.ts';

const WORDS = ['invoice', 'server', 'soup', 'contract'];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  queries: string[] = [];
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    (purpose === 'query' ? this.queries : this.documents).push(...texts);
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function world(t: { after(fn: () => void): void }, memoryBelow = 'data') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-vector-attack-'));
  const db = new Db(path.join(dir, 'test.db'));
  db.exec(sql);
  db.exec('CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;');
  const memoryRoot = path.join(dir, memoryBelow, 'memory');
  mkdirSync(memoryRoot, { recursive: true });
  const embedder = new FakeEmbedder();
  let current: Embedder = embedder;
  const system = new VectorSystem({ db, memoryRoot, embedder: () => current, changeDelayMs: 0 });
  t.after(() => { system.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (file: string, body: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); return file; };
  return { dir, db, memoryRoot, embedder, system, write, use: (next: Embedder) => { current = next; } };
}

test('vector.embed ["memory"]: a topic folder named build, a note about tokens and a folder description are memory, nothing hidden is', async (t) => {
  const w = world(t);
  w.write(path.join(w.memoryRoot, 'company', 'build', 'server.md'), '# Build server\nThe build server runs at night.');
  w.write(path.join(w.memoryRoot, 'company', 'token-notes.txt'), 'Notes about invoice tokens.');
  w.write(path.join(w.memoryRoot, 'company', 'logs', 'soup.md'), 'Soup recipe.');
  w.write(path.join(w.memoryRoot, 'company', '_folder.md'), 'What the whole company knows about contract work.');
  w.write(path.join(w.memoryRoot, '.trash', 'old.md'), 'Hidden server note.');
  const result = await w.system.embed(['memory']);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['hidden folder']);
  assert.equal(result.embedded, 4);
  for (const [query, file] of [['build server', 'memory/company/build/server.md'], ['invoice', 'memory/company/token-notes.txt'], ['soup', 'memory/company/logs/soup.md'], ['contract', 'memory/company/_folder.md']]) {
    const found = await w.system.search({ query, in: ['memory'], k: 1 });
    assert.equal(found.hits[0]?.path, file, query);
  }
});

test('vector.embed of a topic folder below memory takes the same rule; the tree may live below app data', async (t) => {
  const w = world(t, path.join('AppData', 'Roaming', 'Workforce'));
  w.write(path.join(w.memoryRoot, 'company', 'dist', 'invoice.md'), 'Invoice note.');
  assert.equal((await w.system.embed(['memory/company/dist'])).embedded, 1);
  const direct = world(t, 'AppData');
  direct.write(path.join(direct.memoryRoot, 'company', 'x.md'), 'Invoice note.');
  const result = await direct.system.embed(['memory']);
  assert.deepEqual(result.skipped, [], 'the tree is never refused for where it lives');
  assert.equal(result.embedded, 1);
});

test('onFileRemoved of a folder drops everything below it and nothing beside it', async (t) => {
  const w = world(t);
  w.write(path.join(w.memoryRoot, 'company', 'topic', 'a.md'), 'Invoice a.');
  w.write(path.join(w.memoryRoot, 'company', 'topic', 'deep', 'b.md'), 'Invoice b.');
  w.write(path.join(w.memoryRoot, 'company', 'topic-2', 'c.md'), 'Invoice c.');
  await w.system.embed(['memory']);
  rmSync(path.join(w.memoryRoot, 'company', 'topic'), { recursive: true });
  w.system.onFileRemoved(path.join(w.memoryRoot, 'company', 'topic'));
  const found = await w.system.search({ query: 'invoice', in: ['memory'] });
  assert.deepEqual(found.hits.map((hit) => hit.path), ['memory/company/topic-2/c.md']);
});

test('what browsers and password managers export stays out of a folder embed; ordinary names stay in', async (t) => {
  for (const name of ['Chrome Passwords.csv', 'Google Passwords.csv', 'Microsoft Edge Passwords.csv', 'logins.csv', 'prod.env', 'api_keys.txt', 'api-key.json', 'bitwarden_export_20261101.json', 'lastpass export.csv', 'keepass-export.xml', '1password-export.csv', 'my passwords.txt']) {
    assert.ok(excluded(name, false), name);
  }
  for (const name of ['server.log', 'yarn.lock', 'package-lock.json', 'app.min.js', 'app.js.map']) assert.equal(excluded(name, false), 'generated', name);
  for (const name of ['env.md', 'token-notes.md', 'environment.ts', 'keyboard.txt', 'password-policy.md', 'export.csv', 'monkey.json', 'tokenizer.json', 'report.txt']) {
    assert.equal(excluded(name, false), undefined, name);
  }
  const w = world(t);
  const folder = path.join(w.dir, 'work');
  w.write(path.join(folder, 'Chrome Passwords.csv'), 'site,user,password,invoice');
  w.write(path.join(folder, 'notes.md'), 'An invoice note.');
  const result = await w.system.embed([folder]);
  assert.equal(result.embedded, 1);
  assert.ok(result.skipped.some((entry) => entry.path.endsWith('Chrome Passwords.csv')), 'skipped and reported');
  assert.equal(w.embedder.documents.some((text) => text.includes('password')), false);
});

test('a search embeds nothing new: a file that became a folder leaves the store, its new files stay unembedded', async (t) => {
  const w = world(t);
  const file = w.write(path.join(w.dir, 'work', 'notes'), 'An invoice note.');
  await w.system.embed([file]);
  w.embedder.documents.length = 0;
  rmSync(file);
  w.write(path.join(file, 'new-file.md'), 'A new invoice note.');
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(file, old, old);
  const found = await w.system.search({ query: 'invoice', in: [path.join(w.dir, 'work')] });
  await w.system.settled();
  assert.deepEqual(w.embedder.documents, [], 'a search never walks a folder');
  assert.deepEqual(found.hits, []);
  assert.equal(statSync(path.join(file, 'new-file.md')).isFile(), true);
});

test('after a model change a search says it is being redone instead of "embed it first"; afterwards it finds again', async (t) => {
  const w = world(t);
  const file = w.write(path.join(w.dir, 'work', 'a.md'), 'An invoice note.');
  await w.system.embed([file]);
  const next = new FakeEmbedder();
  next.id = 'fake:2';
  w.use(next);
  const during = await w.system.search({ query: 'invoice', in: [file] });
  assert.doesNotMatch(during.note ?? '', /embed it first/);
  assert.match(during.note ?? '', /re-embedded/);
  await w.system.settled();
  assert.equal((await w.system.search({ query: 'invoice', in: [file] })).hits.length, 1);
});

test('the HTTP embedder reports what a call used, with the price the provider names', async () => {
  const used: Array<{ tokens: number; costUsd?: number }> = [];
  const answer = (usage: unknown) => async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage }) });
  const make = (usage: unknown) => new HttpEmbedder({ provider: 'p', baseUrl: 'https://api.example.com/v1', model: 'm', remote: true, sendDimensions: false, apiKey: async () => 'k', fetch: answer(usage), onUsage: (entry) => { used.push(entry); } });
  await make({ prompt_tokens: 7, total_tokens: 7 }).embed(['a'], 'document');
  await make({ total_tokens: 9, cost: 0.002 }).embed(['a'], 'document');
  await make({ prompt_tokens: 3, estimated_cost: 0.001 }).embed(['a'], 'document');
  await make(undefined).embed(['a'], 'document');
  assert.deepEqual(used, [{ tokens: 7 }, { tokens: 9, costUsd: 0.002 }, { tokens: 3, costUsd: 0.001 }]);
});

function spendWorld(auth: string, plan?: string) {
  const booked: Array<Record<string, unknown>> = [];
  const services = {
    spend: { record: (entry: Record<string, unknown>) => { booked.push(entry); return undefined; } },
    accounts: { get: () => ({ id: 'acc', provider: 'openai', auth, ...(plan ? { plan } : {}) }) },
    catalog: { get: () => undefined },
    paths: { resources: path.join(import.meta.dirname, '..', '..', '..', 'resources') },
    log: { warn() {}, debug() {} },
  };
  return { booked, spend: new EmbedSpend(() => services as never) };
}

test('paid embedding goes into the spend journal: small amounts together, the rest at the stop; free ones never', () => {
  const paid = spendWorld('api_key');
  const choice = { accountId: 'acc', provider: 'openai', model: 'text-embedding-3-small' };
  paid.spend.add(choice, { tokens: 1000 });
  assert.equal(paid.booked.length, 0, 'not one row per batch');
  paid.spend.add(choice, { tokens: 1_000_000 });
  assert.equal(paid.booked.length, 1, 'priced at the curated list price');
  assert.equal(paid.booked[0].kind, 'tokens');
  assert.equal(paid.booked[0].currency, 'USD');
  assert.ok(Math.abs((paid.booked[0].amount as number) - 0.02002) < 1e-6, String(paid.booked[0].amount));
  assert.match(String(paid.booked[0].ref), /^embedding:text-embedding-3-small/);
  paid.spend.add({ ...choice, model: 'some-other-embedding' }, { tokens: 5, costUsd: 0.0003 });
  assert.equal(paid.booked.length, 1);
  paid.spend.flush();
  assert.equal(paid.booked.length, 2, 'what is left goes at the stop');
  assert.equal(paid.booked[1].amount, 0.0003);

  const local = spendWorld('local');
  local.spend.add(choice, { tokens: 10_000_000 });
  local.spend.flush();
  assert.equal(local.booked.length, 0);

  const plan = spendWorld('cli');
  plan.spend.add(choice, { tokens: 10_000_000 });
  plan.spend.flush();
  assert.equal(plan.booked.length, 0);
});
