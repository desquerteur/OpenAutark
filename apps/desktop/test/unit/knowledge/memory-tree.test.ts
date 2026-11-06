// The memory tree (knowledge/memory-tree.ts, service.ts): files are the truth – one Markdown file per entry; write creates,
// updates or changes nothing; every write, direct edit and removal reaches the vectors; browse shows _folder.md; searching
// is vector.search over the caller's folders (words only without an embedder, never merged); the old rows move to files once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore, type MemoryVectors } from '../../../src/runtime/knowledge/service.ts';
import { insertItem } from '../../../src/runtime/knowledge/rows.ts';
import { folderOfScope, parseEntry, scopeOfPath, slugOf } from '../../../src/runtime/knowledge/memory-tree.ts';
import type { VectorHit } from '../../../src/shared/model/vectors.ts';

/** Waits for what the background pass does (its walk never holds up the event loop). */
const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

class FakeVectors implements MemoryVectors {
  up = true;
  changed: string[] = [];
  removed: string[] = [];
  embedded: string[][] = [];
  searches: Array<{ query: string; in: string[]; k?: number }> = [];
  hits: VectorHit[] = [];
  remaining = 0;
  available() { return this.up; }
  async embed(paths: string[]) {
    this.embedded.push(paths);
    const remaining = this.remaining;
    this.remaining = 0;
    return { embedded: 0, reembedded: 0, unchanged: 0, skipped: [], ...(remaining ? { remaining } : {}) };
  }
  async search(input: { query: string; in: string[]; k?: number }) {
    this.searches.push(input);
    return { hits: this.hits, searched: { places: input.in, embeddedFiles: this.hits.length } };
  }
  onFileChanged(file: string) { this.changed.push(file); }
  onFileRemoved(file: string) { this.removed.push(file); }
}

function world(t: { after(fn: () => void): void }, seed?: (db: Db) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'memory');
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const now = clock.now();
  db.run(`INSERT INTO spaces (id, name, kind, created_at) VALUES ('sp_a', 'Video branch', 'company', ?)`, [now]);
  db.run(`INSERT INTO agents (id, name, avatar, space_id, created_by, created_at, updated_at) VALUES ('ag_a', 'Ada', '{}', 'sp_a', 'human', ?, ?)`, [now, now]);
  db.run(`INSERT INTO agents (id, name, avatar, space_id, created_by, created_at, updated_at) VALUES ('ag_b', 'Ben', '{}', NULL, 'human', ?, ?)`, [now, now]);
  seed?.(db);
  const vectors = new FakeVectors();
  const store = new KnowledgeStore({ db, clock, root, vectors: () => vectors, redact: (text) => text.replaceAll('sk-secret', 'secret://sec_1') });
  return { dir, root, db, clock, vectors, store };
}

test('paths: scopes map to folders and back; a title gives a readable file name; nothing leaves the tree', (t) => {
  assert.equal(folderOfScope('global', undefined), 'company');
  assert.equal(folderOfScope('space', 'sp_a'), 'branches/sp_a');
  assert.equal(folderOfScope('website', 'github.com'), 'company/websites/github.com');
  assert.deepEqual(scopeOfPath('company/topic/x.md'), { scope: 'global' });
  assert.deepEqual(scopeOfPath('company/modes/video/x.md'), { scope: 'mode', scopeId: 'video' });
  assert.deepEqual(scopeOfPath('agents/ag_a/pinned/x.md'), { scope: 'agent', scopeId: 'ag_a' });
  assert.deepEqual(scopeOfPath('free/x.md'), { scope: 'global' });
  assert.equal(slugOf('Größe & Preis!'), 'groesse-preis');
  assert.equal(slugOf('???'), 'note');
  const { store } = world(t);
  assert.throws(() => store.memoryWrite({ path: '../outside.md', title: 'x', text: 'y' }), /Not a place/);
  assert.throws(() => store.memoryWrite({ folder: 'company/../../x', title: 'x', text: 'y' }), /Not a place/);
  assert.throws(() => store.memoryRead(path.resolve(os.tmpdir(), 'elsewhere.md')), /Not a place/);
});

