// Auto mode when this PC's model fails: a stand-in (an API key) answers what it can and starts no paid background work; after a
// restart nothing unchanged is embedded again. Only a choice in settings re-embeds the existing files, once, also across a restart.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';

class Fake implements Embedder {
  batch = 4;
  documents: string[] = [];
  queries: string[] = [];
  readonly id: string;
  readonly remote: boolean;
  constructor(id: string, remote: boolean) { this.id = id; this.remote = remote; }
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    (purpose === 'query' ? this.queries : this.documents).push(...texts);
    return texts.map((text) => unit([text.includes('Angebot') ? 1 : 0, text.includes('Firma') ? 1 : 0, 0.01]));
  }
}

const settled = async (system: VectorSystem) => { await new Promise((resolve) => setTimeout(resolve, 5)); await system.settled(); };

function world(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-vector-flap-'));
  const db = new Db(path.join(dir, 'test.db'));
  migrate(db);
  const memoryRoot = path.join(dir, 'memory');
  mkdirSync(path.join(memoryRoot, 'company'), { recursive: true });
  const local = new Fake('local:mini', false);
  const paid = new Fake('openai:small', true);
  const state = { choice: 'auto', current: local as Embedder | undefined, standIn: false };
  const systems: VectorSystem[] = [];
  /** A start of the app: everything in memory is new (the local model's failures too). */
  const start = () => {
    systems.at(-1)?.stop();
    const system = new VectorSystem({ db, memoryRoot, embedder: () => state.current, choice: () => state.choice, standIn: () => state.standIn, changeDelayMs: 0 });
    systems.push(system);
    system.start();
    return system;
  };
  t.after(() => { systems.at(-1)?.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, body: string) => {
    const file = path.join(memoryRoot, 'company', name);
    writeFileSync(file, body);
    return file;
  };
  const giveUp = () => { state.current = paid; state.standIn = true; };
  const comeBack = () => { state.current = local; state.standIn = false; };
  return { db, memoryRoot, local, paid, state, start, write, giveUp, comeBack };
}

test('the local model fails, then a restart: the API key is never paid for the existing files, the local model redoes nothing unchanged', async (t) => {
  const w = world(t);
  const offer = w.write('angebot.md', 'Das Angebot ging raus.');
  w.write('firma.md', 'Die Firma heißt Teydra Lab.');
  let system = w.start();
  await system.embed(['memory']);
  assert.equal(w.local.documents.length, 2);

  w.giveUp();
  await settled(system);
  system.settingsChanged();
  await settled(system);
  const found = await system.search({ query: 'Angebot', in: ['memory'] });
  await settled(system);
  system.onFileChanged(offer);
  await settled(system);
  const pass = await system.embed(['memory'], { notYet: true });
  assert.equal(pass.failed, true, 'the tree comes again later');
  assert.deepEqual(w.paid.documents, [], 'nothing paid in the background, whatever happened');
  assert.deepEqual(found.hits, []);
  assert.match(found.note ?? '', /another embedding model/);
  assert.doesNotMatch(found.note ?? '', /being re-embedded/);
  assert.deepEqual(w.paid.queries, [], 'nothing it could answer: not even the query is paid');

  // Edited while the stand-in served; then the next start: the local model is back.
  writeFileSync(offer, 'Das Angebot ging raus, Preis 90 Euro.');
  w.comeBack();
  system = w.start();
  await settled(system);
  w.local.documents.length = 0;
  const again = await system.embed(['memory'], { notYet: true });
  assert.equal(again.reembedded, 1);
  assert.equal(again.unchanged, 1);
  assert.equal(w.local.documents.length, 1, 'only what changed');
  assert.deepEqual(w.paid.documents, []);
  assert.equal((await system.search({ query: 'Angebot', in: ['memory'], k: 1 })).hits[0]?.path, 'memory/company/angebot.md');
});

test('a stand-in answers what it can: files embedded with it on purpose', async (t) => {
  const w = world(t);
  const system = w.start();
  w.write('firma.md', 'Die Firma heißt Teydra Lab.');
  await system.embed(['memory']);
  const offer = w.write('angebot.md', 'Das Angebot ging raus.');
  w.giveUp();
  await system.embed([offer]); // somebody asked for it: that is no background work
  assert.equal(w.paid.documents.length, 1);
  const found = await system.search({ query: 'Angebot', in: ['memory'] });
  assert.equal(found.hits[0]?.path, 'memory/company/angebot.md');
  assert.match(found.note ?? '', /^Files here were embedded with another embedding model/, 'rule (a): no count');
  assert.equal(w.paid.documents.length, 1);
  assert.deepEqual(w.paid.queries, ['Angebot']);
});

test('auto drifting to another model (a server connected, a key removed) re-embeds nothing', async (t) => {
  const w = world(t);
  w.write('firma.md', 'Die Firma heißt Teydra Lab.');
  const system = w.start();
  await system.embed(['memory']);
  w.state.current = w.paid; // no stand-in: this PC cannot run its own model any more, nobody chose anything
  w.local.documents.length = 0;
  system.settingsChanged();
  await settled(system);
  assert.deepEqual(w.paid.documents, []);
  assert.equal((await system.embed(['memory'], { notYet: true })).unchanged, 1);
  assert.deepEqual(w.paid.documents, []);
});

test('a model chosen in settings re-embeds the existing files once; the work survives a restart and ends', async (t) => {
  const w = world(t);
  w.write('firma.md', 'Die Firma heißt Teydra Lab.');
  w.write('angebot.md', 'Das Angebot ging raus.');
  let system = w.start();
  await system.embed(['memory']);

  // The app stops right after the choice, before any work.
  w.state.choice = 'openai:small';
  w.state.current = w.paid;
  system.settingsChanged();
  system.stop();
  w.paid.documents.length = 0;
  system = w.start();
  const during = await system.search({ query: 'Firma', in: ['memory'] });
  assert.match(during.note ?? '', /being re-embedded/);
  await settled(system);
  assert.equal(w.paid.documents.length, 2, 'both files, once');
  assert.equal((await system.search({ query: 'Angebot', in: ['memory'], k: 1 })).hits[0]?.path, 'memory/company/angebot.md');

  w.paid.documents.length = 0;
  system = w.start();
  await settled(system);
  assert.deepEqual(w.paid.documents, [], 'finished: a later start redoes nothing');

  // Back to auto: another choice, while this PC's model works.
  w.state.choice = 'auto';
  w.state.current = w.local;
  w.local.documents.length = 0;
  system.settingsChanged();
  await settled(system);
  assert.equal(w.local.documents.length, 2);
});

test('auto chosen again while only a stand-in serves: the work waits for the chosen model', async (t) => {
  const w = world(t);
  w.state.choice = 'openai:small';
  w.state.current = w.paid;
  w.write('firma.md', 'Die Firma heißt Teydra Lab.');
  let system = w.start();
  await system.embed(['memory']);
  await settled(system);
  w.state.choice = 'auto';
  w.giveUp();
  w.state.current = new Fake('deepinfra:qwen', true);
  system.settingsChanged();
  await settled(system);
  assert.deepEqual((w.state.current as Fake).documents, []);
  w.comeBack();
  system = w.start();
  await settled(system);
  assert.equal(w.local.documents.length, 1, 'then the existing file goes to it');
});

test('the memory tree\'s own pass through the store: no paid embedding while a stand-in serves, a new file comes with the local model', async (t) => {
  const w = world(t);
  const clock = new ManualClock();
  let vectors: VectorSystem = w.start();
  const store = new KnowledgeStore({ db: w.db, clock, root: w.memoryRoot, vectors: () => vectors, embedRetryMs: 5 });
  store.save({ title: 'Firma', body: 'Die Firma heißt Teydra Lab.', scope: 'global', createdBy: 'human' });
  await store.startMemory();
  await settled(vectors);
  for (let i = 0; i < 100 && !w.local.documents.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(w.local.documents.length, 1);

  w.giveUp();
  store.save({ title: 'Angebot', body: 'Das Angebot ging raus.', scope: 'global', createdBy: 'human' });
  store.embedderChanged();
  await settled(vectors);
  await new Promise((resolve) => setTimeout(resolve, 40));
  store.stopMemory();
  assert.deepEqual(w.paid.documents, []);
  assert.equal((await store.search({ text: 'Angebot' })).length, 1, 'the words find it meanwhile');

  w.comeBack();
  w.local.documents.length = 0;
  vectors = w.start();
  const next = new KnowledgeStore({ db: w.db, clock, root: w.memoryRoot, vectors: () => vectors, embedRetryMs: 5 });
  await next.startMemory();
  for (let i = 0; i < 100 && !w.local.documents.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  next.stopMemory();
  assert.equal(w.local.documents.length, 1, 'only the file written meanwhile');
  assert.match(w.local.documents[0], /Angebot/);
  assert.deepEqual(w.paid.documents, []);
});
