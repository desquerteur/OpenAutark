// KnowledgeStore (the old calls over the memory files): German word folding, folders by scope, correct/expire/history,
// pinned cap and redaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore, PINNED_CHAR_CAP } from '../../../src/runtime/knowledge/service.ts';
import { foldText, ftsQuery } from '../../../src/runtime/knowledge/normalize.ts';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const now = clock.now();
  db.run(`INSERT INTO spaces (id, name, kind, created_at) VALUES ('sp_a', 'Company', 'company', ?)`, [now]);
  for (const [id, space] of [['ag_a', 'sp_a'], ['ag_b', null]] as const) {
    db.run(`INSERT INTO agents (id, name, avatar, space_id, created_by, created_at, updated_at) VALUES (?, ?, '{}', ?, 'human', ?, ?)`, [id, id, space, now, now]);
  }
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('ch_1', 'One', 'human', ?, ?)`, [now, now]);
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('ch_2', 'Two', 'human', ?, ?)`, [now, now]);
  db.run(`INSERT INTO members (conversation_id, member_id, kind, joined_at) VALUES ('ch_1', 'ag_a', 'agent', ?)`, [now]);
  return { db, clock, store: new KnowledgeStore({ db, clock }) };
}

test('foldText folds German umlauts and diacritics', () => {
  assert.equal(foldText('Größe MÜLLER Straße Café'), 'groesse mueller strasse cafe');
  assert.equal(ftsQuery('Die Größe der Datei?'), '"groesse"* OR "datei"*');
  assert.equal(ftsQuery('ja und'), undefined);
});

test('FTS matches across umlaut spellings', async () => {
  const { store } = setup();
  store.save({ title: 'Lieferant Müller', body: 'Bestellungen bei Müller GmbH immer per E-Mail.', scope: 'global', createdBy: 'human' });
  store.save({ title: 'Unrelated', body: 'Nothing about suppliers.', scope: 'global', createdBy: 'human' });
  for (const text of ['mueller', 'Müller', 'MÜLLER bestellungen']) {
    const hits = await store.search({ text });
    assert.equal(hits.length, 1, text);
    assert.equal(hits[0].item.title, 'Lieferant Müller');
    assert.match(hits[0].why, /matches 'mueller/);
  }
  const hits = await store.search({ text: 'Groesse' });
  assert.equal(hits.length, 0);
});

test('ACL: agent sees global, own space, own items, member chats, websites – not others', async () => {
  const { store } = setup();
  const make = (title: string, scope: 'global' | 'space' | 'agent' | 'conversation' | 'website', scopeId?: string) =>
    store.save({ title, body: `youtube upload ${title}`, scope, scopeId, createdBy: 'human' });
  make('g', 'global'); make('space-a', 'space', 'sp_a'); make('space-x', 'space', 'sp_x');
  make('own', 'agent', 'ag_a'); make('other', 'agent', 'ag_b');
  make('chat-1', 'conversation', 'ch_1'); make('chat-2', 'conversation', 'ch_2'); make('site', 'website', 'youtube.com');
  const titles = async (agentId?: string, extra: object = {}) =>
    (await store.search({ text: 'youtube upload', agentId, limit: 50, ...extra })).map(hit => hit.item.title).sort();
  assert.deepEqual(await titles('ag_a'), ['chat-1', 'g', 'own', 'site', 'space-a']);
  assert.deepEqual(await titles('ag_b'), ['g', 'other', 'site']);
  assert.equal((await titles()).length, 8); // the human sees everything
  assert.deepEqual(await titles('ag_a', { scopes: ['agent', 'global'] }), ['g', 'own']);
});

test('correct keeps the old state as a version; history has both; expire takes a note out of the search', async () => {
  const { store, clock } = setup();
  const first = store.save({ title: 'Office address', body: 'Office is in Hamburg', kind: 'fact', scope: 'global', createdBy: 'human' });
  clock.advance(60_000);
  const second = store.correct(first.id, { body: 'Office is in Berlin' }, 'human');
  assert.equal(second.id, first.id);
  assert.equal(second.supersedes, first.id);
  assert.equal(store.get(first.id)!.body, 'Office is in Berlin');

  const now = await store.search({ text: 'office' });
  assert.deepEqual(now.map(hit => hit.item.body), ['Office is in Berlin']);
  assert.deepEqual(store.history(first.id).map(item => item.body), ['Office is in Hamburg', 'Office is in Berlin']);

  // save() with an existing id is a correction, never an overwrite
  clock.advance(1000);
  const third = store.save({ id: second.id, title: 'Office address', body: 'Office is in Munich', scope: 'global', createdBy: 'human' });
  assert.equal(third.body, 'Office is in Munich');
  assert.equal(store.history(third.id).length, 3);

  store.expire(third.id, 'human', 'moved out');
  assert.deepEqual(await store.search({ text: 'office' }), []);
  assert.deepEqual(await store.list({}), []);
  assert.ok(store.get(third.id)!.expiredAt, 'until retention removes it, the last state is still there');
  assert.equal(store.history(third.id).length, 3);
});

test('validity window: validTo in the past hides the fact', async () => {
  const { store, clock } = setup();
  store.save({ title: 'Promo', body: 'Promo code SUMMER valid', scope: 'global', createdBy: 'human', validTo: clock.now() + 1000 });
  assert.equal((await store.search({ text: 'promo' })).length, 1);
  clock.advance(2000);
  assert.equal((await store.search({ text: 'promo' })).length, 0);
});

test('pinned is visible-only and deterministic; a huge note is kept (the one cap renders it by its description, knowledge/always.ts)', () => {
  const { store } = setup();
  store.save({ title: 'User name', body: 'The user is called Alex.', scope: 'global', pinned: true, createdBy: 'human' });
  store.save({ title: 'Other agent pin', body: 'secret plan', scope: 'agent', scopeId: 'ag_b', pinned: true, createdBy: 'human' });
  store.save({ title: 'Huge', body: 'x'.repeat(PINNED_CHAR_CAP), scope: 'agent', scopeId: 'ag_a', pinned: true, createdBy: 'human' });
  store.save({ title: 'Own pin', body: 'Prefers short answers.', scope: 'agent', scopeId: 'ag_a', pinned: true, createdBy: 'human' });
  const pins = store.pinned('ag_a');
  assert.equal(pins[0].title, 'User name');
  assert.deepEqual(pins.map(item => item.title).sort(), ['Huge', 'Own pin', 'User name']);
  assert.deepEqual(store.pinned('ag_a').map(item => item.id), pins.map(item => item.id), 'the same set in the same order');
});

test('save validates and redacts secret values', () => {
  const db = new Db(':memory:');
  migrate(db);
  const store = new KnowledgeStore({ db, clock: new ManualClock(), redact: text => text.replaceAll('hunter2-long-secret', 'secret://sec_1') });
  const item = store.save({ title: 'Login', body: 'Password is hunter2-long-secret', scope: 'global', createdBy: 'ag_a' });
  assert.equal(item.body, 'Password is secret://sec_1');
  assert.throws(() => store.save({ title: 'x', body: 'y', scope: 'agent', createdBy: 'human' }), /needs a scopeId/);
  assert.throws(() => store.save({ title: '', body: 'y', scope: 'global', createdBy: 'human' }), /title and a body/);
});