test('write creates one Markdown file, updates it by title, changes nothing when nothing changed; the old state stays a version', (t) => {
  const { store, root, clock, vectors } = world(t);
  const made = store.memoryWrite({ folder: 'company/kunden', title: 'Rechnung Müller', text: 'Zahlt immer per Überweisung.', kind: 'fact', tags: ['kunde', 'a b'], source: 'human', by: 'ag_a' });
  assert.deepEqual(made, { path: 'company/kunden/rechnung-mueller.md', outcome: 'created' });
  const raw = readFileSync(path.join(root, 'company', 'kunden', 'rechnung-mueller.md'), 'utf8');
  assert.match(raw, /^---\ntitle: Rechnung Müller\nkind: fact\ntags: \[kunde, a b\]\nupdated: \d{4}-.*\nsource: human\nby: ag_a\n---\n\nZahlt immer per Überweisung\.\n$/);
  const read = store.memoryRead(made.path)!;
  assert.equal(read.title, 'Rechnung Müller');
  assert.deepEqual(read.tags, ['kunde', 'a b']);
  assert.equal(read.updated, clock.now());

  clock.advance(60_000);
  assert.equal(store.memoryWrite({ folder: 'company/kunden', title: 'Rechnung Müller', text: 'Zahlt immer per Überweisung.' }).outcome, 'unchanged');
  assert.equal(store.memoryRead(made.path)!.updated, read.updated, 'an unchanged entry keeps its date');
  assert.equal(vectors.changed.length, 1, 'and is not embedded again');

  const updated = store.memoryWrite({ path: made.path, title: 'Rechnung Müller', text: 'Zahlt per Lastschrift.' });
  assert.equal(updated.outcome, 'updated');
  const after = store.memoryRead(made.path)!;
  assert.equal(after.text, 'Zahlt per Lastschrift.');
  assert.equal(after.kind, 'fact', 'kept');
  assert.deepEqual(after.tags, ['kunde', 'a b'], 'kept');
  assert.deepEqual(store.history(made.path).map((item) => item.body), ['Zahlt immer per Überweisung.', 'Zahlt per Lastschrift.']);

  assert.equal(store.memoryWrite({ title: 'Secret', text: 'Key sk-secret here' }).path, 'company/secret.md', 'default folder company/');
  assert.match(store.memoryRead('company/secret.md')!.text, /secret:\/\/sec_1/, 'redacted before it is stored');
  assert.throws(() => store.memoryWrite({ title: ' ', text: 'x' }), /needs a title/);
});

test('a file anybody wrote is an entry: no frontmatter is fine, unknown frontmatter survives an update', (t) => {
  const { store, root } = world(t);
  mkdirSync(path.join(root, 'company'), { recursive: true });
  writeFileSync(path.join(root, 'company', 'loose.md'), '# Loose note\r\n\r\nJust text.\r\n');
  writeFileSync(path.join(root, 'company', 'custom.md'), '---\ntitle: "Custom: one"\nowner: Lea\n---\nBody\n');
  assert.equal(store.memoryRead('company/loose.md')!.title, 'Loose note');
  assert.equal(store.memoryRead('memory/company/loose')!.text.startsWith('# Loose note'), true, 'the "memory/" prefix and a missing .md are fine');
  store.memoryWrite({ path: 'company/custom.md', title: 'Custom: one', text: 'Body 2' });
  assert.match(readFileSync(path.join(root, 'company', 'custom.md'), 'utf8'), /owner: "Lea"/);
  assert.deepEqual(parseEntry('x/y.md', 'plain', 5).title, 'y');
});

