// End-to-end (X03): an agent's mini-app to-do hands a recording back to its agent – the real
// headless runtime (built app/runtime-cli.mjs) with the deterministic fake engine over the real
// WebSocket RPC. A [[app:… todo=true …]] fence becomes a For-you to-do; a generated 0.2 s WAV is
// stored with files.uploadChunk (what the host does with the frame's wf.upload Blob) and
// registered for the block with blocks.file; blocks.answer {take:{fileId}} (the app's
// wf.complete) finishes it: done with the take as evidence, the person's line carries the WAV, the
// woken agent input (that line, B-076) names its path, and a later blocks.file for that block is refused.
// Run: npm run build && node --test test/e2e/runtime-app-files.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

/** A mono 16-bit 8 kHz WAV of `seconds` (RIFF header, so the store sniffs audio/wav). */
function wav(seconds = 0.2) {
  const samples = Math.round(seconds * 8000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write('WAVE', 8, 'ascii'); bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), 44 + i * 2);
  return bytes;
}

test('a mini-app to-do hands a WAV take back to its agent', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await client.call('chats.create', { title: 'Voice-over', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });

  // The fake engine turns [[app:…|…]] into an ```app fence (its HTML must not contain "]]").
  const html = '<button id="go">Hand back</button><script>go.onclick = () => wf.complete({ take: null });</script>';
  await client.call('messages.send', { conversationId: chat.id, body: `Record the intro [[app:title="Voice take" todo=true reason=physical permissions="microphone"|${html}]]` });
  const todo = await client.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'app', 90_000);
  const { messageId, index: blockIndex } = todo.widget;
  assert.ok((await client.call('todos.list')).some((item) => item.id === todo.id), 'the mini-app is on the For-you list');

  // What the host does with the frame's Blob: one final chunk, then the registration.
  const bytes = wav();
  const stored = await client.call('files.uploadChunk', { uploadId: 'up_e2eappfiles01', index: 0, dataBase64: bytes.toString('base64'), final: true, name: 'take.wav', mime: 'audio/wav' });
  assert.ok(stored.file, 'the upload finished');
  assert.equal(stored.file.mime, 'audio/wav');
  assert.equal(stored.file.size, bytes.length);
  const registered = await client.call('blocks.file', { messageId, blockIndex, fileId: stored.file.id });
  assert.deepEqual([registered.file.id, registered.count, registered.bytes], [stored.file.id, 1, bytes.length]);

  // The app's wf.complete({ take }) with what wf.upload resolved to.
  const take = { fileId: registered.file.id, name: registered.file.name, mime: registered.file.mime, size: registered.file.size };
  const answered = await client.call('blocks.answer', { messageId, blockIndex, answer: { take }, clientId: 'app:e2e-app-files' });
  assert.equal(answered.taskId, todo.id);
  const done = await client.waitFor('task.upserted', (item) => item.id === todo.id && item.status === 'done', 30_000);
  assert.equal(done.result?.summary, 'Done in mini-app · take: take.wav');
  assert.deepEqual(done.result?.evidence, [{ kind: 'file', label: 'take.wav', ref: stored.file.id }], 'the take is the evidence');
  assert.ok(!(await client.call('todos.list')).some((item) => item.id === todo.id), 'the to-do left the list');

  // B-076: the person's line ("Done in mini-app" + the app's data) is what wakes the agent – no [ui-answer] note.
  const woken = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /Done in mini-app\ntake: take\.wav/), 90_000);
  assert.match(woken.body, /\[Audio: take\.wav\] \([^\n]*stored at /, 'the woken input names the stored take with its path');
  assert.doesNotMatch(woken.body, /ui-answer/);
  const messages = await client.call('messages.list', { conversationId: chat.id, limit: 50 });
  const receipt = messages.find((message) => message.kind === 'answer' && message.taskId === todo.id);
  assert.deepEqual(receipt?.attachments.map((attachment) => [attachment.fileId, attachment.name, attachment.mime]), [[stored.file.id, 'take.wav', 'audio/wav']], 'the receipt carries the WAV');

  await assert.rejects(client.call('blocks.file', { messageId, blockIndex, fileId: stored.file.id }), (error) => error.code === 'conflict', 'a finished to-do takes no more files');
});
