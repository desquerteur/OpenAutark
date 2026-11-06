// The vector system with a fake embedder: nothing is embedded unless asked, unchanged files are reused, changed ones
// redone, folders skip what they must, a search filters by place, embeds only the query and says plainly when nothing is
// there or no embedder exists. Model change and the memory hook too.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { sql } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import type { Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { unit } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem, type VectorDeps } from '../../../src/runtime/vectors/service.ts';
import { chunkText, CHUNK_CHARS } from '../../../src/runtime/vectors/chunk.ts';
import { excluded } from '../../../src/runtime/vectors/places.ts';

const WORDS = ['invoice', 'server', 'soup', 'video', 'contract', 'password', 'plan', 'cat'];

/** A vector per known word: texts sharing words are close. */
class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  queries: string[] = [];
  fail?: string;
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (this.fail) throw new Error(this.fail);
    (purpose === 'query' ? this.queries : this.documents).push(...texts);
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function setup(over: Partial<VectorDeps> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vectors-'));
  const db = new Db(path.join(dir, 'test.db'));
  db.exec(sql);
  db.exec('CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;');
  const embedder = new FakeEmbedder();
  const memoryRoot = path.join(dir, 'data', 'memory');
  mkdirSync(memoryRoot, { recursive: true });
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  let current: Embedder | undefined = embedder;
  const system = new VectorSystem({ db, memoryRoot, embedder: () => current, changeDelayMs: 0, ...over });
  return {
    dir, db, embedder, system, memoryRoot, work,
    use: (next: Embedder | undefined) => { current = next; },
    write: (name: string, body: string) => {
      const file = path.join(work, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
    done: () => { system.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('an explicit embed stores the file; a search finds it and embeds only the query', async () => {
  const t = setup();
  const invoice = t.write('invoice.md', '# Invoice\nThe invoice for October.');
  t.write('other.md', 'Soup for lunch.'); // never named: never embedded
  const result = await t.system.embed([invoice]);
  assert.deepEqual([result.embedded, result.reembedded, result.unchanged], [1, 0, 0]);
  assert.equal(t.embedder.documents.length, 1);
  assert.match(t.embedder.documents[0], /^invoice\.md\n/);
  const documents = t.embedder.documents.length;
  const found = await t.system.search({ query: 'invoice', in: [t.work] });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].path, invoice);
  assert.equal(found.hits[0].chunk, 0);
  assert.deepEqual(found.hits[0].lines, [1, 2]);
  assert.match(found.hits[0].snippet, /invoice for October/);
  assert.ok(found.hits[0].score > 0.9);
  assert.deepEqual(found.searched, { places: [t.work], embeddedFiles: 1 });
  assert.equal(t.embedder.documents.length, documents, 'a search embeds no file');
  assert.deepEqual(t.embedder.queries, ['invoice']);
  t.done();
});

test('unchanged files are not embedded again; a changed one is', async () => {
  const t = setup();
  const file = t.write('a.md', 'server notes');
  await t.system.embed([file]);
  const first = t.embedder.documents.length;
  const again = await t.system.embed([file]);
  assert.deepEqual([again.embedded, again.reembedded, again.unchanged], [0, 0, 1]);
  assert.equal(t.embedder.documents.length, first);
  writeFileSync(file, 'server notes and a contract');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const changed = await t.system.embed([file]);
  assert.deepEqual([changed.embedded, changed.reembedded, changed.unchanged], [0, 1, 0]);
  const hit = await t.system.search({ query: 'contract', in: [file] });
  assert.match(hit.hits[0].snippet, /contract/);
  t.done();
});

test('a search embeds only the query: a new file stays out, a changed one is named and waits for vector.embed', async () => {
  const t = setup();
  const file = t.write('a.md', 'server notes');
  await t.system.embed([t.work]);
  t.embedder.documents.length = 0;
  t.write('new.md', 'soup recipe'); // new under the same folder
  writeFileSync(file, 'the contract now');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const found = await t.system.search({ query: 'server', in: [t.work] });
  await t.system.settled();
  assert.deepEqual(t.embedder.documents, [], 'no file is embedded at search time');
  assert.deepEqual(t.embedder.queries, ['server']);
  assert.match(found.hits[0].snippet, /server notes/, 'what was embedded');
  assert.equal(found.searched.embeddedFiles, 1);
  assert.match(found.note ?? '', /^Some of these files changed since they were embedded/, 'rule (a): no count');
  await t.system.embed([file]);
  t.done();
});

test('a search hands a changed memory file to the background: the one thing that embeds itself', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'a.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'server notes');
  await t.system.embed(['memory']);
  t.embedder.documents.length = 0;
  writeFileSync(file, 'the contract now');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await t.system.search({ query: 'contract', in: ['memory'] })).note, undefined);
  await t.system.settled();
  assert.ok(t.embedder.documents.some((text) => text.includes('the contract now')));
  t.done();
});