test('a description: one line right after the title, kept by an update and a correction, a change of its own, removed by \'\'', (t) => {
  const { store, root, clock } = world(t);
  const file = path.join(root, 'company', 'kunden', 'rechnung-mueller.md');
  const made = store.memoryWrite({ folder: 'company/kunden', title: 'Rechnung Müller', text: 'Zahlt per Lastschrift.', description: ' When an invoice\n  to Müller is due. ', kind: 'fact' });
  assert.match(readFileSync(file, 'utf8'), /^---\ntitle: .+\ndescription: .+\nkind:/);
  assert.equal(store.memoryRead(made.path)!.description, 'When an invoice to Müller is due.');
  assert.equal(store.get('company:kunden:rechnung-mueller.md')!.description, 'When an invoice to Müller is due.');

  clock.advance(1000);
  assert.equal(store.memoryWrite({ path: made.path, title: 'Rechnung Müller', text: 'Zahlt per Lastschrift.' }).outcome, 'unchanged', 'left out: the old one stays');
  assert.equal(store.memoryWrite({ path: made.path, title: 'Rechnung Müller', text: 'Zahlt per Lastschrift.', description: 'When Müller pays.' }).outcome, 'updated', 'the description alone is a change');
  store.memoryWrite({ path: made.path, title: 'Rechnung Müller', text: 'Zahlt per Überweisung.' });
  assert.equal(store.memoryRead(made.path)!.description, 'When Müller pays.', 'an update keeps it');
  store.correct('company:kunden:rechnung-mueller.md', { body: 'Zahlt bar.' }, 'ag_a');
  assert.equal(store.memoryRead(made.path)!.description, 'When Müller pays.', 'a correction keeps it');

  assert.equal(store.memoryWrite({ path: made.path, title: 'Rechnung Müller', text: 'Zahlt bar.', description: '' }).outcome, 'updated');
  assert.equal(store.memoryRead(made.path)!.description, undefined);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /description/);
});

test('a hand-written description: quoted or a > block reads as one line; a list or a map stays in extra and survives a write', (t) => {
  const { store, root } = world(t);
  mkdirSync(path.join(root, 'company'), { recursive: true });
  writeFileSync(path.join(root, 'company', 'quoted.md'), '---\ntitle: Quoted\ndescription: "When: the \\"big\\" order comes"\n---\nBody\n');
  writeFileSync(path.join(root, 'company', 'block.md'), '---\ntitle: Block\ndescription: >\n  When a customer\n  asks for a refund.\nkind: fact\n---\nBody\n');
  writeFileSync(path.join(root, 'company', 'list.md'), '---\ntitle: List\ndescription: [a, b]\n---\nBody\n');
  writeFileSync(path.join(root, 'company', 'map.md'), '---\ntitle: Map\ndescription:\n  short: When X\n  long: When X and Y\n---\nBody\n');
  assert.equal(store.memoryRead('company/quoted.md')!.description, 'When: the "big" order comes');
  assert.equal(store.memoryRead('company/block.md')!.description, 'When a customer asks for a refund.');
  assert.equal(store.memoryRead('company/list.md')!.description, undefined);
  assert.equal(store.memoryRead('company/map.md')!.description, undefined);
  store.memoryWrite({ path: 'company/map.md', title: 'Map', text: 'Body 2' });
  assert.match(readFileSync(path.join(root, 'company', 'map.md'), 'utf8'), /\ndescription: \{"short":"When X","long":"When X and Y"\}\n/, 'a map is kept');
  assert.equal(store.memoryRead('company/map.md')!.description, undefined, 'and read back as a map, not as a line');
  store.memoryWrite({ path: 'company/map.md', title: 'Map', text: 'Body 3' });
  assert.match(readFileSync(path.join(root, 'company', 'map.md'), 'utf8'), /\ndescription: \{"short":"When X","long":"When X and Y"\}\n/, 'the same after a second write');

  store.memoryWrite({ path: 'company/block.md', title: 'Block', text: 'Body 2' });
  assert.match(readFileSync(path.join(root, 'company', 'block.md'), 'utf8'), /^---\ntitle: Block\ndescription: When a customer asks for a refund\.\nkind: fact\n/, 'written back as one line');
  store.memoryWrite({ path: 'company/list.md', title: 'List', text: 'Body 2' });
  assert.match(readFileSync(path.join(root, 'company', 'list.md'), 'utf8'), /\ndescription: \["a","b"\]\n/, 'a list nobody can read as a line is kept');
  store.memoryWrite({ path: 'company/list.md', title: 'List', text: 'Body 2', description: 'One line now.' });
  assert.equal(readFileSync(path.join(root, 'company', 'list.md'), 'utf8').match(/^description:/gm)?.length, 1, 'never two description lines');
});

