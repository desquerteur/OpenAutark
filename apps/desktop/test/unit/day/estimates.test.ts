// B-041 track A2: learned time estimates (runtime/day/estimates.ts) – said > the person's latest correction > the
// mean of ≥ 2 measured times > the model > the category's mean > 30; one key for "die Küche aufräumen" and "Küche
// aufräumen", per member; counters only (no task text in task_estimates); a correction is not moved by measured
// times; values kept within 1 min – 24 h.
// Owns: checks of TaskEstimates only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { TaskEstimates } from '../../../src/runtime/day/estimates.ts';

function estimates() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(Date.UTC(2026, 9, 24, 12));
  return { db, clock, e: new TaskEstimates({ db, clock }) };
}

test('nothing known: said, else the model, else 30', () => {
  const { e } = estimates();
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen' }), { minutes: 30, source: 'default' });
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen', modelMin: 25 }), { minutes: 25, source: 'model' });
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen', saidMin: 45, modelMin: 25 }), { minutes: 45, source: 'said' });
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'x', saidMin: 5000 }), { minutes: 1440, source: 'said' }, 'at most a day');
});

test('measured times count from two on (their mean); the person\'s correction wins over them and over the model, latest first', () => {
  const { clock, e } = estimates();
  e.learn('human', 'Küche aufräumen', 20, 'actual');
  assert.equal(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen' }).source, 'default', 'one measurement is no rule');
  e.learn('human', 'die Küche aufräumen', 31, 'actual');
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen', modelMin: 60 }), { minutes: 26, source: 'learned' }, 'the same key; the mean rounded');
  e.learn('human', 'Küche aufräumen', 45, 'person');
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen' }), { minutes: 45, source: 'person' });
  e.learn('human', 'Küche aufräumen', 90, 'actual');
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen' }), { minutes: 45, source: 'person' }, 'measured times do not move a correction');
  clock.advance(60_000);
  e.learn('human', 'Küche aufräumen', 40, 'person');
  assert.equal(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen' }).minutes, 40, 'the latest correction wins');
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Küche aufräumen', saidMin: 15 }), { minutes: 15, source: 'said' }, 'said wins over everything');
  assert.equal(e.estimateFor({ ownerId: 'per_anna0000001', title: 'Küche aufräumen' }).source, 'default', 'per member');
});

test('the split\'s key and the title both find a correction; the category is a weaker second key', () => {
  const { e } = estimates();
  e.learn('human', 'Steuererklärung', 120, 'person');
  assert.deepEqual(e.estimateFor({ ownerId: 'human', title: 'Die Steuern fürs Jahr machen', key: 'Steuererklärung' }), { minutes: 120, source: 'person' });
  const other = estimates().e;
  other.learn('human', 'Rechnung für Kunde A schreiben', 20, 'actual');
  other.learn('human', 'Rechnung für Kunde B schreiben', 40, 'actual');
  assert.deepEqual(other.estimateFor({ ownerId: 'human', title: 'Rechnung Kunde C' }), { minutes: 30, source: 'learned' }, 'the business bucket (two samples)');
  assert.deepEqual(other.estimateFor({ ownerId: 'human', title: 'Rechnung Kunde C', modelMin: 15 }), { minutes: 15, source: 'model' }, 'a model guess for the item beats the bucket');
});

test('counters only: no task text in the table; keys fold filler words; junk is ignored', () => {
  const { db, e } = estimates();
  e.learn('human', 'Meine geheime Rechnung an Anna', 25, 'person');
  e.learn('human', 'x', Number.NaN, 'actual');
  e.learn('human', 'x', 0, 'actual');
  const rows = db.all<Record<string, unknown>>('SELECT * FROM task_estimates');
  assert.equal(rows.length, 2, 'the key and its category bucket');
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(String(row.key_hash))));
  assert.ok(!/geheim|anna|rechnung/i.test(JSON.stringify(rows.map(({ category: _category, ...rest }) => rest))), 'only hashes and numbers (and the category name)');
  assert.equal(e.keyOf('Küche   aufräumen!'), 'kuche aufraumen');
  assert.equal(e.keyOf('Ich muss die Küche aufräumen'), 'kuche aufraumen');
  assert.equal(e.keyOf('am Buch arbeiten'), 'buch arbeiten');
  assert.equal(e.keyOf('die das'), 'die das', 'only filler: the words as they are');
});
