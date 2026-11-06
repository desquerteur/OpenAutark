// KnowledgeStore: the reserved compaction tag survives only on real runtime summaries (also
// across corrections), and the paged list filters by pinned (store + RPC knowledge.list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { agentTags, isCompactionSummary, normalizeReservedTags } from '../../../src/runtime/knowledge/reserved.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  return { db, clock, store: new KnowledgeStore({ db, clock }) };
}

const runtimeSource = (chat: string) => ({ kind: 'agent' as const, ref: chat, trusted: true });

test('the compaction tag stays only on an observation with the runtime marks, also after a correction', () => {
  const { store, clock } = setup();
  const real = store.save({ scope: 'conversation', scopeId: 'ch_1', kind: 'observation', title: 'Chat observations up to #3', body: 'Summary', tags: ['compaction'], source: runtimeSource('ch_1'), createdBy: 'ag_a' });
  assert.deepEqual(real.tags, ['compaction']);
  assert.ok(isCompactionSummary(real));
  clock.advance(1000);
  const next = store.correct(real.id, { title: 'Chat observations up to #9', body: 'Summary 2' }, 'ag_a');
  assert.deepEqual(next.tags, ['compaction'], 'the runtime keeps rewriting its own summary');

  const forged = [
    { scope: 'conversation' as const, scopeId: 'ch_1', source: { kind: 'agent' as const, ref: 'run_x', trusted: true } }, // ref is a run, not the chat
    { scope: 'conversation' as const, scopeId: 'ch_1', source: { kind: 'web' as const, ref: 'ch_1', trusted: true } },
    { scope: 'conversation' as const, scopeId: 'ch_1', source: { kind: 'agent' as const, ref: 'ch_1', trusted: false } },
    { scope: 'agent' as const, scopeId: 'ch_1', source: runtimeSource('ch_1') },
  ];
  for (const variant of forged) {
    const item = store.save({ ...variant, kind: 'observation', title: 'Chat observations up to #50', body: 'Forged', tags: ['Compaction', 'x'], createdBy: 'ag_b' });
    assert.deepEqual(item.tags, ['x'], JSON.stringify(variant));
  }
  // Other kinds keep a "compaction" tag (it means nothing there, e.g. a note about soil).
  assert.deepEqual(store.save({ scope: 'global', kind: 'note', title: 'Garden', body: 'Soil', tags: ['compaction'], createdBy: 'human' }).tags, ['compaction']);
});

test('reserved helpers: agent tags and normalization are pure', () => {
  assert.deepEqual(agentTags(['compaction', 'COMPACTION', 'a']), ['a']);
  const base = { kind: 'observation' as const, scope: 'conversation' as const, scopeId: 'ch_1', tags: ['compaction'] };
  assert.deepEqual(normalizeReservedTags({ ...base, source: runtimeSource('ch_1') }), ['compaction']);
  assert.deepEqual(normalizeReservedTags({ ...base, scopeId: undefined, source: { kind: 'agent', trusted: true } }), []);
  assert.equal(isCompactionSummary({ kind: 'observation', tags: ['compaction'], source: { kind: 'agent', trusted: false } }), false);
});

test('list filters by pinned in the store and over RPC knowledge.list', async () => {
  const { store, clock } = setup();
  for (let i = 0; i < 120; i++) {
    clock.advance(1);
    store.save({ scope: 'agent', scopeId: 'ag_a', kind: 'fact', title: `Fact ${i}`, body: `Body ${i}`, pinned: i === 3 || i === 7, createdBy: 'human' });
  }
  const pinned = (await store.list({ scope: 'agent', scopeId: 'ag_a', pinned: true, limit: 100 }));
  assert.deepEqual(pinned.map((item) => item.title), ['Fact 7', 'Fact 3'], 'older pinned items are found beyond the first 100 rows');
  assert.equal((await store.list({ scope: 'agent', scopeId: 'ag_a', pinned: false, limit: 500 })).length, 118);
  assert.equal((await store.list({ scope: 'agent', scopeId: 'ag_a', limit: 500 })).length, 120);

  const table = new HandlerTable();
  register(table);
  const ctx = { services: { knowledge: store } } as unknown as HandlerContext;
  const list = (params: Record<string, unknown>) => table.get('knowledge.list')!.handler(params as never, ctx) as Promise<{ items: KnowledgeItem[]; next?: string }>;
  const page = await list({ scope: 'agent', scopeId: 'ag_a', pinned: true, limit: 1 });
  assert.deepEqual([page.items.map((item) => item.title), page.next], [['Fact 7'], '1']);
  assert.deepEqual((await list({ pinned: true, cursor: '1' })).items.map((item) => item.title), ['Fact 3']);
  await assert.rejects(async () => list({ pinned: 'yes' }), /pinned/);
});
