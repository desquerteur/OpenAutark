// B-078 D12: virtual entries of the vector store (vectors/virtual.ts) and the multi-hop search (vectors/hops.ts): a short
// text is embedded whole, a big entry by title + description; an unchanged text costs no model call, a changed one is
// embedded again; forget and virtualKeys; "catalog" is a place; a path scores the product of its similarities.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { sql } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import type { Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { unit } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';
import { CHUNK_CHARS } from '../../../src/runtime/vectors/chunk.ts';
import { embedTextOf, textStamp } from '../../../src/runtime/vectors/virtual.ts';
import { hopSearch, HOP_FLOOR, type ChunkHit } from '../../../src/runtime/vectors/hops.ts';

const WORDS = ['invoice', 'server', 'soup', 'video', 'contract', 'plan', 'cat', 'deploy'];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 2;
  remote = false;
  documents: string[] = [];
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (purpose === 'document') this.documents.push(...texts);
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vectors-virtual-'));
  const db = new Db(path.join(dir, 'test.db'));
  db.exec(sql);
  db.exec('CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;');
  const memoryRoot = path.join(dir, 'memory');
  mkdirSync(memoryRoot, { recursive: true });
  const embedder = new FakeEmbedder();
  let current: Embedder = embedder;
  const system = new VectorSystem({ db, memoryRoot, embedder: () => current, changeDelayMs: 0 });
  return { embedder, system, db, memoryRoot, use: (next: Embedder) => { current = next; }, done: () => { system.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the embedding rule: a short text whole, a big one by title and description', () => {
  assert.equal(embedTextOf({ title: 'deploy-check', description: 'I use this when I deploy.', body: 'Run the checks.' }), 'deploy-check\nI use this when I deploy.\nRun the checks.');
  const big = embedTextOf({ title: 'huge', description: 'I use this for video work.', body: 'x'.repeat(CHUNK_CHARS) });
  assert.equal(big, 'huge\nI use this for video work.');
  assert.equal(textStamp('a'), textStamp('a'));
  assert.notEqual(textStamp('a'), textStamp('b'));
  assert.ok(Number.isSafeInteger(textStamp('a')));
});

test('virtual entries: embedded once, unchanged ones cost nothing, a changed one again; found under "catalog"; forget removes them', async () => {
  const t = setup();
  try {
    const items = [
      { key: 'catalog/skill/builtin/invoices', text: 'invoices\nI use this when an invoice goes out.' },
      { key: 'catalog/public/demo/Soup', text: 'soup\nI use this for soup recipes.' },
      { key: 'memory/not-virtual', text: 'ignored' },
    ];
    const first = await t.system.embedTexts(items);
    assert.deepEqual([first.embedded, first.unchanged, first.remaining], [2, 0, 0]);
    const again = await t.system.embedTexts(items);
    assert.deepEqual([again.embedded, again.unchanged], [0, 2]);
    assert.equal(t.embedder.documents.length, 2, 'no model call for an unchanged text');
    await t.system.embedTexts([{ key: 'catalog/skill/builtin/invoices', text: 'invoices\nI use this when an invoice or a contract goes out.' }]);
    assert.equal(t.embedder.documents.length, 3, 'a changed text is embedded again');
    const found = await t.system.search({ query: 'invoice', in: ['catalog'] });
    assert.equal(found.hits[0].path, 'catalog/skill/builtin/invoices', 'the key comes back as written');
    assert.deepEqual(t.system.virtualKeys('catalog/public').map((key) => key.toLowerCase()), ['catalog/public/demo/soup']);
    t.system.forget('catalog/public');
    assert.deepEqual(t.system.virtualKeys('catalog/public'), []);
    const embed = await t.system.embed(['catalog/skill']);
    assert.ok(embed.skipped.some((entry) => /embeds itself/.test(entry.reason)), 'vector.embed leaves catalog entries to their owner');
  } finally { t.done(); }
});

test('a model change: a batch of only catalog rows does not end the redo, the memory file behind them is embedded again', async () => {
  const t = setup();
  try {
    writeFileSync(path.join(t.memoryRoot, 'facts.md'), 'the server contract');
    t.system.onFileChanged('facts.md');
    await t.system.settled();
    await t.system.embedTexts(Array.from({ length: 60 }, (_, index) => ({ key: `catalog/skill/builtin/s${index}`, text: `soup ${index}` })));
    t.db.run("UPDATE vector_files SET embedded_at = CASE WHEN path LIKE 'catalog/%' THEN 1 ELSE 2 END"); // the catalog rows are the oldest
    const next = new FakeEmbedder();
    next.id = 'fake:2';
    t.use(next);
    await t.system.search({ query: 'contract', in: ['memory'] });
    await t.system.settled();
    assert.ok(next.documents.some((text) => text.includes('server contract')), 'the memory file was redone');
    const after = await t.system.search({ query: 'contract', in: ['memory'] });
    assert.equal(after.hits[0]?.path, 'memory/facts.md', JSON.stringify(after));
    assert.deepEqual(t.system.virtualKeys('catalog'), [], 'old-model catalog rows went; their owner embeds them again');
  } finally { t.done(); }
});