test('browse and the word search see a description: at most 160 characters in a listing, no key without one', async (t) => {
  const { store, vectors } = world(t);
  store.memoryWrite({ folder: 'company/topic', title: 'Long', text: 'x', description: 'w'.repeat(300) });
  store.memoryWrite({ folder: 'company/topic', title: 'Kessler', text: 'Zahlt im Gutschriftverfahren.', description: 'When the turbine supplier sends a credit note.' });
  store.memoryWrite({ folder: 'company/topic', title: 'Plain', text: 'y' });
  const files = store.memoryBrowse('company/topic').files;
  assert.equal(files.find((file) => file.title === 'Long')!.description, 'w'.repeat(160));
  assert.equal(store.memoryRead('company/topic/long.md')!.description!.length, 300, 'the file keeps it whole');
  assert.equal('description' in files.find((file) => file.title === 'Plain')!, false);

  vectors.up = false;
  const hits = await store.search({ text: 'turbine', agentId: 'ag_a' });
  assert.deepEqual(hits.map((hit) => hit.item.id), ['company:topic:kessler.md'], 'a word only in the description finds the file');
  assert.match(hits[0].why, /matches 'turbine'/);
});

test('every write and removal through the API reaches the vectors with the absolute file; a folder description does not', (t) => {
  const { store, root, vectors } = world(t);
  const file = path.join(root, 'agents', 'ag_a', 'plan.md');
  store.memoryWrite({ folder: 'agents/ag_a', title: 'Plan', text: 'First plan' });
  assert.deepEqual(vectors.changed, [file]);
  store.memoryWrite({ path: 'agents/ag_a/plan.md', title: 'Plan', text: 'Second plan' });
  assert.deepEqual(vectors.changed, [file, file]);
  store.memoryWrite({ path: 'agents/ag_a/_folder.md', title: 'About', text: 'What this folder is.' });
  assert.equal(vectors.changed.length, 2);

  assert.deepEqual(store.memoryForget('agents/ag_a/plan.md'), { removed: true });
  assert.deepEqual(vectors.removed, [file]);
  assert.equal(existsSync(file), false);
  assert.deepEqual(store.history('agents:ag_a:plan.md'), [], 'with its old versions');
  assert.deepEqual(store.memoryForget('agents/ag_a/plan.md'), { removed: false });
  assert.throws(() => store.memoryForget('agents/ag_a'), /folder/);
});

test('a direct file edit, new file or removal the watcher reports reaches the vectors; own writes are not reported twice', async (t) => {
  const { store, root, vectors, clock } = world(t);
  const watcher = new RootWatcher({ root: path.dirname(root), clock, watch: false, debounceMs: 1 });
  watcher.start();
  store.startMemory(watcher);
  assert.throws(() => watcher.register('memory', () => undefined), /already has an owner/);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
  await settled();
  assert.deepEqual(vectors.embedded, [], 'an empty tree: nothing to embed');

  mkdirSync(path.join(root, 'company'), { recursive: true });
  const file = path.join(root, 'company', 'edited.md');
  writeFileSync(file, 'By hand.\n');
  watcher.nudge('memory', ['company', 'edited.md']);
  watcher.flush('memory');
  assert.deepEqual(vectors.changed, [file]);

  writeFileSync(path.join(root, 'company', 'other.md'), 'Stays.\n');
  rmSync(file);
  watcher.nudge('memory', ['company', 'edited.md']);
  watcher.flush('memory');
  assert.deepEqual(vectors.removed, [file]);

  watcher.nudge('memory', ['company', '_folder.md']);
  watcher.flush('memory');
  assert.equal(vectors.changed.length, 1, 'a description is no entry');

  mkdirSync(path.join(root, 'company', 'renamed'));
  writeFileSync(path.join(root, 'company', 'renamed', 'moved.md'), 'Moved here.\n');
  watcher.nudge('memory', ['company', 'renamed']);
  watcher.flush('memory');
  await until(() => vectors.embedded.length >= 1);
  assert.deepEqual(vectors.embedded, [[path.join(root, 'company', 'renamed', 'moved.md')]], 'a folder that came: only it is walked');

  watcher.nudge('memory');
  watcher.flush('memory');
  await until(() => vectors.embedded.length >= 2);
  assert.equal(vectors.embedded.length, 2, 'unknown change: the tree is checked');

  store.stopMemory();
  watcher.stop();
});

