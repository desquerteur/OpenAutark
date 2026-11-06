// The memory tree under attack: a folder description never comes back as an item; a blob named only in a memory file stays in
// use however it got there; a pin on a topic file really reaches the prompt; a migration cut in the middle keeps the old ids.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { firstUse, fileUses } from '../../../src/runtime/files/references.ts';
import { KnowledgeStore, type MemoryVectors } from '../../../src/runtime/knowledge/service.ts';
import { insertItem } from '../../../src/runtime/knowledge/rows.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { unit } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';

const BLOB = 'a'.repeat(64);

function world(t: { after(fn: () => void): void }, seed?: (db: Db) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-attack-'));
  const root = path.join(dir, 'memory');
  mkdirSync(root, { recursive: true });
  const db = new Db(':memory:');
  migrate(db);
  seed?.(db);
  const clock = new ManualClock();
  t.after(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, db, clock };
}

const row = (id: string, body: string): KnowledgeItem => ({ id, scope: 'global', kind: 'fact', title: id, body, tags: [], source: { kind: 'agent', trusted: true }, confidence: 0.7, pinned: false, recordedAt: 1000, createdBy: 'human', uses: 0 });

test('a folder description embedded on purpose never comes back from knowledge.search as a note', async (t) => {
  const w = world(t);
  const embedder = { id: 'f', batch: 4, remote: false, embed: async (texts: string[]) => texts.map((text) => unit([text.toLowerCase().includes('invoice') ? 1 : 0, 0.1])) };
  const vectors = new VectorSystem({ db: w.db, memoryRoot: w.root, embedder: () => embedder, changeDelayMs: 0 });
  t.after(() => vectors.stop());
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root, vectors: () => vectors });
  store.memoryWrite({ folder: 'company', title: 'Invoices', text: 'Invoices go out on the 3rd.' });
  mkdirSync(path.join(w.root, 'company'), { recursive: true });
  writeFileSync(path.join(w.root, 'company', '_folder.md'), 'Everything about invoice work in the company.\n');
  await vectors.embed(['memory']);
  assert.ok((await vectors.search({ query: 'invoice', in: ['memory'] })).hits.some((hit) => hit.path.endsWith('_folder.md')), 'vector.search may show it');
  const hits = await store.search({ text: 'invoice', limit: 10 });
  assert.deepEqual(hits.map((hit) => hit.item.title), ['Invoices']);
});

test('a blob named only inside a memory file counts as in use, and stops counting when the file no longer names it', (t) => {
  const w = world(t);
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root });
  assert.equal(firstUse(w.db, BLOB), undefined);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Logo', text: `The logo is stored file ${BLOB}.` });
  assert.deepEqual(firstUse(w.db, BLOB), { kind: 'knowledge' });
  assert.deepEqual(fileUses(w.db, BLOB).other, ['knowledge'], 'as memory, not as some app state');
  store.memoryWrite({ path: file, title: 'Logo', text: 'The logo is gone.' });
  assert.deepEqual(firstUse(w.db, BLOB), { kind: 'knowledge' }, 'the old version still names it');
  store.forget(file.replaceAll('/', ':'), 'human');
  assert.equal(firstUse(w.db, BLOB), undefined);
});

test('a blob named by a source line, a moved row or a pinned file stays in use', (t) => {
  const w = world(t, (db) => insertItem(db, row('kn_old', `See ${BLOB}.`)));
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root });
  assert.deepEqual(firstUse(w.db, BLOB), { kind: 'knowledge' }, 'a row that moved to a file at the start');
  const other = 'b'.repeat(64);
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'From a file', text: 'Learned.', source: `file:${other}` });
  assert.deepEqual(firstUse(w.db, other), { kind: 'knowledge' });
  store.pin(file.replaceAll('/', ':'), true, 'human');
  assert.deepEqual(firstUse(w.db, other), { kind: 'knowledge' }, 'it moved with the pin');
});