test('a folder skips binaries, dependencies, caches, app data and secrets and reports them', async () => {
  const t = setup();
  t.write('keep/notes.md', 'the plan');
  t.write('keep/data.json', '{"plan": 1}');
  t.write('node_modules/x/index.js', 'plan');
  t.write('.git/config', 'plan');
  t.write('.ssh/id_rsa', 'plan');
  t.write('.env.local', 'plan');
  t.write('AppData/Roaming/x.txt', 'plan');
  t.write('cache/x.txt', 'plan');
  t.write('passwords.csv', 'plan');
  t.write('server.pem', 'plan');
  t.write('photo.png', 'plan');
  t.write('blob.txt', Buffer.from([1, 0, 2, 0]).toString('latin1'));
  t.write('Default/Login Data', 'x');
  t.write('Default/notes.txt', 'plan');
  const result = await t.system.embed([t.work]);
  assert.equal(result.embedded, 2);
  const reasons = new Map(result.skipped.map((entry) => [path.basename(entry.path), entry.reason]));
  for (const name of ['node_modules', '.git', '.ssh', '.env.local', 'AppData', 'cache', 'passwords.csv', 'server.pem', 'blob.txt', 'Default']) assert.ok(reasons.has(name), `${name} is reported`);
  assert.ok(result.skipped.some((entry) => /1 binary files/.test(entry.reason)));
  assert.ok(t.embedder.documents.every((text) => /^(notes\.md|data\.json)\n/.test(text)));
  t.done();
});

test('a file named on purpose is embedded even where a folder walk would skip it, and a walk of the parent leaves it', async () => {
  const t = setup();
  const inside = t.write('AppData/Roaming/App/notes.md', 'plan');
  const direct = await t.system.embed([inside]);
  assert.equal(direct.embedded, 1);
  const root = await t.system.embed([path.dirname(inside)]);
  assert.equal(root.unchanged, 1);
  await t.system.embed([t.work]); // walks past AppData
  const found = await t.system.search({ query: 'plan', in: [t.work] });
  assert.deepEqual(found.hits.map((hit) => hit.path), [inside]);
  t.done();
});

test('search filters by place prefix; a sibling with the same start is not below it', async () => {
  const t = setup();
  const a = t.write('a/one.md', 'the contract');
  const b = t.write('ab/two.md', 'the contract');
  await t.system.embed([a, b]);
  const inA = await t.system.search({ query: 'contract', in: [path.join(t.work, 'a')] });
  assert.deepEqual(inA.hits.map((hit) => hit.path), [a]);
  const both = await t.system.search({ query: 'contract', in: [path.join(t.work, 'a'), path.join(t.work, 'ab')] });
  assert.equal(both.hits.length, 2);
  t.done();
});

test('an empty memory folder is no reason to embed: no note, memory embeds itself', async () => {
  const t = setup();
  const found = await t.system.search({ query: 'contract', in: ['memory/agents/nobody'] });
  assert.deepEqual(found.hits, []);
  assert.equal(found.note, undefined);
  t.done();
});

test('nothing embedded under a place: a plain note, and the query is not embedded', async () => {
  const t = setup();
  const found = await t.system.search({ query: 'contract', in: [t.work] });
  assert.deepEqual(found.hits, []);
  assert.match(found.note ?? '', /Nothing embedded under /);
  assert.deepEqual(t.embedder.queries, []);
  t.done();
});

test('no embedder: both calls say so and nothing is stored', async () => {
  const t = setup();
  t.use(undefined);
  const file = t.write('a.md', 'plan');
  assert.equal(t.system.available(), false);
  const embedded = await t.system.embed([file]);
  assert.equal(embedded.embedded, 0);
  assert.match(embedded.skipped[0].reason, /files\.search/);
  const found = await t.system.search({ query: 'plan', in: [t.work] });
  assert.match(found.note ?? '', /files\.search/);
  t.done();
});

