// A write in a known folder never walks the tree (knowledge/memory-follow.ts): Windows reports a folder too when a file in it is written. Only a folder new here is
// walked, and only it; a folder that went and came again counts as new; the watcher's "unknown" still looks at everything.
// Owns: these assertions only. Never: real models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { MemoryFollow } from '../../../src/runtime/knowledge/memory-follow.ts';
import { MemoryTree } from '../../../src/runtime/knowledge/memory-tree.ts';
import type { RootEvent } from '../../../src/runtime/root/watcher.ts';

const settle = async (follow: MemoryFollow) => { await (follow as unknown as { embedding?: Promise<void> }).embedding; };

function world(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-follow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (rel: string) => { const full = path.join(root, ...rel.split('/')); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, `# ${rel}\n`); };
  file('company/a.md'); file('company/sub/b.md'); file('agents/x/c.md');
  const named: string[][] = [];
  const vectors = {
    available: () => true,
    embed: async (paths: string[]) => { named.push(paths.map((one) => path.relative(root, one).replace(/\\/g, '/'))); return { embedded: 0, reembedded: 0, unchanged: paths.length, skipped: [] }; },
    search: async () => ({ hits: [], searched: { places: [], embeddedFiles: 0 } }),
    onFileChanged: () => {}, onFileRemoved: () => {},
  };
  const db = new Db(':memory:');
  migrate(db);
  const events: Array<(event: RootEvent) => void> = [];
  const follow = new MemoryFollow({ db, now: () => 1, tree: new MemoryTree(() => root), vectors: () => vectors });
  t.after(() => follow.stop());
  return { root, file, named, follow, events, watcher: { register: (_name: string, run: (event: RootEvent) => void) => { events.push(run); return () => {}; } } };
}

test('the report of a known folder walks nothing; a new one is walked alone; what went and came again is new; unknown looks at everything', async (t) => {
  const w = world(t);
  await w.follow.start(w.watcher);
  await settle(w.follow);
  assert.deepEqual(w.named.flat().sort(), ['agents/x/c.md', 'company/a.md', 'company/sub/b.md']);
  w.named.length = 0;
  const report = (parts?: string[]) => w.events[0](parts ? { parts } : {});
  report(['company']);
  report(['company', 'sub']);
  report(['agents']);
  report([]);
  await settle(w.follow);
  assert.deepEqual(w.named, [], 'a file written in a known folder reports itself');
  w.file('chats/ch_1/d.md');
  report(['chats']);
  await settle(w.follow);
  assert.deepEqual(w.named.flat(), ['chats/ch_1/d.md'], 'only what is new');
  w.named.length = 0;
  report(['chats', 'ch_1']);
  await settle(w.follow);
  assert.deepEqual(w.named, [], 'that walk came through the subfolder');
  rmSync(path.join(w.root, 'chats'), { recursive: true });
  report(['chats']);
  w.file('chats/ch_1/e.md');
  report(['chats']);
  await settle(w.follow);
  assert.deepEqual(w.named.flat(), ['chats/ch_1/e.md'], 'it went and came again');
  w.named.length = 0;
  report();
  await settle(w.follow);
  assert.equal(w.named.flat().length, 4, 'the system lost track: everything');
  w.named.length = 0;
  rmSync(w.root, { recursive: true });
  report([]);
  w.file('company/f.md');
  report([]);
  await settle(w.follow);
  assert.deepEqual(w.named.flat(), ['company/f.md'], 'the tree went and came again');
});
