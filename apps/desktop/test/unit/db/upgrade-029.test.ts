// An installed Desktop 0.2.9 upgrades without loss: its shipped migrations keep their meaning (the SQL of 088 and 089 is pinned to
// what 0.2.9 shipped), a database at its state (schema 89, memory tree, old-id rows, old versions, vectors, ledger, a kept trace)
// goes through the newer migrations and stays readable, and the old-id map of a state before 0.2.9 becomes rows.
// Owns: these assertions only. Never: the release copy (.local) – the hashes were taken from it on 01.11.2026.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { sql as vectorChunks } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import { sql as contextItems } from '../../../src/runtime/db/migrations/089-context-items.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { movedTo } from '../../../src/runtime/knowledge/memory-migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';

const SCHEMA_029 = 89;
const FILE = 'company/firma.md';
const ENTRY = '---\ntitle: Firma\nkind: fact\nupdated: 2026-11-01T18:00:00.000Z\nby: ag_a\n---\n\nDie Firma heißt Teydra Lab.\n';
const sha = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const metaOf = (db: Db, key: string) => db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;

/** A database and memory folder as 0.2.9 leaves them. */
function at029(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-upgrade-029-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'memory');
  mkdirSync(path.join(root, 'company'), { recursive: true });
  writeFileSync(path.join(root, ...FILE.split('/')), ENTRY);
  const db = new Db(':memory:');
  migrate(db, { until: SCHEMA_029 });
  const now = Date.parse('2026-11-01T18:00:00.000Z');
  db.run(`INSERT INTO meta (key, value) VALUES ('memory.old-id.kn_moved', ?)`, [FILE]);
  db.run(`INSERT INTO knowledge (id, scope, scope_id, kind, title, body, tags, source, confidence, pinned, recorded_at, expired_at, supersedes, created_by, uses)
    VALUES ('kn_older', 'global', NULL, 'fact', 'Firma', 'Alte Fassung', '[]', '{"kind":"agent","trusted":true}', 0.7, 0, ?, ?, 'company:firma.md', 'ag_a', 0)`, [now - 1000, now]);
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('memory.blobs', ?, ?, ?)`, [FILE, 'a'.repeat(64), now]);
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('subconscious_trace', 'ag_a:ch_1', ?, ?)`, [JSON.stringify({ calls: [{ tool: 'agent.tell', args: {}, output: 'Note' }] }), now]);
  const info = statSync(path.join(root, ...FILE.split('/')));
  db.run(`INSERT INTO vector_files (id, key, path, mtime, size, model, chunks, done, embedded_at) VALUES (1, 'memory/company/firma.md', 'memory/company/firma.md', ?, ?, 'local:x', 1, 1, ?)`,
    [Math.trunc(info.mtimeMs), info.size, now]);
  db.run(`INSERT INTO vector_chunks (file_id, chunk, line_from, line_to, vector, snippet) VALUES (1, 0, 1, 2, ?, 'Die Firma')`, [new Uint8Array([127, 0, 0])]);
  db.run(`INSERT INTO context_items (agent_id, conversation_id, item_id, kind, "order", created_at, state, condensed, applied) VALUES ('ag_a', 'ch_1', 't1', 't', 1, ?, 'condensed', 'kurz', 'condensed')`, [now]);
  return { db, root, now };
}

test('the migrations 0.2.9 shipped keep their meaning', () => {
  assert.equal(sha(vectorChunks), '5b018e484dfb5c51c94a8db8473c79ee52fc3b77f392fc96ff63cda1bbe7186b');
  assert.equal(sha(contextItems), '3f7dd1d8920289f27e09dbfdc83476fb3ddebf73e3ebf634afc7b9958672d90e');
  assert.ok(SCHEMA_VERSION > SCHEMA_029, 'what is new takes a number above 89');
});

test('a database at the state of 0.2.9 upgrades: nothing fails, nothing is lost, the old ids still find their file', async (t) => {
  const { db, root, now } = at029(t);
  const before = (sql: string) => JSON.stringify(db.all(sql));
  const rows = ['SELECT * FROM knowledge', 'SELECT * FROM kv', 'SELECT * FROM vector_files', 'SELECT file_id, chunk, snippet FROM vector_chunks', 'SELECT * FROM context_items'];
  const held = rows.map(before);

  assert.deepEqual(migrate(db), { from: SCHEMA_029, to: SCHEMA_VERSION });
  assert.equal(metaOf(db, 'schema'), String(SCHEMA_VERSION));
  assert.deepEqual(rows.map(before), held, 'every row of 0.2.9 is as it was');
  assert.equal(metaOf(db, 'memory.old-id.kn_moved'), FILE);

  const clock = new ManualClock(now);
  const store = new KnowledgeStore({ db, clock, root });
  assert.equal(store.get('kn_moved')?.title, 'Firma', 'an old id finds its file');
  assert.deepEqual(store.history('kn_moved').map((version) => version.body), ['Alte Fassung', 'Die Firma heißt Teydra Lab.'], 'the old version stays linked');
  assert.deepEqual((await store.list({ scope: 'global' })).map((item) => item.id), ['company:firma.md']);
  assert.equal(readFileSync(path.join(root, ...FILE.split('/')), 'utf8'), ENTRY, 'the file is untouched');
  assert.equal(migrate(db).from, SCHEMA_VERSION, 'once');
});

test('vectors of 0.2.9 are found again without a single new embedding', async (t) => {
  const { db, root } = at029(t);
  migrate(db);
  const documents: string[] = [];
  const embedder: Embedder = { id: 'local:x', batch: 1, remote: false, embed: async (texts, purpose) => { if (purpose === 'document') documents.push(...texts); return texts.map(() => Float32Array.from([1, 0, 0])); } };
  const system = new VectorSystem({ db, memoryRoot: root, embedder: () => embedder, changeDelayMs: 0 });
  t.after(() => system.stop());
  const hits = (await system.search({ query: 'Firma', in: ['memory'] })).hits;
  assert.deepEqual(hits.map((hit) => hit.snippet), ['Die Firma']);
  await system.settled();
  assert.deepEqual(documents, []);
});

test('the old-id map of a state before 0.2.9 becomes one row per id; a row that exists wins, a broken map just goes', (t) => {
  const { db } = at029(t);
  db.run(`INSERT INTO meta (key, value) VALUES ('memory.old-ids', ?)`, [JSON.stringify({ kn_a: 'company/a.md', kn_moved: 'company/other.md', kn_number: 7 })]);
  migrate(db);
  assert.equal(movedTo(db, 'kn_a'), 'company/a.md');
  assert.equal(movedTo(db, 'kn_moved'), FILE, 'the newer row stays');
  assert.equal(movedTo(db, 'kn_number'), undefined);
  assert.equal(metaOf(db, 'memory.old-ids'), undefined, 'the map is gone');

  const broken = new Db(':memory:');
  migrate(broken, { until: SCHEMA_029 });
  broken.run(`INSERT INTO meta (key, value) VALUES ('memory.old-ids', 'not json')`);
  assert.equal(migrate(broken).to, SCHEMA_VERSION);
  assert.equal(metaOf(broken, 'memory.old-ids'), undefined);
});
