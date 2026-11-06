// Codex image generation reaches the chat (MM2): a scripted app-server emits imageGeneration
// items; the turn result carries them as EngineTurnResult.files (base64 or data: URL, failed
// items dropped), and ChatServiceImpl.finishAgentMessage stores the files and attaches them
// before the message is announced, linked in the media library. B-044: such an attachment of a run with
// image_generation is the agent's own portrait source (tools/builtin/agent-avatar.ts madeByRun).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Paths } from '../../../src/runtime/contracts.ts';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { generatedImage } from '../../../src/runtime/engines/codex/turn.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { madeByRun } from '../../../src/runtime/tools/builtin/agent-avatar.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { png } from '../media/fixtures.ts';
import { mediaSetup } from '../media/setup.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from './fakes.ts';

/** A minimal app-server: one thread, and `onTurn` scripts what follows turn/start. */
function appServer(onTurn: (child: FakeChild, threadId: string) => void) {
  return fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) return;
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        onTurn(child, msg.params.threadId);
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
}

const item = (threadId: string, method: 'item/started' | 'item/completed', body: Record<string, unknown>) =>
  ({ method, params: { threadId, turnId: 'turn_1', item: { type: 'imageGeneration', ...body } } });

test('codex: completed imageGeneration items become EngineTurnResult.files; failed ones are dropped', async () => {
  const image = png(64, 48);
  const base64 = Buffer.from(image).toString('base64');
  const fake = appServer((child, threadId) => {
    child.send(item(threadId, 'item/started', { id: 'ig_1', status: 'inProgress', result: '' }));
    child.send(item(threadId, 'item/completed', { id: 'ig_1', status: 'completed', result: base64, revisedPrompt: 'a chart' }));
    child.send(item(threadId, 'item/completed', { id: 'ig_2', status: 'completed', result: `data:image/webp;base64,${base64}` }));
    child.send(item(threadId, 'item/completed', { id: 'ig_3', status: 'failed', result: '', failure: { message: 'refused' } }));
    child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'Here you go' } } });
    child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
  });
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });
  const { input, events } = turnInput();
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Here you go');
  assert.deepEqual(result.files, [
    { name: 'generated-image-1.png', mime: 'image/png', dataBase64: base64 },
    { name: 'generated-image-2.png', mime: 'image/webp', dataBase64: `data:image/webp;base64,${base64}` },
  ]);
  assert.ok(events.some((event: any) => event.type === 'tool_start' && event.name === 'image_generation' && event.own));
  await engine.dispose();
});

test('generatedImage: bytes win, a saved path is the fallback, failures give nothing', () => {
  assert.deepEqual(generatedImage({ id: 'a', status: 'completed', result: '', savedPath: '/ws/out/img.png' }, 3), { name: 'generated-image-3.png', path: '/ws/out/img.png' });
  assert.equal(generatedImage({ id: 'b', status: 'completed', result: '' }, 1), undefined);
  assert.equal(generatedImage({ id: 'c', status: 'failed', result: 'AAAA' }, 1), undefined);
});

test('finishAgentMessage stores engine files and attaches them before announcing the message', async () => {
  const s = mediaSetup();
  try {
    const workspace = path.join(s.temp.dir, 'workspace');
    s.h.services.paths = { workspace, accounts: path.join(s.temp.dir, 'accounts') } as Paths;
    const image = png(64, 48);
    const started = s.h.chats.beginAgentMessage(s.chat.id, 'ag_ada', 'run_1');
    const announced = new Promise<Message>((resolve) => { const off = s.h.bus.on('message.updated', (message) => { if (message.id === started.id) { off(); resolve(message); } }); });
    s.h.chats.finishAgentMessage(started.id, {
      body: 'Here you go', state: 'final',
      files: [
        { name: 'generated-image-1.png', mime: 'image/png', dataBase64: Buffer.from(image).toString('base64') },
        { name: 'elsewhere.png', path: path.join(s.temp.dir, 'elsewhere.png') }, // outside the workspace: not stored
      ],
    });
    const message = await announced;
    const id = createHash('sha256').update(image).digest('hex');
    assert.deepEqual(message.attachments.map((file) => [file.fileId, file.name, file.mime, file.width, file.height]), [[id, 'generated-image-1.png', 'image/png', 64, 48]]);
    assert.deepEqual(s.h.chats.message(started.id)!.attachments.map((file) => file.fileId), [id], 'persisted');
    assert.equal(s.media.get(id)!.conversationId, s.chat.id, 'shown under the chat in the media library');
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('B-044: a generated image attached to the answer of a run with image_generation counts as that agent\'s own portrait source', async () => {
  const s = mediaSetup();
  try {
    s.h.services.paths = { workspace: path.join(s.temp.dir, 'workspace'), accounts: path.join(s.temp.dir, 'accounts') } as Paths;
    const journal = new Journal({ db: s.h.db, bus: s.h.bus, clock: s.h.clock });
    journal.start({ id: 'run_img', agentId: 'ag_ada', conversationId: s.chat.id, trigger: 'message' });
    journal.item('run_img', { kind: 'tool_call', name: 'image_generation', data: { callId: 'ig_1', own: true }, effectStatus: 'none' });
    const image = png(512, 512);
    const started = s.h.chats.beginAgentMessage(s.chat.id, 'ag_ada', 'run_img');
    const announced = new Promise<void>((resolve) => { const off = s.h.bus.on('message.updated', (message) => { if (message.id === started.id) { off(); resolve(); } }); });
    s.h.chats.finishAgentMessage(started.id, { body: 'My portrait', state: 'final', files: [{ name: 'generated-image-1.png', mime: 'image/png', dataBase64: Buffer.from(image).toString('base64') }] });
    await announced; // the files are stored and attached first
    const id = createHash('sha256').update(image).digest('hex');
    assert.equal(madeByRun(s.h.db, 'ag_ada', id), true);
    assert.equal(madeByRun(s.h.db, 'ag_bo', id), false, 'another agent\'s run did not make it');
    const upload = await s.put(png(32, 32), 'photo.png', 'image/png');
    s.attach(s.chat.id, upload);
    assert.equal(madeByRun(s.h.db, 'ag_ada', upload.id), false, 'the person\'s upload is no portrait source');
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});
