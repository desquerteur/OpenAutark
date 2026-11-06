// Migration 91 (runtime/db/migrations/091-messages-streaming.ts, B-075): a partial index holds the rows of runs at work
// by chat, so the chat summaries' live rows (chat/message-repo.ts liveRows) and the start-up reconcile read only those.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const plan = (db: Db, sql: string, params: unknown[] = []) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params as never[]).map((row) => row.detail).join(' | ');

test('migration 91 adds the streaming rows\' index; the live-row and reconcile reads use it', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 90 });
  const index = () => db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_streaming'");
  assert.equal(index(), undefined);
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 91);
  assert.match(index()!.sql, /ON messages\(conversation_id\) WHERE state = 'streaming'/);

  const live = plan(db, `SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND state = 'streaming' AND author_kind = 'agent' AND run_id IS NOT NULL ORDER BY seq`, ['["c1","c2"]']);
  assert.match(live, /messages_streaming/, live);
  const reconcile = plan(db, `SELECT * FROM messages WHERE state = 'streaming' AND (run_id IS NULL OR run_id IN (SELECT id FROM runs))`);
  assert.match(reconcile, /messages_streaming/, reconcile);
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'applied once');
});
