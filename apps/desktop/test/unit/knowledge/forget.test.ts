// "Forget permanently" and the knowledge browser's runtime side:
//  - KnowledgeStore.forget deletes the memory file with every old version (any version's id names it), emits
//    knowledge.removed {ids} and logs ids and count only;
//  - save with the id of a forgotten item is refused (not_found) – an edit of a stale row never
//    writes the forgotten text back (service and RPC);
//  - pin() moves a file into its pinned/ subfolder (no new version; the id follows the path);
//  - list() narrows to several kinds (the browser hides observations);
//  - RPC knowledge.forget is owner-only and refused without confirm: true; knowledge.pin has
//    the 'chat' tier like knowledge.save; knowledge.list takes `kinds`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { HandlerTable, allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const bus = new Bus();
  const logs: Array<{ message: string; data?: unknown }> = [];
  const log = {
    debug: () => undefined, warn: () => undefined, error: () => undefined,
    info: (message: string, data?: unknown) => { logs.push({ message, data }); },
  };
  const store = new KnowledgeStore({ db, clock, bus, log: log as never });
  const removed: string[][] = [];
  bus.on('knowledge.removed', ({ ids }) => removed.push(ids));
  return { db, clock, bus, store, logs, removed };
}

const count = (db: Db, sql: string, params: string[]) => db.get<{ n: number }>(sql, params)!.n;
const marks = (ids: string[]) => ids.map(() => '?').join(', ');

test('forget deletes the file and every old version, by the id of any version; the event names them', async () => {
  const { db, clock, store, logs, removed } = setup();
  const first = store.save({ title: 'Brand color', body: 'Our brand color is teal (private detail: quokkablue).', scope: 'global', kind: 'fact', createdBy: 'human' });
  clock.advance(60_000);
  const second = store.correct(first.id, { body: 'Our brand color is petrol (private detail).' }, 'human');
  clock.advance(60_000);
  const third = store.correct(second.id, { body: 'Our brand color is navy (private detail).' }, 'ag_a');
  const other = store.save({ title: 'Brand voice', body: 'Friendly, short sentences.', scope: 'global', kind: 'preference', createdBy: 'human' });
  assert.equal(second.id, first.id, 'a file keeps its id');
  assert.equal(third.id, first.id);
  const history = store.history(first.id);
  assert.equal(history.length, 3);
  const oldest = history[0];
  assert.equal(oldest.body, 'Our brand color is teal (private detail: quokkablue).');
  assert.ok(oldest.expiredAt);

  const result = store.forget(oldest.id, 'human');
  const ids = history.map((item) => item.id);
  assert.deepEqual(new Set(result.ids), new Set(ids));
  for (const id of ids) {
    assert.deepEqual(store.history(id), [], `history(${id}) is empty`);
    assert.equal(store.get(id), undefined);
  }
  assert.equal(count(db, `SELECT count(*) AS n FROM knowledge WHERE id IN (${marks(ids)})`, ids), 0, 'rows are gone');
  assert.deepEqual((await store.search({ text: 'brand color teal petrol navy private' })).map((hit) => hit.item.id), [other.id], 'search finds only the other item');
  assert.equal(store.get(other.id)?.title, 'Brand voice', 'unrelated items stay');
  assert.equal(removed.length, 1);
  assert.deepEqual(new Set(removed[0]), new Set(ids));

  // The audit line names ids and the count, never the content.
  const entry = logs.find((line) => line.message === 'knowledge forgotten');
  assert.ok(entry);
  assert.deepEqual((entry.data as { count: number }).count, 3);
  assert.doesNotMatch(JSON.stringify(logs), /teal|petrol|navy|private detail|Brand color/);

  assert.throws(() => store.forget(first.id, 'human'), /not found/);
});

test('an observation row keeps its chain: forget(middle version) deletes every version', () => {
  const { clock, store, removed } = setup();
  const first = store.save({ title: 'Chat observations up to #1', body: 'one', scope: 'conversation', scopeId: 'ch_1', kind: 'observation', createdBy: 'ag_a' });
  clock.advance(1000);
  const second = store.correct(first.id, { body: 'two' }, 'ag_a');
  clock.advance(1000);
  const third = store.correct(second.id, { body: 'three' }, 'ag_a');
  assert.deepEqual(new Set(store.forget(second.id, 'human').ids), new Set([first.id, second.id, third.id]));
  assert.equal(store.get(third.id), undefined);
  assert.equal(removed.length, 1);
});

test('pin moves the file into its pinned folder – no new version – and back', () => {
  const { clock, store, bus } = setup();
  const upserts: KnowledgeItem[] = [];
  bus.on('knowledge.upserted', (item) => upserts.push(item));
  const item = store.save({ title: 'Tone', body: 'Short answers.', scope: 'global', kind: 'preference', createdBy: 'human' });
  upserts.length = 0;
  const pinned = store.pin(item.id, true, 'human');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.id, 'company:pinned:tone.md');
  assert.equal(store.get(pinned.id)?.pinned, true);
  assert.equal(store.get(item.id), undefined, 'the file moved');
  assert.deepEqual(store.history(pinned.id).map((entry) => entry.id), [pinned.id], 'pinning adds no version');
  assert.deepEqual(upserts.map((entry) => [entry.id, entry.pinned]), [[pinned.id, true]]);
  store.pin(pinned.id, true, 'human');
  assert.equal(upserts.length, 1, 'an unchanged pin emits nothing');
  clock.advance(1000);
  const next = store.correct(pinned.id, { body: 'Very short answers.' }, 'human');
  assert.equal(next.pinned, true, 'a correction keeps the pin');
  const unpinned = store.pin(pinned.id, false, 'human');
  assert.equal(unpinned.id, item.id);
  assert.equal(store.history(unpinned.id).length, 2, 'the old version follows the file');
  assert.throws(() => store.pin('kn_missing', true, 'human'), /not found/);
});