test('starting embeds the tree until nothing remains; without an embedder nothing is tried and writes still work', async (t) => {
  const { store, root, vectors } = world(t);
  store.memoryWrite({ path: 'company/build/token-notes.md', title: 'Token notes', text: 'A topic folder "build" and a note about tokens are memory too.' });
  store.memoryWrite({ path: 'company/_folder.md', title: 'About', text: 'No entry.' });
  vectors.remaining = 5;
  store.startMemory();
  await until(() => vectors.embedded.length >= 2);
  assert.equal(vectors.embedded.length, 2);
  assert.deepEqual(vectors.embedded[0], [path.join(root, 'company', 'build', 'token-notes.md')], 'by name, entries only');
  vectors.up = false;
  store.startMemory();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(vectors.embedded.length, 2);
  assert.equal(store.memoryWrite({ title: 'Works', text: 'still' }).outcome, 'created');
});

test('browse: the folder description, subfolders without counts, newest files with titles; the top explains itself', (t) => {
  const { store, clock } = world(t);
  const top = store.memoryBrowse();
  assert.deepEqual(top.folders.map((folder) => folder.path), ['agents', 'branches', 'company', 'references']);
  assert.match(top.folders.find((folder) => folder.path === 'company')!.description!, /whole company/);

  store.memoryWrite({ folder: 'company/kunden', title: 'Alt', text: 'old' });
  clock.advance(1000);
  store.memoryWrite({ folder: 'company/kunden', title: 'Neu', text: 'new', kind: 'fact' });
  store.memoryWrite({ path: 'company/kunden/_folder.md', title: 'Kunden', text: 'Alles über Kunden.' });
  store.memoryWrite({ folder: 'company/kunden/gross', title: 'Tief', text: 'deep' });

  const company = store.memoryBrowse('company');
  assert.deepEqual(company.folders, [{ path: 'company/kunden', description: 'Alles über Kunden.' }], 'no count of what is in memory (owner rule a)');
  const folder = store.memoryBrowse('memory/company/kunden');
  assert.equal(folder.description, 'Alles über Kunden.');
  assert.deepEqual(folder.files.map((file) => [file.path, file.title, file.kind]), [['company/kunden/neu.md', 'Neu', 'fact'], ['company/kunden/alt.md', 'Alt', 'note']].map(([p, title, kind]) => [p, title, kind === 'note' ? undefined : kind]));
  assert.deepEqual(folder.folders.map((entry) => entry.path), ['company/kunden/gross']);
  assert.deepEqual(store.memoryBrowse('company/nothing'), { path: 'company/nothing', folders: [], files: [] });

  for (let i = 0; i < 105; i++) store.memoryWrite({ folder: 'company/viel', title: `Datei ${i}`, text: `t${i}` });
  const big = store.memoryBrowse('company/viel');
  assert.equal(big.files.length, 100);
  assert.equal(big.more, true, "more files than shown, no count");
});

test('a new branch or agent folder says whose it is', (t) => {
  const { store } = world(t);
  store.save({ title: 'Own', body: 'x', scope: 'agent', scopeId: 'ag_a', createdBy: 'ag_a' });
  store.save({ title: 'Branch', body: 'x', scope: 'space', scopeId: 'sp_a', createdBy: 'ag_a' });
  assert.match(store.memoryBrowse('agents').folders[0].description!, /Ada/);
  assert.match(store.memoryBrowse('branches').folders[0].description!, /Video branch/);
});

