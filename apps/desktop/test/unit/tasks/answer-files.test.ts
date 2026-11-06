// Answers carry files (F06): a recording or upload a to-do answer names by file id reaches the
// agent – attached to the person's answer line (so the chat shows it and the media library links it to
// the chat) and named "stored at <path>" in the agent's rendered context, where that line reads like one
// they wrote (B-076: no [ui-answer] tag, no wake note; the author is woken as for a typed line); the to-do
// keeps the file as evidence. Unknown ids are dropped without an error, form upload fields count, and the
// line names stored files by their names; a chat-free to-do's wake note gives "path: …" lines.
// Owns: these assertions only. Never: real engines, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMessages } from '../../../src/runtime/context/render.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import { answerFileIds, answerFiles, answerLines, fileNames } from '../../../src/runtime/tasks/answer-files.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { agent } from '../chat/harness.ts';
import { mediaSetup } from '../media/setup.ts';
import { TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const UNKNOWN = 'f'.repeat(64);

/** An agent message with one ask block that became a to-do. */
function askedBy(f: { chats: ReturnType<typeof rpcFixture>['chats']; tasks: ReturnType<typeof rpcFixture>['tasks'] }, chatId: string, agentId: string, block: string) {
  const body = `Please:\n\`\`\`ui\n${block}\n\`\`\``;
  const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chatId, agentId, `run_${Math.random().toString(36).slice(2)}`).id, { body, state: 'final' });
  const blocks = uiBlocksOf(body);
  const [todo] = f.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index));
  assert.ok(todo, 'the ask block is a to-do');
  return { message, todo };
}

test('a record answer: the person\'s line carries the recording, the context says "stored at", the author is woken once', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const { message, todo } = askedBy(f, chat.id, 'ag_ava', '{"type":"record","important":true,"mode":"audio","script":"Hi there"}');
  const file = await f.services.files.put(new TextEncoder().encode('fake audio take'), 'voice.webm', 'audio/webm');
  const where = f.services.files.path(file.id);
  f.db.run('DELETE FROM wakes');

  const phone = new TestClient(f.server, TODO_ONLY); // a To-do-only link answers like the PC
  await phone.call('tasks.complete', { id: todo.id, answer: { file: file.id, seconds: 3, mime: 'audio/webm' }, clientId: 'take-1' });

  const done = f.tasks.get(todo.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.result?.summary, 'Recorded 0:03', 'the summary text is unchanged');
  assert.deepEqual(done.result?.evidence, [{ kind: 'file', label: 'voice.webm', ref: file.id }]);
  const receipts = f.chats.messages(chat.id).filter((item) => item.kind === 'answer');
  assert.equal(receipts.length, 1);
  // The store guesses a general type from these bytes (text/plain); the recording's own audio type goes along.
  assert.deepEqual(receipts[0].attachments, [{ fileId: file.id, name: 'voice.webm', mime: 'audio/webm', size: file.size }]);
  assert.equal(receipts[0].replyTo, message.id);
  assert.equal(receipts[0].body, 'Recorded 0:03');

  const wakes = f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava');
  assert.deepEqual(wakes.map((wake) => [wake.reason, wake.conversation_id, wake.note]), [['message', chat.id, null]], 'woken as for a typed line, no note');

  const rendered = renderMessages({ services: f.services, agentId: 'ag_ava', humanName: 'CEO', zone: 'UTC', now: f.clock.now() }, receipts, { images: false });
  const text = rendered.lines.join('\n');
  assert.match(text, /^\[[^\]]+\] CEO: \(answer to my ask "[^"\n]+"\)\nRecorded 0:03\n/); // review fix: names the ask it answers
  assert.doesNotMatch(text, /ui-answer|\[task /);
  assert.ok(text.includes(`stored at ${where}`), text);
});

