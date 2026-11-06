// Declining and removing to-dos (F06): todos.decline cancels the to-do with the result
// {summary 'Declined: …', answer {declined, reason}}, posts the person's line "I can't do this: <reason>" (B-076,
// no "Cancelled" line beside it) and wakes the author as for a typed line – once, also when sent twice. todos.remove deletes only to-dos the person
// added. A To-do-only phone may do both. Also: what counts as a decline answer.
// Owns: these assertions only. Never: real engines, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declineFrom, declineOf } from '../../../src/runtime/tasks/decline.ts';
import { appWidgetOf } from '../../../src/shared/blocks/app-todo.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { agent } from '../chat/harness.ts';
import { TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

function askFixture(t: { after: (fn: () => void) => void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const ask = (block: string) => {
    const body = `For you:\n\`\`\`ui\n${block}\n\`\`\``;
    const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', `run_${Math.random().toString(36).slice(2)}`).id, { body, state: 'final' });
    const blocks = uiBlocksOf(body);
    const [todo] = f.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index));
    return { message, todo };
  };
  const receipts = (taskId: string) => f.chats.messages(chat.id).filter((item) => item.kind === 'answer' && item.taskId === taskId);
  const answerWakes = () => f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava' && (wake.reason === 'message' || wake.reason === 'answer'));
  return { f, chat, ask, receipts, answerWakes, phone: new TestClient(f.server, TODO_ONLY) };
}

test('todos.decline: cancelled with the reason, the person\'s line "I can\'t do this: …", the author woken – once', async (t) => {
  const { f, chat, ask, receipts, answerWakes, phone } = askFixture(t);
  const { message, todo } = ask('{"important":true,"type":"record","mode":"audio","script":"Welcome to the course"}');
  f.db.run('DELETE FROM wakes');

  const view = await phone.call<TaskView>('todos.decline', { id: todo.id, reason: '  I prefer an AI voice  ', clientId: 'dec-1' });
  assert.equal(view.status, 'cancelled');
  assert.deepEqual(view.result, {
    summary: 'Declined: I prefer an AI voice', evidence: [{ kind: 'note', label: 'Declined: I prefer an AI voice' }],
    verification: 'reported_by_human', answer: { declined: true, reason: 'I prefer an AI voice' },
  });
  assert.ok(!f.tasks.todos().some((item) => item.id === todo.id), 'it left the For-you list');
  const [receipt] = receipts(todo.id);
  assert.equal(receipt.body, "I can't do this: I prefer an AI voice");
  assert.equal(receipt.replyTo, message.id);
  assert.equal(receipt.authorId, HUMAN_ID);
  assert.ok(!f.chats.messages(chat.id).some((item) => item.kind === 'status' && item.taskId === todo.id), 'no "Cancelled: …" line beside it');
  const wakes = answerWakes();
  assert.deepEqual(wakes.map((wake) => [wake.reason, wake.conversation_id, wake.task_id, wake.note]), [['message', chat.id, null, null]], 'as for a typed line');

  // Sent again (a retry, or another device): the same to-do, no second receipt or wake.
  const again = await phone.call<TaskView>('todos.decline', { id: todo.id, reason: 'Other words', clientId: 'dec-2' });
  assert.equal(again.result?.summary, 'Declined: I prefer an AI voice');
  assert.equal(receipts(todo.id).length, 1);
  assert.equal(answerWakes().length, 1);
});

