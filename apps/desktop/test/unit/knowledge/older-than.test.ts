// Settings › Knowledge "Older than" and the kind chips (B-044):
//  - `before` keeps only items saved before that time – in the paged list and in a keyword search;
//  - kinds() names the kinds current rows carry (expired versions left out);
//  - the knowledge.list RPC passes `before` and answers the stored kinds with its first page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const DAY = 86_400_000;

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const store = new KnowledgeStore({ db, clock });
  const old = store.save({ title: 'Old render preset', body: 'The video export used the H.264 preset.', kind: 'fact', scope: 'global', createdBy: 'human' });
  clock.advance(40 * DAY);
  const fresh = store.save({ title: 'New render preset', body: 'The video export uses the AV1 preset.', kind: 'procedure', scope: 'global', createdBy: 'human' });
  return { db, clock, store, old, fresh };
}

test('before: the list and a keyword search keep only what was saved earlier', async () => {
  const { clock, store, old, fresh } = setup();
  const cut = clock.now() - 30 * DAY;
  assert.deepEqual((await store.list({})).map((item) => item.id), [fresh.id, old.id]);
  assert.deepEqual((await store.list({ before: cut })).map((item) => item.id), [old.id]);
  assert.deepEqual((await store.search({ text: 'render preset' })).map((hit) => hit.item.id).sort(), [fresh.id, old.id].sort());
  assert.deepEqual((await store.search({ text: 'render preset', before: cut })).map((hit) => hit.item.id), [old.id]);
});

test('kinds(): the kinds of current rows only', async () => {
  const { store, old } = setup();
  assert.deepEqual((await store.kinds()), ['fact', 'procedure']);
  store.expire(old.id, 'human');
  assert.deepEqual((await store.kinds()), ['procedure'], 'an expired row names no kind');
});

test('knowledge.list RPC: before is passed on; the first page names the stored kinds', async () => {
  const { db, clock, store, old } = setup();
  const table = new HandlerTable();
  register(table);
  const ctx = { services: { db, knowledge: store, clock } as unknown as RuntimeServices, scope: 'owner', extras: {} } as unknown as HandlerContext;
  const call = (params: unknown) => table.get('knowledge.list')!.handler(params as never, ctx) as Promise<{ items: Array<{ id: string }>; kinds?: string[]; next?: string }>;
  const first = await call({ before: clock.now() - 30 * DAY });
  assert.deepEqual(first.items.map((item) => item.id), [old.id]);
  assert.deepEqual(first.kinds, ['fact', 'procedure'], 'the chips follow every stored kind, not the filter');
  const page = await call({ limit: 1 });
  assert.ok(page.next);
  assert.equal((await call({ limit: 1, cursor: page.next })).kinds, undefined, 'later pages leave the kinds out');
});
