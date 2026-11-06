// The review of the vector system: a re-embedding that fails keeps the old vectors, a walk leaves time to embed and never
// promises what a next call cannot do, a drive is a place to search but not to embed, a folder that is secrets as a whole stays
// out, a query leaves the PC redacted, a memory hit shows its text (its first chunk with the title and description), and
// vectors never leave because a drive is away.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { sql } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import type { Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { unit } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem, type VectorDeps } from '../../../src/runtime/vectors/service.ts';

const WORDS = ['invoice', 'server', 'soup', 'contract', 'plan', 'cat'];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 4;
  remote = false;
  documents: string[] = [];
  queries: string[] = [];
  fail?: string;
  during?: () => void;
  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    if (this.fail) throw new Error(this.fail);
    (purpose === 'query' ? this.queries : this.documents).push(...texts);
    const during = this.during;
    this.during = undefined;
    during?.();
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function setup(over: Partial<VectorDeps> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vectors-review-'));
  const db = new Db(path.join(dir, 'test.db'));
  db.exec(sql);
  db.exec('CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;');
  const embedder = new FakeEmbedder();
  const memoryRoot = path.join(dir, 'data', 'memory');
  mkdirSync(memoryRoot, { recursive: true });
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const system = new VectorSystem({ db, memoryRoot, embedder: () => embedder, changeDelayMs: 0, ...over });
  return {
    dir, db, embedder, system, memoryRoot, work,
    write: (name: string, body: string) => {
      const file = path.join(work, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
    done: () => { system.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const later = (file: string) => utimesSync(file, new Date(), new Date(Date.now() + 5000));

test('a re-embedding whose model fails keeps the old vectors', async () => {
  const t = setup();
  const file = t.write('a.md', 'the server notes');
  await t.system.embed([file]);
  writeFileSync(file, 'the contract now');
  later(file);
  t.embedder.fail = 'The embedding server could not be reached.';
  const failed = await t.system.embed([file]);
  assert.equal(failed.failed, true);
  t.embedder.fail = undefined;
  const row = t.system.store.filesUnder(t.work.replaceAll('\\', '/').toLowerCase())[0] ?? t.system.store.filesUnder(t.work.replaceAll('\\', '/'))[0];
  assert.ok(row, 'the file stays embedded');
  assert.ok(row.done > 0, 'its old chunks are still there');
  t.done();
});

test('a walk that eats the time still leaves time to embed what it found', async () => {
  let clock = 1000;
  const t = setup({ now: () => (clock += 400) });
  for (let i = 0; i < 12; i++) t.write(`folder${i}/note.md`, `the plan ${i}`);
  const result = await t.system.embed([t.work], { budgetMs: 6000 });
  assert.ok(result.embedded > 0, 'something was embedded');
  t.done();
});

test('a folder too big to walk says so instead of asking for another call that would end the same way', async () => {
  let clock = 1000;
  const t = setup({ now: () => (clock += 2000) });
  for (let i = 0; i < 10; i++) t.write(`folder${i}/note.md`, `the plan ${i}`);
  const result = await t.system.embed([t.work], { budgetMs: 3000 });
  const line = result.skipped.find((entry) => entry.path === t.work);
  assert.ok(line, 'the folder is reported');
  assert.match(line.reason, /subfolders/);
  assert.doesNotMatch(line.reason, /call vector\.embed again/);
  t.done();
});

test('a drive: searching it is a filter over what is embedded, embedding it is refused in plain words', async () => {
  const t = setup();
  const file = t.write('a.md', 'the contract');
  await t.system.embed([file]);
  const root = path.parse(file).root;
  const found = await t.system.search({ query: 'contract', in: [root] });
  assert.deepEqual(found.hits.map((hit) => hit.path), [file]);
  assert.equal(found.note, undefined);
  const before = t.embedder.documents.length;
  const refused = await t.system.embed([root]);
  assert.equal(refused.embedded, 0);
  assert.match(refused.skipped[0].reason, /whole drive/);
  assert.equal(t.embedder.documents.length, before);
  t.done();
});

test('a folder that is secrets or a browser profile as a whole stays out, also when it is the folder named', async () => {
  const t = setup();
  t.write('.ssh/config', 'Host plan');
  t.write('.ssh/keys/notes.txt', 'plan');
  t.write('Chrome/User Data/Local State', '{"os_crypt":{"encrypted_key":"plan"}}');
  t.write('Chrome/User Data/Default/Login Data', 'x');
  t.write('Chrome/User Data/Default/Preferences', '{"plan":1}');
  t.write('AppData/Roaming/App/settings.txt', 'plan');
  for (const place of ['.ssh', path.join('.ssh', 'keys'), path.join('Chrome', 'User Data'), path.join('Chrome', 'User Data', 'Default'), 'AppData', path.join('AppData', 'Roaming')]) {
    const result = await t.system.embed([path.join(t.work, place)]);
    assert.equal(result.embedded, 0, place);
    assert.equal(result.skipped.length, 1, place);
  }
  assert.deepEqual(t.embedder.documents, []);
  t.done();
});

test('a file that cannot be read right now (locked) keeps its vectors', async () => {
  let locked = false;
  const t = setup({ readFile: async (file) => (locked ? { skip: 'not readable' } : (await import('node:fs/promises')).readFile(file, 'utf8')) });
  const file = t.write('a.md', 'the plan');
  await t.system.embed([file]);
  writeFileSync(file, 'the plan and the contract');
  later(file);
  locked = true;
  const result = await t.system.embed([file]);
  assert.ok(result.skipped.some((entry) => entry.reason === 'not readable'));
  const found = await t.system.search({ query: 'plan', in: [file] });
  assert.equal(found.hits.length, 1, 'the old vectors are still found');
  t.done();
});

test('a memory file changed while its job runs is embedded again', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'a.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'the server notes');
  t.embedder.during = () => {
    writeFileSync(file, 'the contract now');
    later(file);
    t.system.onFileChanged(file);
  };
  t.system.onFileChanged(file);
  await t.system.settled();
  assert.ok(t.embedder.documents.some((text) => text.includes('the contract now')), 'the later text is embedded too');
  t.done();
});

test('a file removed while its job runs: no error for the model, nothing of it stays', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'a.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'the plan '.repeat(120)}`).join('\n\n'));
  t.embedder.during = () => {
    rmSync(file);
    t.system.onFileRemoved(file);
  };
  const result = await t.system.embed([file]);
  assert.equal(result.failed, undefined, 'a removed file is no failed model');
  assert.deepEqual(t.system.store.filesUnder('memory').map((row) => row.path), []);
  assert.equal(t.db.get<{ n: number }>('SELECT count(*) AS n FROM vector_chunks')?.n, 0);
  t.done();
});

test('a file forgotten between its read and its first chunk does not come back', async () => {
  const t = setup({
    readFile: async (file) => {
      const body = (await import('node:fs/promises')).readFile(file, 'utf8');
      const text = await body;
      rmSync(file);
      t.system.onFileRemoved(file);
      return text;
    },
  });
  const file = path.join(t.memoryRoot, 'company', 'a.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'the plan');
  await t.system.embed([file]);
  assert.ok(!existsSync(file));
  assert.deepEqual(t.system.store.filesUnder('memory').map((row) => row.path), []);
  t.done();
});

test('a query that leaves the PC is redacted', async () => {
  const t = setup({ redact: (text) => text.replaceAll('sk-secret', '[secret]') });
  t.embedder.remote = true;
  const file = t.write('a.md', 'the plan');
  await t.system.embed([file]);
  await t.system.search({ query: 'plan with sk-secret', in: [t.work] });
  assert.deepEqual(t.embedder.queries, ['plan with [secret]']);
  t.done();
});

test('a query that waited in vain: the next one does not wait again', async () => {
  const t = setup({ queryWaitMs: 5 });
  const file = t.write('a.md', 'the plan');
  await t.system.embed([file]);
  let asked = 0;
  t.embedder.embed = () => { asked++; return new Promise(() => undefined); };
  const first = await t.system.search({ query: 'plan', in: [t.work] });
  assert.match(first.note ?? '', /still loading/);
  assert.equal(asked, 1);
  const second = await t.system.search({ query: 'plan', in: [t.work] });
  assert.match(second.note ?? '', /still loading/);
  assert.equal(asked, 1, 'no second wait within the pause');
  t.done();
});

test('k below one still gives the best hit', async () => {
  const t = setup();
  const file = t.write('a.md', 'the plan');
  await t.system.embed([file]);
  const found = await t.system.search({ query: 'plan', in: [t.work], k: 0 });
  assert.equal(found.hits.length, 1);
  t.done();
});

test('a memory hit shows the text, not the frontmatter, and the line numbers stay true', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'a.md');
  mkdirSync(path.dirname(file), { recursive: true });
  const head = `---\ntitle: Vertrag\nkind: fact\ntags: [a, b]\nupdated: 2026-11-01T10:00:00.000Z\nsource: "run:run_0123456789abcdef0123456789abcdef"\nby: ag_0123456789abcdef\n---\n\n`;
  writeFileSync(file, `${head}The contract runs until March.\n`);
  t.system.onFileChanged(file);
  await t.system.settled();
  const found = await t.system.search({ query: 'contract', in: ['memory'] });
  assert.equal(found.hits.length, 1);
  assert.match(found.hits[0].snippet, /^Vertrag\s+The contract runs/);
  assert.equal(found.hits[0].lines?.[1], 11);
  assert.ok(!t.embedder.documents.some((text) => text.includes('run_0123')), 'ids and dates are not embedded');
  t.done();
});

test('a memory hit\'s first chunk starts with its title and description, a > block folded; the lines stay true', async () => {
  const t = setup();
  const file = path.join(t.memoryRoot, 'company', 'b.md');
  mkdirSync(path.dirname(file), { recursive: true });
  const head = `---\ntitle: Vertrag\ndescription: >\n  When the contract\n  with the server host ends.\nkind: fact\nupdated: 2026-11-01T10:00:00.000Z\nsource: "run:run_0123456789abcdef0123456789abcdef"\n---\n\n`;
  writeFileSync(file, `${head}The contract runs until March.\n`);
  t.system.onFileChanged(file);
  await t.system.settled();
  const found = await t.system.search({ query: 'contract', in: ['memory'] });
  assert.equal(found.hits.length, 1);
  assert.match(found.hits[0].snippet, /^Vertrag\s+When the contract with the server host ends\.\s+The contract runs/);
  assert.equal(found.hits[0].lines?.[1], 12);
  assert.ok(!t.embedder.documents.some((text) => text.includes('run_0123') || text.includes('2026-11-01')), 'no run id or date is embedded');
  t.done();
});

test('vectors of a drive that is away stay; a file really gone leaves', { skip: process.platform !== 'win32' }, async () => {
  const t = setup();
  const free = 'QXYWVTSRPONMLKJIHG'.split('').find((letter) => !existsSync(`${letter}:\\`));
  assert.ok(free);
  const away = `${free}:\\backup\\a.md`;
  const key = `${free.toLowerCase()}:/backup/a.md`;
  const id = t.system.store.begin(key, away, 1, 1, t.embedder.id, 1);
  t.system.store.put(id, [{ chunk: 0, snippet: 'the plan', vector: Int8Array.from(unit([0, 0, 0, 0, 1, 0, 0.01]), (value) => Math.round(value * 127)) }], 1);
  const gone = t.write('a.md', 'the plan');
  await t.system.embed([gone]);
  rmSync(gone);
  const found = await t.system.search({ query: 'plan', in: [`${free}:\\backup`, t.work] });
  assert.deepEqual(found.hits.map((hit) => hit.path), [away]);
  assert.ok(t.system.store.file(key), 'still stored');
  await t.system.embed([`${free}:\\backup`]);
  assert.ok(t.system.store.file(key), 'an embed of a place that is away drops nothing');
  t.done();
});