test('searching = vectors over the caller\'s folders only; hits come back as items, one per file, filtered', async (t) => {
  const { store, vectors, clock } = world(t);
  const company = store.save({ title: 'Firma', body: 'Teydra Lab', scope: 'global', createdBy: 'human' });
  const branch = store.save({ title: 'Schnitt', body: 'Immer 9:16', scope: 'space', scopeId: 'sp_a', createdBy: 'human' });
  const own = store.save({ title: 'Eigenes', body: 'Mein Plan', scope: 'agent', scopeId: 'ag_a', kind: 'plan', createdBy: 'ag_a' });
  store.save({ title: 'Fremd', body: 'Bens Plan', scope: 'agent', scopeId: 'ag_b', createdBy: 'ag_b' });
  const reference = store.save({ title: 'Reason: x', body: 'because', scope: 'reference', scopeId: 'human', kind: 'reference', createdBy: 'human' });
  const ended = store.save({ title: 'Vorbei', body: 'old', scope: 'global', validTo: clock.now() - 1000, createdBy: 'human' });
  store.save({ title: 'Chat', body: 'nur hier', scope: 'conversation', scopeId: 'ch_1', createdBy: 'human' });
  const file = (id: string, score: number, chunk = 0): VectorHit => ({ path: `memory/${id.replace(/:/g, '/')}`, chunk, snippet: 's', score });
  vectors.hits = [file(own.id, 0.9), file(own.id, 0.8, 1), file(company.id, 0.7), file(ended.id, 0.6), file(branch.id, 0.5), file(reference.id, 0.4), { path: 'memory/company/gone.md', chunk: 0, snippet: 's', score: 0.3 }];

  const hits = await store.search({ text: 'plan', agentId: 'ag_a', limit: 3 });
  assert.deepEqual(vectors.searches[0].in, ['memory/company', 'memory/branches/sp_a', 'memory/agents/ag_a', 'memory/references'], 'company + branch + own + references, nothing else');
  assert.equal(vectors.searches[0].k, 9);
  assert.deepEqual(hits.map((hit) => hit.item.id), [own.id, company.id, branch.id], 'one hit per file, a past note and a removed file left out');
  assert.match(hits[0].why, /^similar meaning · saved /);
  assert.equal(hits[0].score, 0.9);

  await store.search({ text: 'plan', agentId: 'ag_b', conversationId: 'ch_1' });
  assert.deepEqual(vectors.searches[1].in, ['memory/company', 'memory/agents/ag_b', 'memory/references', 'memory/chats/ch_1']);
  await store.search({ text: 'plan' });
  assert.deepEqual(vectors.searches[2].in, ['memory'], 'the person: everything');
  await store.search({ text: 'plan', scopes: ['reference'] });
  assert.deepEqual(vectors.searches[3].in, ['memory/references']);
  assert.deepEqual((await store.search({ text: 'plan', agentId: 'ag_a', kinds: ['plan'] })).map((hit) => hit.item.id), [own.id]);
});

test('no embedder: words of the same folders instead, never both; an empty query is the readable set', async (t) => {
  const { store, vectors, clock } = world(t);
  const mine = store.save({ title: 'Video export', body: 'Der Export dauert lange.', scope: 'agent', scopeId: 'ag_a', createdBy: 'ag_a' });
  store.save({ title: 'Video export', body: 'Bens Export.', scope: 'agent', scopeId: 'ag_b', createdBy: 'ag_b' });
  clock.advance(1000);
  const company = store.save({ title: 'Rechnungen', body: 'Monatsende.', scope: 'global', createdBy: 'human' });
  vectors.up = false;
  const hits = await store.search({ text: 'export', agentId: 'ag_a' });
  assert.equal(vectors.searches.length, 0);
  assert.deepEqual(hits.map((hit) => hit.item.id), [mine.id]);
  assert.match(hits[0].why, /matches 'export'/);
  assert.deepEqual((await store.search({ text: 'invoice', agentId: 'ag_a' })).map((hit) => hit.item.id), [company.id], 'the vocabulary still works');
  assert.deepEqual((await store.search({ text: '', agentId: 'ag_a' })).map((hit) => hit.item.id), [company.id, mine.id]);
});

test('pinned = the pinned folders the agent reads, capped; nothing else from the tree', (t) => {
  const { store, root } = world(t);
  store.save({ title: 'Name', body: 'Alex', scope: 'global', pinned: true, createdBy: 'human' });
  store.save({ title: 'Mine', body: 'a', scope: 'agent', scopeId: 'ag_a', pinned: true, createdBy: 'ag_a' });
  store.save({ title: 'Bens', body: 'b', scope: 'agent', scopeId: 'ag_b', pinned: true, createdBy: 'ag_b' });
  store.save({ title: 'Plain', body: 'c', scope: 'global', createdBy: 'human' });
  assert.deepEqual(store.pinned('ag_a').map((item) => item.title), ['Name', 'Mine']);
  mkdirSync(path.join(root, 'branches', 'sp_a', 'pinned'), { recursive: true });
  writeFileSync(path.join(root, 'branches', 'sp_a', 'pinned', 'by-hand.md'), '# By hand\nMoved here by an editor.\n');
  assert.deepEqual(store.pinned('ag_a').map((item) => item.title), ['Name', 'By hand', 'Mine'], 'putting a file there is all it takes');
});

