// B-054 return path (src/runtime/tasks/human.ts answer, answer-receipt.ts, decline.ts): a to-do with no
// chat and no message is answered and declined like any other – the answer is stored on its row, no
// line is posted anywhere and the author agent is woken on its task with no chat (never a hidden
// one), the person's line in its note. A to-do typed into the list (addTodo) has no chat either. A to-do
// in a chat keeps the person's line there (B-076: and its author is woken as for a typed line).
// Owns: these assertions only. Never: real timers or model calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager', createdAt: 1 }));
  const messages = () => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n;
  return { ...h, messages };
}

const confirm = { type: 'confirm', instructions: 'Approve the newsletter text' } as const;

test('a chat-free to-do: the answer is stored on the row, no receipt, the author is woken on the task with no chat', () => {
  const h = setup();
  const parent = h.tasks.create({ title: 'Send the newsletter', assigneeId: 'ag_mara', createdBy: 'ag_mara' });
  const todo = h.tasks.create({ title: 'Approve the text', assigneeKind: 'human', humanReason: 'approval', widget: confirm, createdBy: 'ag_mara', parentId: parent.id });
  assert.equal(todo.conversationId, undefined);
  assert.equal(todo.messageId, undefined);
  const before = h.messages();
  const answered = h.tasks.answer({ taskId: todo.id, answer: { confirmed: true }, by: HUMAN_ID });
  assert.equal(answered?.status, 'done');
  assert.deepEqual(h.tasks.get(todo.id)?.result?.answer, { confirmed: true }, 'the answer stays on the to-do');
  assert.equal(h.messages(), before, 'no receipt posted anywhere');
  const wakes = h.wakeRows().filter((row) => row.reason === 'answer');
  assert.deepEqual(wakes.map((row) => [row.agent_id, row.conversation_id, row.task_id]), [['ag_mara', null, parent.id]], 'woken on the parent task, no chat');
  assert.equal(wakes[0].note, 'Reply to my to-do "Approve the text":\nDone', 'no chat line: the note carries the person\'s line');
  assert.equal(h.tasks.answer({ taskId: todo.id, answer: { confirmed: true }, by: HUMAN_ID })?.id, todo.id, 'a double answer is harmless');
});

test('declining a chat-free to-do cancels it and wakes its author without a chat or a receipt', () => {
  const h = setup();
  const todo = h.tasks.create({ title: 'Call the venue', assigneeKind: 'human', humanReason: 'physical', widget: confirm, createdBy: 'ag_mara' });
  const before = h.messages();
  const declined = h.tasks.answer({ taskId: todo.id, answer: { declined: true, reason: 'No time' }, by: HUMAN_ID, decline: true });
  assert.equal(declined?.status, 'cancelled');
  assert.equal(h.messages(), before);
  const wakes = h.wakeRows().filter((row) => row.reason === 'answer');
  assert.deepEqual(wakes.map((row) => [row.agent_id, row.conversation_id, row.task_id]), [['ag_mara', null, todo.id]]);
  assert.equal(wakes[0].note, 'Reply to my to-do "Call the venue":\nI can\'t do this: No time');
});

test('a typed to-do (addTodo) has no chat; a to-do in a chat still gets its receipt there', async () => {
  const h = setup();
  const typed = await h.tasks.addTodo('Call the dentist');
  assert.equal(typed.conversationId, undefined);
  assert.deepEqual(typed.origin, { source: 'todo-list', label: 'To-do area' });

  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_mara'], createdBy: HUMAN_ID });
  const todo = h.tasks.create({ conversationId: chat.id, title: 'Approve the post', assigneeKind: 'human', humanReason: 'approval', widget: confirm, createdBy: 'ag_mara' });
  h.tasks.answer({ taskId: todo.id, answer: { confirmed: true }, by: HUMAN_ID });
  assert.ok(h.chats.messages(chat.id, { limit: 20 }).some((message) => message.kind === 'answer' && message.taskId === todo.id && message.body === 'Done'), 'the person\'s line is in the chat');
  assert.deepEqual(h.wakeRows().filter((row) => row.agent_id === 'ag_mara' && (row.reason === 'answer' || row.reason === 'message')).map((row) => [row.reason, row.conversation_id, row.note]), [['message', chat.id, null]], 'woken as for a typed line');
});
