// knowledge.list, knowledge.remember and the word search walk a whole scope with the event loop free (at 100,000 files a sync walk
// stops the app), and the async walk finds what the sync one finds: entries only, newest first.
// Owns: these assertions only. Never: real models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { MemoryTree } from '../../../src/runtime/knowledge/memory-tree.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import { readTextAsync, readText } from '../../../src/runtime/root/text-doc.ts';

const FILES = 240;

function world(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'company');
  mkdirSync(folder, { recursive: true });
  for (let index = 0; index < FILES; index++) writeFileSync(path.join(folder, `note-${index}.md`), `---\ntitle: Note ${index}\nkind: fact\n---\n\nDie Notiz Nummer ${index} zum Angebot.\n`);
  const db = new Db(':memory:');
  migrate(db);
  const store = new KnowledgeStore({ db, clock: new ManualClock(), root });
  return { root, folder, store };
}

/** How often the event loop came round while `work` ran (a sync walk: never). */
async function turnsDuring<T>(work: () => Promise<T>): Promise<{ turns: number; result: T }> {
  let turns = 0;
  let running = true;
  const round = () => { turns++; if (running) setImmediate(round); };
  setImmediate(round);
  const result = await work();
  running = false;
  return { turns, result };
}

test('knowledge.list and its kinds leave the event loop free', async (t) => {
  const w = world(t);
  const list = await turnsDuring(() => w.store.list({ scope: 'global', limit: 500 }));
  assert.equal(list.result.length, FILES);
  assert.ok(list.turns > 20, `the loop came round ${list.turns} times`);
  const kinds = await turnsDuring(() => w.store.kinds());
  assert.deepEqual(kinds.result, ['fact']);
  assert.ok(kinds.turns > 20, `the loop came round ${kinds.turns} times`);
});

test('the word search without an embedder leaves the event loop free', async (t) => {
  const w = world(t);
  const found = await turnsDuring(() => w.store.search({ text: 'Nummer 17 Angebot', limit: 5 }));
  assert.equal(found.result.length, 5);
  assert.ok(found.turns > 20, `the loop came round ${found.turns} times`);
});

test('knowledge.remember leaves the event loop free', async (t) => {
  const w = world(t);
  const remember = memoryTools.find((tool) => tool.name === 'knowledge.remember')!;
  const ctx = { services: { knowledge: w.store, clock: new ManualClock() }, agent: { id: 'ag_a' }, runId: 'run_1' } as never;
  const saved = await turnsDuring(() => remember.run({ title: 'Neu', body: 'Etwas ganz Neues.', scope: 'global' }, ctx));
  assert.equal((saved.result.structured as { outcome: string }).outcome, 'added');
  assert.ok(saved.turns > 20, `the loop came round ${saved.turns} times`);
});

test('the async walk finds what the sync one finds: entries only, newest first, a cut list keeps the newest', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, seconds: number) => {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'text');
    utimesSync(file, seconds, seconds);
  };
  put('company/a.md', 100);
  put('company/topic/b.md', 300);
  put('company/_folder.md', 400);
  put('company/_drafts/c.md', 500);
  put('company/.hidden/d.md', 600);
  put('company/e.txt', 700);
  put('agents/ag_a/f.md', 200);
  const tree = new MemoryTree(() => root);
  for (const folders of [[''], ['company'], ['company', 'agents/ag_a'], ['nothing/here']]) {
    assert.deepEqual(await tree.filesAsync(folders), tree.files(folders), folders.join());
  }
  assert.deepEqual((await tree.filesAsync(['']))[0].rel, 'company/topic/b.md');
  assert.deepEqual((await tree.filesAsync([''], 2)).map((file) => file.rel), ['company/topic/b.md', 'agents/ag_a/f.md']);
  assert.equal((await tree.readAsync('company/a.md'))?.text, tree.read('company/a.md')?.text);
  assert.equal(await tree.readAsync('company/nope.md'), undefined);
});

test('readTextAsync judges a file as readText does', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-walk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases: Array<[string, Buffer]> = [['ok.md', Buffer.from('﻿Hallo\r\nWelt\n')], ['nul.md', Buffer.from([65, 0, 66])], ['latin.md', Buffer.from([0xe4, 0x20])], ['big.md', Buffer.alloc(20, 65)]];
  for (const [name, body] of cases) {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    assert.deepEqual(await readTextAsync(file, { maxBytes: 16 }), readText(file, { maxBytes: 16 }), name);
  }
  assert.deepEqual(await readTextAsync(path.join(dir, 'none.md'), { maxBytes: 16 }), { kind: 'missing' });
  assert.equal((await readTextAsync(dir, { maxBytes: 16 })).kind, 'problem');
});
