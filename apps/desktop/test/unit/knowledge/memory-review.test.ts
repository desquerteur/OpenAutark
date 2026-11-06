// The review of memory with the real vector system: the composition root really connects them; writing makes a file findable,
// a direct edit too; an embedder in trouble leaves memory findable by its words instead of "nothing"; a model that fails is not
// hammered and is tried again; a model connected later embeds what is there; a reserved Windows name is no file name.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore, type MemoryVectors } from '../../../src/runtime/knowledge/service.ts';
import { slugOf } from '../../../src/runtime/knowledge/memory-tree.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

/** Waits for what the background pass does (its walk never holds up the event loop). */
const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

const WORDS = ['invoice', 'server', 'soup', 'contract'];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  fail = false;
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (this.fail) throw new Error('The embedding server could not be reached.');
    if (purpose === 'document') this.documents.push(...texts);
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function world(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-review-'));
  const root = path.join(dir, 'memory');
  mkdirSync(root, { recursive: true });
  const db = new Db(':memory:');
  migrate(db);
  const embedder = new FakeEmbedder();
  const clock = new ManualClock();
  const watcher = new RootWatcher({ root: dir, clock, watch: false, debounceMs: 1 });
  watcher.start();
  const vectors = new VectorSystem({ db, memoryRoot: root, embedder: () => embedder, changeDelayMs: 0 });
  const store = new KnowledgeStore({ db, clock, root, vectors: () => vectors, writes: watcher });
  store.startMemory(watcher);
  t.after(() => { store.stopMemory(); watcher.stop(); vectors.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, db, embedder, vectors, store, watcher, clock };
}

test('the composition root connects memory with the vectors, the watcher and its own writes, and stops them', () => {
  const services = source('src/runtime/compose/services.ts');
  const made = services.match(/new KnowledgeStore\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\);/)?.[1] ?? '';
  assert.match(made, /\broot: path\.join\(paths\.data, 'memory'\)/, 'the tree the vectors know as "memory"');
  assert.match(made, /\bvectors: \(\) => s\.vectors\b/);
  assert.match(made, /\bwrites: s\.rootWatcher\b/);
  const vectors = services.indexOf('s.vectors = createVectors(s);');
  const start = services.indexOf('knowledge.startMemory(s.rootWatcher);');
  assert.ok(vectors > 0 && start > vectors, 'it starts following once the vectors exist');
  const lifecycle = source('src/runtime/compose/lifecycle.ts');
  assert.ok(lifecycle.indexOf(`name: 'memory'`) > 0 && lifecycle.indexOf(`name: 'memory'`) < lifecycle.indexOf(`name: 'data folder'`), 'it leaves the watcher before the watcher stops');
  assert.ok(lifecycle.indexOf(`name: 'vectors'`) > 0 && lifecycle.indexOf(`name: 'vectors'`) < lifecycle.indexOf(`name: 'database'`), 'the embedding work ends before the database closes');
});