test('the budget stops a large folder; the next call goes on where it stopped', async () => {
  let clock = 1000;
  const t = setup({ now: () => clock });
  const slow = new FakeEmbedder();
  const inner = slow.embed.bind(slow);
  slow.embed = (texts, purpose) => { clock += 1000; return inner(texts, purpose); };
  t.use(slow);
  const long = Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\n${'the plan '.repeat(120)}`).join('\n\n');
  t.write('big.md', long);
  t.write('zz.md', 'the plan');
  const total = chunkText(long).length;
  assert.ok(total > 12);
  const first = await t.system.embed([t.work], { budgetMs: 2500 });
  assert.equal(first.remaining, 2);
  assert.ok(first.skipped.some((entry) => /chunks done/.test(entry.reason)));
  assert.ok(first.skipped.some((entry) => entry.path === '1 more files' && /call vector\.embed again/.test(entry.reason)));
  const partial = await t.system.search({ query: 'plan', in: [t.work] });
  assert.ok(partial.hits.length > 0, 'finished chunks are found already');
  const before = slow.documents.length;
  const second = await t.system.embed([t.work], { budgetMs: 1_000_000 });
  assert.equal(second.remaining, undefined);
  assert.equal(slow.documents.length - before, total - before + 1, 'only the missing chunks and the other file');
  t.done();
});

test('a model that fails is reported and what was stored stays', async () => {
  const t = setup();
  const a = t.write('a.md', 'plan');
  await t.system.embed([a]);
  t.embedder.fail = 'The embedding server could not be reached.';
  const b = t.write('b.md', 'plan');
  const result = await t.system.embed([b]);
  assert.equal(result.remaining, 1);
  assert.match(result.skipped[0].reason, /could not be reached/);
  assert.equal(result.skipped.length, 1);
  t.embedder.fail = undefined;
  const found = await t.system.search({ query: 'plan', in: [t.work] });
  assert.deepEqual(found.hits.map((hit) => hit.path), [a]);
  t.done();
});

test('another embedding model: old vectors are not compared and everything is redone in the background', async () => {
  const t = setup();
  const file = t.write('a.md', 'the contract');
  await t.system.embed([file]);
  const next = new FakeEmbedder();
  next.id = 'fake:2';
  t.use(next);
  const during = await t.system.search({ query: 'contract', in: [t.work] });
  assert.deepEqual(during.hits, []);
  await t.system.settled();
  assert.equal(next.documents.length, 1);
  const after = await t.system.search({ query: 'contract', in: [t.work] });
  assert.equal(after.hits.length, 1);
  t.done();
});

test('memory: written files are embedded by themselves, under "memory/…", and removed ones leave', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'facts.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'the server password policy');
  t.system.onFileChanged('company/facts.md');
  await t.system.settled();
  const found = await t.system.search({ query: 'server', in: ['memory'] });
  assert.equal(found.hits[0].path, 'memory/company/facts.md');
  const inFolder = await t.system.search({ query: 'server', in: ['memory/company'] });
  assert.equal(inFolder.hits.length, 1);
  const elsewhere = await t.system.search({ query: 'server', in: ['memory/agents'] });
  assert.deepEqual(elsewhere.hits, []);
  t.system.onFileRemoved('memory/company/facts.md');
  const gone = await t.system.search({ query: 'server', in: ['memory'] });
  assert.deepEqual(gone.hits, []);
  t.done();
});

test('a file that disappears from disk leaves the store at the next search', async () => {
  const t = setup();
  const file = t.write('a.md', 'plan');
  await t.system.embed([file]);
  rmSync(file);
  const found = await t.system.search({ query: 'plan', in: [t.work] });
  assert.deepEqual(found.hits, []);
  assert.match(found.note ?? '', /Nothing embedded/);
  t.done();
});

test('text that leaves the PC is redacted, and so are stored snippets', async () => {
  const redact = (text: string) => text.replaceAll('sk-secret', '[secret]');
  const t = setup({ redact });
  t.embedder.remote = true;
  const file = t.write('a.md', 'the plan uses sk-secret');
  await t.system.embed([file]);
  assert.ok(!t.embedder.documents[0].includes('sk-secret'));
  const found = await t.system.search({ query: 'plan', in: [file] });
  assert.ok(!found.hits[0].snippet.includes('sk-secret'));
  t.done();
});

test('chunks: headings and blank lines cut, line ranges hold, long lines are split, all text is kept', () => {
  const head = 'intro '.repeat(100);
  const text = `${head}\n\n# One\n${'alpha '.repeat(150)}\n\n# Two\n${'beta '.repeat(150)}\n${'x'.repeat(CHUNK_CHARS * 2 + 5)}\nend`;
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[0].from, 1);
  assert.ok(chunks.some((chunk) => chunk.text.startsWith('# One')));
  assert.ok(chunks.some((chunk) => chunk.text.includes('# Two')));
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_CHARS + 2));
  assert.ok(chunks[chunks.length - 1].text.endsWith('end'));
  assert.equal(chunks[chunks.length - 1].to, text.split('\n').length);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('\n\n  \n'), []);
  assert.deepEqual(chunkText(text), chunks, 'deterministic');
});

test('exclusions by name', () => {
  for (const name of ['.env', '.env.production', 'id_ed25519', 'bank-passwords.csv', 'credentials.json', 'login-export.csv', 'a.kdbx', 'x.pfx']) assert.ok(excluded(name, false), name);
  for (const name of ['notes.md', 'tokenizer.json', 'report.pdf', 'main.ts', 'login.ts', 'password-policy.md']) assert.equal(excluded(name, false), undefined, name);
  for (const name of ['node_modules', '.git', '.ssh', 'AppData', 'Cache', '__pycache__']) assert.ok(excluded(name, true), name);
  assert.equal(excluded('src', true), undefined);
});
