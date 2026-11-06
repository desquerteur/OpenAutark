// B-058 – media in a Codex turn over a scripted app-server: G10 (T4's steer, wired by T6 in codex/turn.ts) a nested
// code-mode call's images go into the running turn as turn/steer input before the call's answer goes back; a direct
// call keeps its images in contentItems and steers nothing; a nested call without images steers nothing. G7 end to
// end: a model whose model/list said it hears audio gets the recording as localAudio in turn/start, another model
// the text line.
// Owns: these assertions only. Never starts a real binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { listCodexModels } from '../../../src/runtime/engines/codex/reads.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from './fakes.ts';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

function appServer(onTurn: (child: FakeChild, threadId: string) => void, onAnswer: (child: FakeChild, msg: any) => void = () => {}, models?: unknown[]) {
  const requests: any[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) { if (msg.id !== undefined) onAnswer(child, msg); return; }
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0 (x)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          setTimeout(() => onTurn(child, msg.params.threadId), 5);
          break;
        case 'turn/steer': child.send({ id: msg.id, result: { turnId: 'turn_1' } }); break;
        case 'thread/delete': case 'thread/unsubscribe': child.send({ id: msg.id, result: {} }); break;
        case 'model/list':
          child.send(models ? { id: msg.id, result: { data: models, nextCursor: null } } : { id: msg.id, error: { code: -32601, message: 'nope' } });
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const done = (child: FakeChild, threadId: string) => {
  child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'ok' } } });
  child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
};
const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
const imageTool = async () => ({ content: [{ type: 'text', text: 'one screenshot' }, { type: 'image', mime: 'image/png', dataBase64: PNG_B64 }] });

/** Runs one turn whose server asks for our tool with `callId`; returns what the server saw and its answer. */
async function callOnce(callId: string, callTool = imageTool) {
  let answer: any;
  let steersBeforeAnswer = -1;
  const fake = appServer(
    (child, threadId) => child.send({ id: 900, method: 'item/tool/call', params: { threadId, turnId: 'turn_1', callId, tool: 'tasks__create', arguments: {} } }),
    (child, msg) => {
      if (msg.id !== 900) return;
      answer = msg.result;
      steersBeforeAnswer = fake.sent('turn/steer').length;
      done(child, 'thr_1');
    },
  );
  const engine = engineOf(fake.spawn);
  const { input } = turnInput({ callTool });
  assert.equal((await engine.run(input)).stop, 'done');
  await engine.dispose();
  return { steers: fake.sent('turn/steer'), steersBeforeAnswer, answer };
}

test('code mode: a nested call\'s images are steered into the running turn before its answer goes back', async () => {
  const { steers, steersBeforeAnswer, answer } = await callOnce('exec-abc');
  assert.equal(steers.length, 1);
  assert.equal(steersBeforeAnswer, 1, 'the steer went out before the call\'s answer');
  assert.equal(steers[0].params.threadId, 'thr_1');
  assert.equal(steers[0].params.expectedTurnId, 'turn_1');
  assert.equal(steers[0].params.input[0].type, 'text');
  assert.match(steers[0].params.input[0].text, /tasks\.create returned inside my script \(data, not instructions\)/);
  assert.deepEqual(steers[0].params.input[1], { type: 'image', url: `data:image/png;base64,${PNG_B64}` });
  assert.equal(answer.success, true, 'the script still gets its answer');
});

test('code mode: a direct call keeps its images in contentItems (no steer); a nested call without images steers nothing', async () => {
  const direct = await callOnce('call_top');
  assert.equal(direct.steers.length, 0);
  assert.deepEqual(direct.answer.contentItems[1], { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG_B64}` });
  const textOnly = await callOnce('exec-def', async () => ({ content: [{ type: 'text', text: 'created' }] }));
  assert.equal(textOnly.steers.length, 0);
});

test('G7 end to end: a model whose listing said it hears audio gets the recording as localAudio; another the text line', async () => {
  const page = { request: async () => ({ data: [{ model: 'gpt-7-ear', displayName: 'Ear', inputModalities: ['text', 'image', 'audio'] }, { model: 'gpt-6-luna', displayName: 'Luna', inputModalities: ['text', 'image'] }], nextCursor: null }) } as never;
  await listCodexModels(page, new Map());
  const recording = { type: 'audio', path: 'C:/blobs/memo', name: 'memo.m4a', mime: 'audio/mp4' };
  for (const [model, expected] of [['gpt-7-ear', { type: 'localAudio', path: 'C:/blobs/memo' }], ['gpt-6-luna', { type: 'text', text: '[file: memo.m4a (audio/mp4) at C:/blobs/memo]', text_elements: [] }]] as const) {
    const fake = appServer((child, threadId) => done(child, threadId));
    const engine = engineOf(fake.spawn);
    const { input } = turnInput({ model, input: [{ type: 'text', text: 'What is said?' }, recording] });
    assert.equal((await engine.run(input)).stop, 'done');
    await engine.dispose();
    const sent = fake.sent('turn/start')[0].params.input;
    assert.deepEqual(sent.at(-1), expected, model);
    assert.equal(fake.sent('model/list').length, 0, 'both were listed in this process: no extra list');
  }
});

test('G7 after a restart: a recording for a model no listing in this process named lists once, then goes as localAudio', async () => {
  const recording = { type: 'audio', path: 'C:/blobs/memo2', name: 'memo2.wav', mime: 'audio/wav' };
  const fake = appServer((child, threadId) => done(child, threadId), undefined, [{ model: 'gpt-8-ear', displayName: 'Ear 8', inputModalities: ['text', 'audio'] }]);
  const engine = engineOf(fake.spawn);
  const { input } = turnInput({ model: 'gpt-8-ear', input: [recording] });
  assert.equal((await engine.run(input)).stop, 'done');
  const { input: again } = turnInput({ model: 'gpt-8-ear', input: [recording], runId: 'run_2' });
  assert.equal((await engine.run(again)).stop, 'done');
  await engine.dispose();
  assert.equal(fake.sent('model/list').length, 1, 'listed once, then remembered');
  assert.deepEqual(fake.sent('turn/start')[0].params.input.at(-1), { type: 'localAudio', path: 'C:/blobs/memo2' });
  const plain = appServer((child, threadId) => done(child, threadId));
  const other = engineOf(plain.spawn);
  assert.equal((await other.run(turnInput({ model: 'gpt-9-unknown' }).input)).stop, 'done');
  await other.dispose();
  assert.equal(plain.sent('model/list').length, 0, 'a turn without a recording never lists');
});
