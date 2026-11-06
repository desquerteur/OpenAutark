// B-054 threads: a chat thread keeps its chat id (old sessions resume unchanged); a chat-free task and a chat-free,
// task-free source each get a thread of their own – planTurn computes it once, and the native session rows, the
// repair notes and the recap scope are keyed by it (no shared '' session for every chat-free run any more).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadKey } from '../../../src/shared/model/origin.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { recapScope } from '../../../src/runtime/context/recent-actions.ts';
import { setup } from './fixture.ts';

const MAIL = { source: 'app:box', label: 'New mail in me@example.test' };

test('threadKey: the chat wins, then the task, then the source', () => {
  assert.equal(threadKey({ conversationId: 'ch_1', taskId: 'tk_1', origin: MAIL }), 'ch_1');
  assert.equal(threadKey({ taskId: 'tk_1', origin: MAIL }), 'task:tk_1');
  assert.equal(threadKey({ origin: MAIL }), 'src:app:box');
  assert.equal(threadKey({}), '');
  assert.notEqual(threadKey({ taskId: 'tk_1' }), threadKey({ taskId: 'tk_2' }), 'two tasks, two threads');
  assert.notEqual(threadKey({ origin: MAIL }), threadKey({ origin: { source: 'news', label: 'Task news' } }), 'two sources, two threads');
});

test('planTurn: a chat keeps its id, a chat-free task and a source get their own thread and carry the origin', async () => {
  const h = setup();
  const chat = (await planTurn(h.services, h.request()))!;
  assert.equal(chat.thread, h.chat.id);
  assert.equal(chat.origin, undefined);

  const mail = (await planTurn(h.services, h.request({ conversationId: undefined, reason: 'event', origin: MAIL, notes: [{ text: 'New mail in me@example.test: 1 new message.', at: 1 }] })))!;
  assert.equal(mail.thread, 'src:app:box');
  assert.deepEqual(mail.origin, MAIL);
  assert.equal(mail.conversationId, undefined);

  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Summarise the items', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  const inChat = (await planTurn(h.services, h.request({ conversationId: undefined, taskId: task.id, reason: 'manual' })))!;
  assert.equal(inChat.thread, h.chat.id, "a task with a chat runs on the chat's thread, as before");
  h.db.run('UPDATE tasks SET conversation_id = NULL, message_id = NULL WHERE id = ?', [task.id]);
  const free = (await planTurn(h.services, h.request({ conversationId: undefined, taskId: task.id, reason: 'manual', origin: MAIL })))!;
  assert.equal(free.conversationId, undefined);
  assert.equal(free.thread, `task:${task.id}`, 'the task wins over the source');
  assert.deepEqual(recapScope(free), { agentId: h.tom.id, conversationId: undefined, taskId: task.id, source: 'app:box' });
});

test('sessions and repair notes of different threads stay apart', () => {
  const h = setup();
  const store = new SessionStore(h.db);
  const bind = (thread: string, ref: string) => store.save({ agentId: h.tom.id, conversationId: thread, engine: 'codex', ref, generation: 1, cursorSeq: 0, updatedAt: 1 });
  bind(h.chat.id, 'thr_chat');
  bind('task:tk_1', 'thr_task');
  bind('src:app:box', 'thr_mail');
  assert.equal(store.get(h.tom.id, h.chat.id, 'codex')?.ref, 'thr_chat');
  assert.equal(store.get(h.tom.id, 'task:tk_1', 'codex')?.ref, 'thr_task');
  assert.equal(store.get(h.tom.id, 'src:app:box', 'codex')?.ref, 'thr_mail');
  assert.equal(store.get(h.tom.id, undefined, 'codex'), undefined, "no shared '' session");
  store.remove(h.tom.id, 'src:app:box', 'codex');
  assert.equal(store.get(h.tom.id, 'task:tk_1', 'codex')?.ref, 'thr_task', 'removing one thread leaves the others');

  h.db.run("INSERT INTO kv (ns, key, value, updated_at) VALUES ('repair_notes', ?, ?, 1)", [`${h.tom.id}:task:tk_1`, JSON.stringify(['fix the block'])]);
  assert.deepEqual(takeRepairNotes(h.services, h.tom.id, 'src:app:box'), []);
  assert.deepEqual(takeRepairNotes(h.services, h.tom.id, 'task:tk_1'), ['fix the block']);
});