test('a decline needs no reason; a finished or cancelled to-do cannot be declined', async (t) => {
  const { f, ask, receipts, answerWakes, phone } = askFixture(t);
  const { todo } = ask('{"important":true,"type":"confirm","instructions":"Plug in the camera"}');
  f.db.run('DELETE FROM wakes');
  const view = await phone.call<TaskView>('todos.decline', { id: todo.id });
  assert.equal(view.result?.summary, 'Declined');
  assert.deepEqual(view.result?.answer, { declined: true });
  assert.equal(receipts(todo.id)[0]?.body, "I can't do this.");
  assert.equal(answerWakes().length, 1);

  const done = ask('{"important":true,"type":"confirm","instructions":"Open the door"}').todo;
  f.tasks.answer({ taskId: done.id, answer: { done: true }, by: HUMAN_ID });
  const late = await phone.call<TaskView>('todos.decline', { id: done.id, reason: 'late' }); // like a second answer: unchanged
  assert.equal(late.status, 'done');
  assert.equal(f.tasks.get(done.id)?.result?.summary, 'Done');
  const dropped = ask('{"important":true,"type":"confirm","instructions":"Water the plants"}').todo;
  f.tasks.setStatus(dropped.id, 'cancelled', HUMAN_ID);
  await assert.rejects(phone.call('todos.decline', { id: dropped.id }), { code: 'conflict' });

  const open = ask('{"important":true,"type":"confirm","instructions":"Feed the cat"}').todo;
  await assert.rejects(phone.call('todos.decline', { id: open.id, reason: 'x'.repeat(501) }), { code: 'bad_request' });
});

test('todos.remove deletes a to-do the person added and refuses an agent\'s', async (t) => {
  const { f, ask, phone } = askFixture(t);
  const mine = await phone.call<TaskView>('todos.add', { text: 'Buy stamps' });
  assert.equal(mine.createdBy, HUMAN_ID);
  assert.deepEqual(await phone.call('todos.remove', { id: mine.id }), { ok: true });
  assert.equal(f.tasks.get(mine.id), undefined);
  assert.ok(f.of('task.removed').some((event) => (event as { id: string }).id === mine.id));

  const { todo } = ask('{"important":true,"type":"confirm","instructions":"Sign the form"}');
  await assert.rejects(phone.call('todos.remove', { id: todo.id }), { code: 'forbidden' });
  assert.equal(f.tasks.get(todo.id)?.status, 'open');
  await assert.rejects(phone.call('todos.remove', { id: 'task_missing' }), { code: 'not_found' });
});

test('a mini-app to-do whose app never reports back: "Mark done" finishes it, "Can\'t do this…" declines it', async (t) => {
  const { f, chat, phone, receipts, answerWakes } = askFixture(t);
  const appMessage = (title: string) => f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', `run_${title}`).id, {
    body: `\`\`\`app title="${title}" todo=true\n<p>broken</p>\n\`\`\``, state: 'final',
  });
  const [take] = f.tasks.ingestBlocks(appMessage('Voice take'), [], []);
  const [mixer] = f.tasks.ingestBlocks(appMessage('Mixer'), [], []);
  f.db.run('DELETE FROM wakes');
  const done = await phone.call<TaskView>('tasks.complete', { id: take.id, clientId: 'mark-done' }); // what "Mark done" sends
  assert.equal(done.status, 'done');
  assert.equal(done.result?.summary, 'Done in mini-app');
  const declined = await phone.call<TaskView>('todos.decline', { id: mixer.id, reason: 'It shows nothing' });
  assert.equal(declined.status, 'cancelled');
  assert.deepEqual([...receipts(take.id), ...receipts(mixer.id)].map((item) => item.body), ['Done in mini-app', "I can't do this: It shows nothing"]);
  assert.deepEqual(answerWakes().map((wake) => [wake.reason, wake.note]), [['message', null]], 'both lines of one chat: one wake, as two typed lines');
});

test('only {declined: true, reason?} is a decline; other answers stay answers', () => {
  assert.deepEqual(declineOf({ declined: true, reason: ' No time\n ' }), { declined: true, reason: 'No time' });
  assert.deepEqual(declineOf({ declined: true, reason: '' }), { declined: true });
  assert.deepEqual(declineOf({ declined: true }), { declined: true });
  assert.equal(declineOf({ declined: true, take: 1 }), undefined, 'a mini-app result with more keys is an answer');
  assert.equal(declineOf({ declined: 'yes' }), undefined);
  assert.equal(declineOf({ declined: true, reason: 5 }), undefined);
  assert.equal(declineOf({ approved: false }), undefined, "an approve block's No is its own answer");
  assert.equal(declineOf([true]), undefined);
  assert.equal(declineOf('declined'), undefined);
  assert.equal(declineOf({ declined: true, reason: 'x'.repeat(600) })?.reason?.length, 500);
});