test('hops: a path scores the product of its similarities, so C reached through B beats a weak direct hit', async () => {
  // file 1 = A (direct 0.75), file 2 = B (0.9 from A), file 3 = a weak direct hit (0.2).
  const vectors = new Map<number, Float32Array>([[1, new Float32Array([1, 0])], [2, new Float32Array([0, 1])], [3, new Float32Array([0.5, 0.5])]]);
  let scans = 0;
  const one = async (vector: Float32Array, k: number): Promise<ChunkHit[]> => {
    if (vector[0] === 1 && vector[1] === 0) return [{ fileId: 1, chunk: 0, score: 1 }, { fileId: 2, chunk: 0, score: 0.9 }].slice(0, k); // A's own vector
    if (vector[0] === 0 && vector[1] === 1) return [{ fileId: 2, chunk: 0, score: 1 }, { fileId: 1, chunk: 0, score: 0.9 }];
    if (vector[0] === 0.5) return [{ fileId: 3, chunk: 0, score: 1 }];
    return [{ fileId: 1, chunk: 0, score: 0.75 }, { fileId: 3, chunk: 0, score: 0.2 }]; // the query
  };
  const top = async (list: readonly Float32Array[], k: number): Promise<ChunkHit[][]> => { scans++; return Promise.all(list.map((vector) => one(vector, k))); };
  const query = new Float32Array([0.3, 0.3]);
  const direct = await hopSearch(query, 5, 0, { top, vectorOf: (fileId) => vectors.get(fileId) });
  assert.deepEqual(direct.map((hit) => hit.fileId), [1, 3], 'no hops: the plain search');
  scans = 0;
  const hopped = await hopSearch(query, 5, 2, { top, vectorOf: (fileId) => vectors.get(fileId) });
  assert.deepEqual(hopped.map((hit) => [hit.fileId, Number(hit.score.toFixed(3))]), [[1, 0.75], [2, 0.675], [3, 0.2]]);
  assert.ok(scans <= 3, `one scan per hop for the whole beam (${scans})`);
  assert.equal(hopped[1].via?.fileId, 1, 'B names the hit it was reached through');
  assert.equal(hopped[1].hops, 1);
  // Below the floor a chain says nothing.
  const seeded = (score: number) => async (list: readonly Float32Array[], k: number): Promise<ChunkHit[][]> => Promise.all(list.map(async (vector) => (vector === query ? [{ fileId: 1, chunk: 0, score }] : (await one(vector, k)))));
  const weak = await hopSearch(query, 5, 2, { top: seeded(0.4), vectorOf: (fileId) => vectors.get(fileId) });
  assert.ok(0.4 * 0.9 >= HOP_FLOOR && weak.some((hit) => hit.fileId === 2), 'above the floor it counts');
  const below = await hopSearch(query, 5, 2, { top: seeded(0.3), vectorOf: (fileId) => vectors.get(fileId) });
  assert.ok(!below.some((hit) => hit.fileId === 2), '0.3 × 0.9 is below the floor');
});

test('vector.search with hops through the store: a neighbour of the best hit is found and names it', async () => {
  const t = setup();
  try {
    await t.system.embedTexts([
      { key: 'catalog/a', text: 'invoice server' },
      { key: 'catalog/b', text: 'server deploy' },
      { key: 'catalog/c', text: 'soup' },
    ]);
    const plain = await t.system.search({ query: 'invoice', in: ['catalog'], k: 3 });
    const hopped = await t.system.search({ query: 'invoice', in: ['catalog'], k: 3, hops: 2 });
    const plainB = plain.hits.find((hit) => hit.path === 'catalog/b');
    const hopB = hopped.hits.find((hit) => hit.path === 'catalog/b');
    assert.ok(hopB && hopB.via === 'catalog/a', JSON.stringify(hopped.hits));
    assert.ok(!plainB || hopB.score > plainB.score, 'the path beats the direct similarity');
  } finally { t.done(); }
});