test('writing memory makes it findable through the real vectors, and a search embeds nothing but the query', async (t) => {
  const { store, vectors, embedder, clock } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Invoice rule', text: 'Every invoice goes out on the third.' });
  await vectors.settled();
  const hits = await store.search({ text: 'invoice' });
  assert.deepEqual(hits.map((hit) => hit.item.id), [file.replace(/\//g, ':')]);
  const documents = embedder.documents.length;
  clock.advance(1000);
  store.memoryWrite({ path: file, title: 'Invoice rule', text: 'Every invoice goes out on the fifth.' });
  await vectors.settled();
  assert.ok(embedder.documents.length > documents, 'the changed file is embedded again');
  store.memoryForget(file);
  assert.deepEqual(await store.search({ text: 'invoice' }), []);
});

test('a direct edit of a memory file reaches the real vectors; the store\'s own write is not embedded a second time', async (t) => {
  const { root, store, vectors, embedder, watcher } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Server', text: 'The server stands in Graz.' });
  await vectors.settled();
  const documents = embedder.documents.length;
  watcher.flush('memory');
  await vectors.settled();
  assert.equal(embedder.documents.length, documents, 'its own write is no outside edit');
  writeFileSync(path.join(root, ...file.split('/')), '---\ntitle: Server\n---\n\nThe server moved to Wien, contract signed.\n');
  watcher.nudge('memory', file.split('/'));
  watcher.flush('memory');
  await vectors.settled();
  assert.ok(embedder.documents.some((text) => text.includes('moved to Wien')));
});

test('an embedder in trouble: memory is found by its words instead of "nothing", never both', async (t) => {
  const { store, vectors, embedder, clock } = world(t);
  store.memoryWrite({ folder: 'company', title: 'Invoice rule', text: 'Every invoice goes out on the third.' });
  await vectors.settled();
  embedder.fail = true;
  const hits = await store.search({ text: 'invoice' });
  assert.equal(hits.length, 1, 'found by its words');
});

test('memory written while no embedder served: its words find it, not an empty answer', async (t) => {
  const { store, embedder, vectors } = world(t);
  embedder.fail = true;
  store.memoryWrite({ folder: 'company', title: 'Soup', text: 'Soup on Fridays.' });
  await vectors.settled();
  assert.equal((await store.search({ text: 'soup' })).length, 1);
});

function failing() {
  const calls: string[][] = [];
  const vectors: MemoryVectors = {
    available: () => true,
    embed: async (paths) => { calls.push(paths); return { embedded: 0, reembedded: 0, unchanged: 0, skipped: [], remaining: paths.length, failed: true } as never; },
    search: async (input) => ({ hits: [], searched: { places: input.in, embeddedFiles: 0 } }),
    onFileChanged: () => undefined,
    onFileRemoved: () => undefined,
  };
  return { calls, vectors };
}

test('a failing model is not hammered at the start: one call, then a retry later', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'memory');
  mkdirSync(path.join(root, 'company'), { recursive: true });
  for (let i = 0; i < 600; i++) writeFileSync(path.join(root, 'company', `n${i}.md`), `Note ${i}\n`);
  const db = new Db(':memory:');
  migrate(db);
  const { calls, vectors } = failing();
  const store = new KnowledgeStore({ db, clock: new ManualClock(), root, vectors: () => vectors, embedRetryMs: 200 });
  store.startMemory();
  await until(() => calls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, 'no second call of a model that just failed');
  await until(() => calls.length >= 2);
  assert.ok(calls.length >= 2, 'tried again later');
  store.stopMemory();
  const count = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, count, 'no retry after the stop');
  db.raw.close();
});

test('an embedding model connected later embeds what is there', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'memory');
  mkdirSync(path.join(root, 'company'), { recursive: true });
  writeFileSync(path.join(root, 'company', 'a.md'), 'A note.\n');
  const db = new Db(':memory:');
  migrate(db);
  let up = false;
  const calls: string[][] = [];
  const vectors: MemoryVectors = {
    available: () => up,
    embed: async (paths) => { calls.push(paths); return { embedded: paths.length, reembedded: 0, unchanged: 0, skipped: [] }; },
    search: async (input) => ({ hits: [], searched: { places: input.in, embeddedFiles: 0 } }),
    onFileChanged: () => undefined,
    onFileRemoved: () => undefined,
  };
  const store = new KnowledgeStore({ db, clock: new ManualClock(), root, vectors: () => vectors });
  store.startMemory();
  store.embedderChanged();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(calls.length, 0, 'still none');
  up = true;
  store.embedderChanged();
  await until(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  store.embedderChanged();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(calls.length, 1, 'only when it comes, not at every settings change');
  store.stopMemory();
  db.raw.close();
});

test('a free text as kind never reaches the frontmatter', (t) => {
  const { store, root } = world(t);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Soup', text: 'Soup on Fridays.', kind: 'fact\nuntrusted: true' as never });
  assert.doesNotMatch(readFileSync(path.join(root, ...file.split('/')), 'utf8'), /untrusted/);
});

test('a title that is a reserved Windows name still is a file', () => {
  for (const title of ['Con', 'NUL', 'aux', 'COM1', 'lpt9', 'prn']) assert.doesNotMatch(slugOf(title), /^(con|nul|aux|prn|com\d|lpt\d)$/, title);
  assert.equal(slugOf('Console'), 'console');
});