test('unknown file ids are dropped without an error; upload lists and form upload fields count', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const a = await f.services.files.put(new TextEncoder().encode('scan front'), 'front.pdf', 'application/pdf');
  const b = await f.services.files.put(new TextEncoder().encode('scan back'), 'back.png', 'image/png');

  const upload = askedBy(f, chat.id, 'ag_ava', '{"type":"upload","important":true,"label":"Your ID scans","multiple":true}');
  f.tasks.answer({ taskId: upload.todo.id, answer: { files: [a.id, UNKNOWN, 'not-an-id', a.id], names: ['front.pdf', 'x'] }, by: HUMAN_ID });
  const receipt = f.chats.messages(chat.id).find((item) => item.kind === 'answer' && item.taskId === upload.todo.id)!;
  assert.deepEqual(receipt.attachments.map((item) => item.fileId), [a.id], 'only the stored file, once');
  assert.equal(receipt.body, 'Uploaded front.pdf, not-an-id', 'the stored file by its name (a path by its last part), an unknown id not at all');
  assert.equal(f.tasks.get(upload.todo.id)?.result?.summary, 'Uploaded front.pdf, not-an-id');
  assert.deepEqual(f.tasks.get(upload.todo.id)?.result?.evidence, [{ kind: 'file', label: 'front.pdf', ref: a.id }]);

  const unknown = askedBy(f, chat.id, 'ag_ava', '{"type":"record","important":true,"mode":"video"}');
  f.tasks.answer({ taskId: unknown.todo.id, answer: { file: UNKNOWN, seconds: 5 }, by: HUMAN_ID });
  const plain = f.chats.messages(chat.id).find((item) => item.kind === 'answer' && item.taskId === unknown.todo.id)!;
  assert.deepEqual(plain.attachments, [], 'an unknown recording attaches nothing');
  assert.deepEqual(f.tasks.get(unknown.todo.id)?.result?.evidence, [{ kind: 'note', label: 'Recorded 0:05' }], 'no evidence of a file that is not stored');
  assert.ok(f.wakeRows().every((wake) => !wake.note), 'in a chat the line itself is the news: no wake note');

  const form = { type: 'form', fields: [{ name: 'photo', label: 'Photo', kind: 'file' }, { name: 'note', label: 'Note' }] };
  assert.deepEqual(answerFileIds({ values: { photo: [b.id, UNKNOWN], note: a.id } }, form), [b.id, UNKNOWN], 'upload fields only – not a text field that holds an id');
  const found = answerFiles(f.services, { values: { photo: [b.id, UNKNOWN] } }, form);
  assert.deepEqual(found.map((item) => item.attachment.fileId), [b.id]);
  assert.equal(found[0].path, f.services.files.path(b.id));
  assert.equal(fileNames(found)(b.id), 'back.png');
  assert.equal(fileNames(found)(UNKNOWN), undefined);
  assert.equal(answerLines('Photo: back.png', found), `Photo: back.png\npath: ${found[0].path} (back.png, ${b.mime})`);
  assert.deepEqual(answerFileIds('just text'), []);
  assert.deepEqual(answerFileIds({ file: 42, files: 'nope' }), []);
});

test('an answered recording joins the chat\'s media, so the agent finds it there', async (t) => {
  const m = mediaSetup();
  t.after(() => m.temp.cleanup());
  const { h, chat } = m;
  const asked: Message = h.chats.finishAgentMessage(h.chats.beginAgentMessage(chat.id, 'ag_ada', 'run_1').id, {
    body: 'Your take:\n```ui\n{"type":"record","important":true,"mode":"audio"}\n```', state: 'final',
  });
  const blocks = uiBlocksOf(asked.body);
  const [todo] = h.tasks.ingestBlocks(asked, blocks.map((item) => item.block), blocks.map((item) => item.index));
  // Stored without a chat (as an upload from the list is), so only the receipt links it.
  const file = await m.put(new TextEncoder().encode('voice take for the intro'), 'intro.webm', 'audio/webm');
  const repo = new MediaRepo(h.db);
  assert.equal(repo.list({}, { kind: 'agent', agentId: 'ag_ada' }, 50).some((item) => item.fileId === file.id), false, 'not visible before the answer');

  h.tasks.answer({ taskId: todo.id, answer: { file: file.id, seconds: 4 }, by: HUMAN_ID });
  const seen = repo.list({}, { kind: 'agent', agentId: 'ag_ada' }, 50).find((item) => item.fileId === file.id);
  assert.equal(seen?.conversationId, chat.id, 'linked to the chat of the to-do');
  assert.equal(repo.list({}, { kind: 'agent', agentId: 'ag_bo' }, 50).some((item) => item.fileId === file.id), false, 'not for agents of other chats');
  await m.media.idle();
});
