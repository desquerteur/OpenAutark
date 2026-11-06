// B-054 TaskRepo: a chat-free task round-trips with NULL chat (never the string "null"), its own space and origin;
// a task with a chat stores no space of its own; the space filter reads the chat's space, else the task's.
// Owns: these row-mapping checks only. Never: create/lifecycle behaviour (tasks/create.ts, track B).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { TaskRepo } from '../../../src/runtime/tasks/repo.ts';
import type { Task } from '../../../src/shared/model/tasks.ts';

const T = 1_700_000_000_000;

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  db.run(`INSERT INTO conversations (id, title, space_id, created_by, created_at, updated_at) VALUES ('cv_work', 'Work', 'sp_chat', 'human', ?, ?)`, [T, T]);
  return { db, repo: new TaskRepo(db) };
}

const base = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, notes: '', status: 'open', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'ag_ava', priority: 0,
  ledger: {}, attempts: 0, sort: 0, rev: 0, createdAt: T, updatedAt: T, ...extra,
});

test('a chat-free task round-trips: NULL chat and message, its own space and origin', () => {
  const { db, repo } = setup();
  repo.insert(base('tk_free', { spaceId: 'sp_own', origin: { source: 'app:ap_mail', label: 'New mail in office@example.com' } }));
  const row = db.get<{ c: string | null; m: string | null; s: string | null }>(`SELECT conversation_id AS c, message_id AS m, space_id AS s FROM tasks WHERE id = 'tk_free'`);
  assert.deepEqual({ ...row }, { c: null, m: null, s: 'sp_own' });
  const read = repo.get('tk_free')!;
  assert.equal('conversationId' in read, false, 'no chat = no key (never "null")');
  assert.equal(read.spaceId, 'sp_own');
  assert.deepEqual(read.origin, { source: 'app:ap_mail', label: 'New mail in office@example.com' });
  // save keeps chat (none), space and origin; an absent space or origin keeps the stored one.
  const { spaceId: _s, origin: _o, ...bare } = read;
  assert.equal(repo.save({ ...bare, title: 'Answer Maria', rev: 1 }, 0), true);
  const saved = repo.get('tk_free')!;
  assert.deepEqual([saved.title, saved.conversationId, saved.spaceId, saved.origin?.source], ['Answer Maria', undefined, 'sp_own', 'app:ap_mail']);
});

test('a task with a chat stores no space of its own; save never re-points its chat', () => {
  const { db, repo } = setup();
  repo.insert(base('tk_chat', { conversationId: 'cv_work', messageId: 'ms_1', spaceId: 'sp_ignored' }));
  const read = repo.get('tk_chat')!;
  assert.deepEqual([read.conversationId, read.messageId, read.spaceId, read.origin], ['cv_work', 'ms_1', undefined, undefined]);
  // The chat is deleted: the FK detaches the row; a stale copy saved afterwards does not bring the chat back.
  db.run(`DELETE FROM conversations WHERE id = 'cv_work'`);
  assert.equal(repo.save({ ...read, title: 'Stale', rev: 1 }, 0), true);
  assert.equal(repo.get('tk_chat')!.conversationId, undefined);
});

test('the space filter reads the chat space, else the chat-free task space', () => {
  const { repo } = setup();
  repo.insert(base('tk_chat', { conversationId: 'cv_work' }));
  repo.insert(base('tk_free', { spaceId: 'sp_chat' }));
  repo.insert(base('tk_other', { spaceId: 'sp_other' }));
  repo.insert(base('tk_none'));
  assert.deepEqual(repo.list({ spaceId: 'sp_chat' }).map((t) => t.id).sort(), ['tk_chat', 'tk_free']);
  assert.deepEqual(repo.list({ spaceId: 'sp_other' }).map((t) => t.id), ['tk_other']);
  assert.equal(repo.list().length, 4);
});
