// B-048 E1: context ledger ids – m<seq> straight from the message, t/s/r/a/f from one counter per (agent, chat),
// never reused, stable for the same original; order is monotonic; items(since, kinds); the migration's schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../store/helpers.ts';
import { compactStamp, estimateTokens, kindOfId, ledgerTitle, normalizeItemId } from '../../../src/shared/model/context-ledger.ts';
import { ledgerSetup } from './ledger-fixture.ts';

test('ids: m<seq> from the message, one counter for t/s/r/a/f, monotonic order', () => {
  const t = ledgerSetup();
  try {
    const { ledger, tom, chat } = t;
    const a = ledger.record(tom.id, chat.id, { kind: 'tool', ref: 'item:ri_a', text: 'x'.repeat(40) });
    const b = ledger.record(tom.id, chat.id, { kind: 'reasoning', ref: 'item:ri_b', text: 'thinking' });
    const m = ledger.record(tom.id, chat.id, { kind: 'message', seq: 7, ref: 'msg:msg_7', text: 'hello' });
    const c = ledger.record(tom.id, chat.id, { kind: 'skill', ref: 'item:ri_c' });
    const d = ledger.record(tom.id, chat.id, { kind: 'assistant', ref: 'item:ri_d' });
    const e = ledger.record(tom.id, chat.id, { kind: 'file', ref: 'item:ri_e' });
    assert.deepEqual([a, b, m, c, d, e].map((item) => item.itemId), ['t1', 'r2', 'm7', 's3', 'a4', 'f5']);
    assert.deepEqual([a, b, m, c, d, e].map((item) => item.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(a.tokens, 10, 'about four characters per token');
    assert.equal(a.state, 'keep');
  } finally { t.cleanup(); }
});

test('ids are stable for the same original and never reused; each agent and chat counts on its own', () => {
  const t = ledgerSetup();
  try {
    const { ledger, tom, chat } = t;
    const first = ledger.record(tom.id, chat.id, { kind: 'tool', ref: 'item:ri_1', title: 'shell: npm test', tokens: 100 });
    const again = ledger.record(tom.id, chat.id, { kind: 'tool', ref: 'item:ri_1', title: 'shell: npm test', tokens: 250, bytes: 1000 });
    assert.equal(again.itemId, first.itemId, 'the same ref is the same item');
    assert.equal(again.order, first.order);
    assert.equal(again.tokens, 250, 'a capture seen again refreshes its estimate');
    const message = ledger.record(tom.id, chat.id, { kind: 'message', seq: 3, ref: 'msg:msg_3' });
    assert.equal(ledger.record(tom.id, chat.id, { kind: 'message', seq: 3 }).itemId, message.itemId);
    ledger.mark(tom.id, chat.id, [{ itemId: first.itemId, state: 'hidden', reason: 'old log', by: 'subconscious' }]);
    const next = ledger.record(tom.id, chat.id, { kind: 'tool', ref: 'item:ri_2' });
    assert.equal(next.itemId, 't2', 'the counter goes on');
    const other = ledger.record('ag_ava', chat.id, { kind: 'tool', ref: 'item:ri_9' });
    assert.equal(other.itemId, 't1', 'per (agent, chat)');
    assert.equal(other.order, 1);
    assert.throws(() => ledger.record(tom.id, chat.id, { kind: 'message' }), /seq/);
  } finally { t.cleanup(); }
});

test('items: in order, since is inclusive, kinds filter; titles are one capped line', () => {
  const t = ledgerSetup();
  try {
    const { ledger, tom, chat } = t;
    ledger.record(tom.id, chat.id, { kind: 'message', seq: 1, ref: 'msg:a', title: 'Alex: start' });
    ledger.record(tom.id, chat.id, { kind: 'tool', ref: 'item:x', title: `shell:\n${'long '.repeat(60)}` });
    ledger.record(tom.id, chat.id, { kind: 'assistant', ref: 'item:y', text: 'done' });
    assert.deepEqual(ledger.items(tom.id, chat.id, { since: 2 }).map((item) => item.itemId), ['t1', 'a2']);
    assert.deepEqual(ledger.items(tom.id, chat.id, { kinds: ['message', 'assistant'] }).map((item) => item.itemId), ['m1', 'a2']);
    const title = ledger.items(tom.id, chat.id, { kinds: ['tool'] })[0].title;
    assert.ok(title.length <= 120 && !title.includes('\n'), title);
  } finally { t.cleanup(); }
});

test('shared helpers: id shapes, stamp, estimate', () => {
  assert.equal(kindOfId('t17'), 'tool');
  assert.equal(kindOfId('m240'), 'message');
  assert.equal(kindOfId('x1'), undefined);
  assert.equal(kindOfId('t0'), undefined);
  assert.equal(normalizeItemId(' T17 '), 't17');
  assert.equal(normalizeItemId('#12'), 'm12');
  assert.equal(normalizeItemId('t-1'), undefined);
  assert.equal(compactStamp('t17', 1240), '{"compacted":"t17","was":"1240 tokens","restore":"context.restore"}');
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(ledgerTitle('  a\n b  '), 'a b');
});

test('migration 77: context_items with its unique id and order indexes', () => {
  const db = memoryDb();
  const indexes = db.all<{ name: string; unique: number }>(`SELECT name, "unique" FROM pragma_index_list('context_items')`);
  const unique = new Set(indexes.filter((index) => Number(index.unique) === 1).map((index) => index.name));
  assert.ok(unique.has('context_items_id') && unique.has('context_items_order'), JSON.stringify(indexes));
  const columns = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('context_items')`).map((column) => column.name);
  for (const name of ['agent_id', 'conversation_id', 'item_id', 'kind', 'run_id', 'order', 'created_at', 'tokens', 'title', 'state', 'condensed', 'pinned_until', 'origin_engine', 'origin_model', 'ref']) {
    assert.ok(columns.includes(name), name);
  }
  const insert = `INSERT INTO context_items (agent_id, conversation_id, item_id, kind, "order", created_at) VALUES ('a', 'c', 't1', 'tool', ?, 0)`;
  db.run(insert, [1]);
  assert.throws(() => db.run(insert, [2]), /UNIQUE/);
});
