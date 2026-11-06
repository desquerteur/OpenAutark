// B-059 #20: a COMMIT that fails (disk full, I/O error) must not break every later transaction – Db.tx rolls back
// best effort, throws the original error and leaves its depth at 0 (before: "no such savepoint", then `SAVEPOINT sp-1`).
// Owns: these assertions only. Never: a real full disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';

function withFailingCommit(rolledBack: boolean) {
  const db = new Db(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  const exec = db.raw.exec.bind(db.raw);
  let fail = true;
  db.raw.exec = (sql: string) => {
    if (fail && sql === 'COMMIT') {
      fail = false;
      if (rolledBack) exec('ROLLBACK'); // SQLITE_FULL: SQLite rolled the transaction back itself
      throw new Error('database or disk is full');
    }
    return exec(sql);
  };
  return db;
}

const rows = (db: Db) => db.all<{ x: number }>('SELECT x FROM t ORDER BY x').map((row) => row.x);

for (const rolledBack of [true, false]) {
  test(`a failed COMMIT throws its own error and the next transactions work (SQLite rolled back: ${rolledBack})`, () => {
    const db = withFailingCommit(rolledBack);
    assert.throws(() => db.tx(() => db.run('INSERT INTO t VALUES (1)')), /disk is full/);
    db.tx(() => db.run('INSERT INTO t VALUES (2)'));
    db.tx(() => { db.run('INSERT INTO t VALUES (3)'); db.tx(() => db.run('INSERT INTO t VALUES (4)')); });
    assert.deepEqual(rows(db), [2, 3, 4], 'the failed one is gone, later ones are kept');
    db.close();
  });
}

test('a throwing inner transaction rolls back only its savepoint; the outer one commits', () => {
  const db = new Db(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.tx(() => {
    db.run('INSERT INTO t VALUES (1)');
    assert.throws(() => db.tx(() => { db.run('INSERT INTO t VALUES (2)'); throw new Error('inner'); }), /inner/);
  });
  assert.deepEqual(rows(db), [1]);
  db.tx(() => db.run('INSERT INTO t VALUES (5)'));
  assert.deepEqual(rows(db), [1, 5]);
  db.close();
});