test('list narrows to several kinds (observations hidden in the browser)', async () => {
  const { clock, store } = setup();
  for (const kind of ['fact', 'plan', 'observation', 'note'] as const) {
    clock.advance(1);
    store.save({ title: `A ${kind}`, body: 'Body', scope: 'conversation', scopeId: 'ch_1', kind, createdBy: 'human' });
  }
  assert.deepEqual((await store.list({ kinds: ['fact', 'plan', 'note'] })).map((item) => item.kind), ['note', 'plan', 'fact']);
  assert.deepEqual((await store.list({ scope: 'conversation', kinds: ['observation'] })).map((item) => item.kind), ['observation']);
  assert.equal((await store.list({})).length, 4);
});

test('RPC: forget is owner-only and needs confirm: true; pin has the chat tier; list takes kinds', async () => {
  const { store, removed } = setup();
  const table = new HandlerTable();
  register(table);
  const ctx = { services: { knowledge: store } } as unknown as HandlerContext;
  const call = (method: string, params: Record<string, unknown>) => Promise.resolve().then(() => table.get(method)!.handler(params as never, ctx));
  const device = (capabilities: DeviceCapability[]): ClientScope => ({ kind: 'device', deviceId: 'dv_phone', capabilities, secure: true });

  const forgetRule = table.get('knowledge.forget')!.scope;
  assert.equal(allowedScope(forgetRule, { kind: 'owner' }), true);
  assert.equal(allowedScope(forgetRule, device(['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'])), false, 'no device token may forget');
  assert.equal(allowedScope(table.get('knowledge.pin')!.scope, device(['todo', 'chat'])), true);
  assert.equal(allowedScope(table.get('knowledge.pin')!.scope, device(['todo'])), false);

  const item = store.save({ title: 'Secret plan', body: 'Launch on Friday.', scope: 'global', kind: 'plan', createdBy: 'human' });
  await assert.rejects(call('knowledge.forget', { id: item.id }), /confirm/);
  await assert.rejects(call('knowledge.forget', { id: item.id, confirm: 'yes' }), /confirm/);
  await assert.rejects(call('knowledge.forget', { id: item.id, confirm: true, extra: 1 }), /extra/);
  assert.ok(store.get(item.id), 'nothing was deleted by refused calls');
  assert.deepEqual(removed, []);

  const pinned = await call('knowledge.pin', { id: item.id, pinned: true }) as KnowledgeItem;
  assert.equal(pinned.pinned, true);
  await assert.rejects(call('knowledge.pin', { id: pinned.id }), /pinned/);
  store.save({ title: 'A note', body: 'Body', scope: 'global', kind: 'note', createdBy: 'human' });
  const page = await call('knowledge.list', { kinds: ['plan'] }) as { items: KnowledgeItem[] };
  assert.deepEqual(page.items.map((entry) => entry.id), [pinned.id]);
  await assert.rejects(call('knowledge.list', { kinds: ['secret'] }), /kinds/);

  assert.deepEqual(await call('knowledge.forget', { id: pinned.id, confirm: true }), { ok: true, ids: [pinned.id] });
  await assert.rejects(call('knowledge.history', { id: pinned.id }), /not found/i);
  await assert.rejects(call('knowledge.forget', { id: pinned.id, confirm: true }), /not found/i);
});

test('saving with the id of a forgotten item is refused and writes nothing back (service and RPC)', async () => {
  const { bus, store } = setup();
  const table = new HandlerTable();
  register(table);
  const ctx = { services: { knowledge: store } } as unknown as HandlerContext;
  const upserts: KnowledgeItem[] = [];
  bus.on('knowledge.upserted', (entry) => upserts.push(entry));
  const item = store.save({ title: 'Home address', body: 'Example Street 1, 2nd floor', scope: 'global', kind: 'fact', createdBy: 'human' });
  store.forget(item.id, 'human');
  upserts.length = 0;
  // What a stale row's Edit sends (MemoryRow): the old id, scope and kind, the pre-filled text.
  const edit = { id: item.id, scope: 'global' as const, kind: 'fact' as const, title: item.title, body: 'Example Street 1, 2nd floor' };
  await assert.rejects(Promise.resolve().then(() => table.get('knowledge.save')!.handler(edit as never, ctx)),
    (error: unknown) => (error as { code?: string }).code === 'not_found' && /forgotten or no longer exists/.test(String((error as Error).message)));
  assert.throws(() => store.save({ ...edit, createdBy: 'ag_a' }), /forgotten or no longer exists/);
  assert.equal(store.get(item.id), undefined, 'the forgotten item stays gone');
  assert.deepEqual(store.history(item.id), []);
  assert.equal((await store.list({})).length, 0);
  assert.deepEqual(upserts, [], 'nothing was announced');
  // Without an id a save still creates a new item.
  assert.notEqual(store.save({ title: 'Office', body: 'Second floor.', scope: 'global', createdBy: 'human' }).id, item.id);
});