test('a direct edit naming a blob counts, reported by the watcher or made while the app was closed', async (t) => {
  const w = world(t);
  const clock = w.clock;
  const watcher = new RootWatcher({ root: w.dir, clock, watch: false, debounceMs: 1 });
  watcher.start();
  t.after(() => watcher.stop());
  const edited = path.join(w.root, 'company', 'hand.md');
  mkdirSync(path.dirname(edited), { recursive: true });
  writeFileSync(edited, `Before the start, by hand: ${BLOB}\n`);
  const first = new KnowledgeStore({ db: w.db, clock, root: w.root, writes: watcher });
  await first.startMemory(watcher);
  t.after(() => first.stopMemory());
  assert.deepEqual(firstUse(w.db, BLOB), { kind: 'knowledge' }, 'found at the start');
  const later = 'c'.repeat(64);
  const during = path.join(w.root, 'company', 'during.md');
  writeFileSync(during, `While it runs: ${later}\n`);
  watcher.nudge('memory', ['company', 'during.md']);
  watcher.flush('memory');
  assert.deepEqual(firstUse(w.db, later), { kind: 'knowledge' });
  writeFileSync(during, 'No id any more.\n');
  watcher.nudge('memory', ['company', 'during.md']);
  watcher.flush('memory');
  assert.equal(firstUse(w.db, later), undefined);
  first.stopMemory();
  const closed = 'd'.repeat(64);
  writeFileSync(path.join(w.root, 'company', 'closed.md'), `While closed: ${closed}\n`);
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(w.root, 'company', 'closed.md'), future, future);
  const second = new KnowledgeStore({ db: w.db, clock, root: w.root, writes: watcher });
  await second.startMemory(watcher);
  t.after(() => second.stopMemory());
  assert.deepEqual(firstUse(w.db, closed), { kind: 'knowledge' });
  second.stopMemory();
  rmSync(path.join(w.root, 'company', 'closed.md'));
  const third = new KnowledgeStore({ db: w.db, clock, root: w.root, writes: watcher });
  await third.startMemory(watcher);
  t.after(() => third.stopMemory());
  assert.equal(firstUse(w.db, closed), undefined, 'deleted while closed');
});

test('a pin on a file in a topic folder really reaches the prompt; unpinning brings it back below its place', (t) => {
  const w = world(t);
  const now = w.clock.now();
  w.db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_a', 'Ada', '{}', 'human', ?, ?)`, [now, now]);
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root });
  const { path: file } = store.memoryWrite({ folder: 'company/billing', title: 'Invoices', text: 'Invoices go out on the 3rd.' });
  const pinned = store.pin(file.replaceAll('/', ':'), true, 'human');
  assert.equal(pinned.pinned, true);
  assert.deepEqual(store.pinned('ag_a').map((item) => item.title), ['Invoices'], 'a pin that shows as pinned is in the prompt');
  const back = store.pin(pinned.id, false, 'human');
  assert.equal(back.pinned, false);
  assert.deepEqual(store.pinned('ag_a'), []);
  assert.ok(store.memoryRead(back.id.replaceAll(':', '/')));
});

test('many pinned files: the prompt part stays within its cap and never reads them all', (t) => {
  const w = world(t);
  const now = w.clock.now();
  w.db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_a', 'Ada', '{}', 'human', ?, ?)`, [now, now]);
  const folder = path.join(w.root, 'company', 'pinned');
  mkdirSync(folder, { recursive: true });
  for (let index = 0; index < 400; index++) writeFileSync(path.join(folder, `n${index}.md`), `Note number ${index} with a little text in it.\n`);
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root });
  const items = store.pinned('ag_a');
  assert.ok(items.length <= 200 && items.length < 400, 'a bounded count is read; the one size cap is on the rendered lines (knowledge/always.ts)');
});

test('a migration cut in the middle keeps the old id of what already moved', (t) => {
  const w = world(t, (db) => { insertItem(db, row('kn_one', 'First text.')); insertItem(db, { ...row('kn_two', 'Second text.'), scope: 'agent', scopeId: 'ag_x' }); });
  const crash = { info() {}, debug() {}, warn() { throw new Error('crash'); } };
  // The second row cannot be written (a file stands where its folder belongs): the log call stands for a crash at that point.
  writeFileSync(path.join(w.root, 'agents'), 'in the way');
  assert.throws(() => new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root, log: crash as never }), /crash/);
  rmSync(path.join(w.root, 'agents'));
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root });
  assert.equal(store.get('kn_one')?.body, 'First text.', 'the row that moved before the crash');
  assert.equal(store.get('kn_two')?.body, 'Second text.', 'the row that moved after it');
});

test('a vectors port that is not there never stops a blob note or a write', (t) => {
  const w = world(t);
  const broken: MemoryVectors = { available: () => true, embed: async () => { throw new Error('down'); }, search: async () => { throw new Error('down'); }, onFileChanged() { throw new Error('down'); }, onFileRemoved() { throw new Error('down'); } };
  const store = new KnowledgeStore({ db: w.db, clock: w.clock, root: w.root, vectors: () => broken });
  const { path: file } = store.memoryWrite({ folder: 'company', title: 'Logo', text: `Named ${BLOB}.` });
  assert.deepEqual(firstUse(w.db, BLOB), { kind: 'knowledge' });
  assert.deepEqual(store.memoryForget(file), { removed: true });
  assert.equal(firstUse(w.db, BLOB), undefined);
});