test('the old rows move to files once – with their place, kind, source and pin; observations stay; an old id still finds its file', async (t) => {
  const now = Date.UTC(2026, 9, 1);
  const row = (id: string, scope: string, scopeId: string | null, kind: string, title: string, body: string, extra: Record<string, unknown> = {}) => ({
    id, scope, scopeId: scopeId ?? undefined, kind, title, body, tags: ['t'], source: { kind: 'message', ref: 'msg_1', trusted: false }, confidence: 0.9, pinned: false,
    recordedAt: now, createdBy: 'ag_a', uses: 0, ...extra,
  });
  const f = world(t, (db) => {
    for (const item of [
      row('kn_old', 'global', null, 'fact', 'Firma', 'Alte Fassung', { expiredAt: now - 1000 }),
      row('kn_new', 'global', null, 'fact', 'Firma', 'Teydra Lab', { supersedes: 'kn_old' }),
      row('kn_pin', 'agent', 'ag_a', 'preference', 'Stil', 'Kurz', { pinned: true }),
      row('kn_ref', 'reference', 'human', 'reference', 'Reason: x', 'weil'),
      row('kn_site', 'website', 'github.com', 'note', 'Upload', 'Button oben'),
      row('kn_obs', 'conversation', 'ch_1', 'observation', 'Chat observations up to #3', 'Summary', { tags: ['compaction'] }),
    ]) insertItem(db, item as never);
    db.run(`INSERT INTO knowledge_fts (knowledge_id, title, body) VALUES ('kn_new', 'firma', 'teydra')`);
  });
  const file = path.join(f.root, 'company', 'firma.md');
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /title: Firma\nkind: fact\ntags: \[t\]\nupdated: 2026-10-01T00:00:00.000Z\nsource: "message:msg_1"\nby: ag_a\nconfidence: 0.9\nuntrusted: true\n---\n\nTeydra Lab\n/);
  const item = f.store.get('company:firma.md')!;
  assert.deepEqual(item.source, { kind: 'message', ref: 'msg_1', trusted: false });
  assert.equal(item.confidence, 0.9);
  assert.equal(item.recordedAt, now);
  assert.deepEqual(f.store.history('company:firma.md').map((version) => version.body), ['Alte Fassung', 'Teydra Lab'], 'the old version stays linked');
  assert.ok(existsSync(path.join(f.root, 'agents', 'ag_a', 'pinned', 'stil.md')));
  assert.ok(existsSync(path.join(f.root, 'references', 'human', 'reason-x.md')));
  assert.ok(existsSync(path.join(f.root, 'company', 'websites', 'github.com', 'upload.md')));
  assert.equal(f.store.get('kn_new')!.body, 'Teydra Lab', 'an old id finds its file');
  assert.equal(f.db.get<{ n: number }>(`SELECT count(*) AS n FROM knowledge WHERE expired_at IS NULL AND kind <> 'observation'`)!.n, 0);
  assert.equal(f.db.get<{ n: number }>(`SELECT count(*) AS n FROM knowledge_fts WHERE knowledge_id = 'kn_new'`)!.n, 0);
  assert.equal((await f.store.list({ scope: 'conversation', kind: 'observation' }))[0].id, 'kn_obs', 'observations stay rows');

  // Once: a second store on the same data moves nothing and writes no second file.
  const again = new KnowledgeStore({ db: f.db, clock: f.clock, root: f.root });
  assert.equal((await again.list({ scope: 'global' })).length, 1);
  assert.ok(!existsSync(path.join(f.root, 'company', 'firma-2.md')));

  // The moved files are embedded once by the start.
  f.store.startMemory();
  await until(() => f.vectors.embedded.length >= 1);
  assert.equal(f.vectors.embedded.length, 1);
  assert.equal(f.vectors.embedded[0].length, 4);
  assert.ok(f.vectors.embedded[0].includes(file));
});

test('without a root the tree lies next to the database file', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-memory-db-'));
  const db = new Db(path.join(dir, 'workforce.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrate(db);
  const store = new KnowledgeStore({ db, clock: new ManualClock() });
  assert.equal(store.memoryRoot, path.join(dir, 'memory'));
  store.save({ title: 'Hier', body: 'x', scope: 'global', createdBy: 'human' });
  assert.ok(existsSync(path.join(dir, 'memory', 'company', 'hier.md')));
});
