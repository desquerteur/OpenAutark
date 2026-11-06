// A chat's shared notes (runtime/notes/store.ts, rpc/handlers/notes.ts): one text per chat, last write wins, every
// write bumps the version and sends notes.updated; append adds at the end; notes.get / notes.meta / notes.save for
// the owner (an unknown chat is not found, `baseVersion` is accepted and not needed); the prompt's chat line reads
// only the version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { appendNotes, getNotes, notesMeta, notesVersion, saveNotes } from '../../../src/runtime/notes/store.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/notes.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

function world() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const bus = new Bus();
  const now = clock.now();
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('ch_1', 'One', 'human', ?, ?)`, [now, now]);
  const chats = { get: (id: string) => (id === 'ch_1' ? { id } : undefined) };
  const updates: unknown[] = [];
  bus.on('notes.updated', (event) => updates.push(event));
  const services = { db, clock, bus, chats } as unknown as RuntimeServices;
  return { db, clock, bus, services, updates };
}

test('save and append: last write wins, the version counts the writes, every write is announced', () => {
  const w = world();
  assert.deepEqual(getNotes(w.services, 'ch_1'), { conversationId: 'ch_1', text: '', version: 0 });
  assert.equal(notesVersion(w.db, 'ch_1'), 0);
  saveNotes(w.services, 'ch_1', '## Todo\n\nBook the venue', 'human');
  w.clock.advance(1000);
  const appended = appendNotes(w.services, 'ch_1', 'Order the food', 'ag_a');
  assert.equal(appended.text, '## Todo\n\nBook the venue\n\nOrder the food\n');
  assert.equal(appended.version, 2);
  assert.equal(appended.updatedBy, 'ag_a');
  assert.deepEqual(notesMeta(w.services, 'ch_1'), { conversationId: 'ch_1', version: 2, updatedAt: appended.updatedAt, updatedBy: 'ag_a', size: appended.text.length });
  assert.equal(saveNotes(w.services, 'ch_1', 'Fresh', 'human').version, 3);
  assert.equal(getNotes(w.services, 'ch_1').text, 'Fresh');
  assert.deepEqual(w.updates.map((event) => (event as { version: number }).version), [1, 2, 3]);
});

test('notes.get / meta / save for the owner; an unknown chat is not found; baseVersion is accepted', async () => {
  const w = world();
  const table = new HandlerTable();
  register(table);
  const ctx = { services: w.services, scope: { kind: 'owner' }, extras: {} } as unknown as HandlerContext;
  const call = async (method: string, params: unknown) => table.get(method)!.handler(params as never, ctx);
  const saved = await call('notes.save', { conversationId: 'ch_1', text: 'Plan', baseVersion: 0 }) as { version: number; updatedBy: string };
  assert.deepEqual([saved.version, saved.updatedBy], [1, 'human']);
  assert.equal((await call('notes.save', { conversationId: 'ch_1', text: 'Plan B', baseVersion: 0 }) as { version: number }).version, 2, 'an older base version still saves');
  assert.equal((await call('notes.get', { conversationId: 'ch_1' }) as { text: string }).text, 'Plan B');
  assert.equal((await call('notes.meta', { conversationId: 'ch_1' }) as { size: number }).size, 6);
  await assert.rejects(call('notes.get', { conversationId: 'ch_none' }), /not found/i);
});
