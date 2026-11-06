// Files a mini-app to-do hands back (X03, runtime/tasks/app-files.ts and blocks.file): a stored
// take is registered only for an agent's open ```app todo=true block, idempotently and within the
// block's limits; every refused file stored in the last two minutes goes to the blob clean-up (a
// file already queued keeps its due time; an older file is never queued), and one the block refuses
// for its type or size counts against the block's bytes (the refusal names the totals). The to-do's
// answer attaches only registered files – the ones its data names
// (nested too), or all when it names none – to the person's line (B-076: the take by its name, its stored
// path in the agent's context; no wake note), keeps them as evidence and releases the registry; a decline
// releases it too. Device scopes: 'todo'.
// Owns: these assertions only. Never: real engines, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECLAIM_NS } from '../../../src/runtime/files/references.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { APP_FILES_NS, APP_FILE_FRESH_MS, appAnswerFileIds, appFileIds, registerAppFile, releaseAppFiles } from '../../../src/runtime/tasks/app-files.ts';
import { APP_TYPE_REFUSAL } from '../../../src/shared/blocks/app-files.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { agent } from '../chat/harness.ts';
import { TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const APP = 'Record it:\n```app title="Voice take" todo=true reason=physical permissions="microphone"\n<button>Done</button>\n```';
const CHAT_ONLY: ClientScope = { kind: 'device', deviceId: 'dev_chat', capabilities: ['chat'] };
type Fixture = ReturnType<typeof rpcFixture>;

/** A short mono 16-bit WAV (RIFF header, so the store sniffs audio/wav); `salt` makes other bytes. */
function wav(seconds = 0.2, salt = 0): Uint8Array {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((i + salt * 7) / 3) * 8000), true);
  return bytes;
}

/** Ava's message with the app (or `body`) and the to-do it became (none for fences that are no to-do). */
function setup(f: Fixture, body = APP, meta?: { via: 'bridge' }) {
  if (!f.org.get('ag_ava')) f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const message = meta
    ? f.chats.send({ conversationId: chat.id, body, authorId: 'ag_ava', authorKind: 'agent', meta })
    : f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', `run_${Math.random().toString(36).slice(2)}`).id, { body, state: 'final' });
  const [todo] = f.tasks.ingestBlocks(message, [], []);
  return { chat, message, todo };
}

/** Records what reaches the store's clean-up instead of queuing it. */
function spyReclaim(f: Fixture): string[][] {
  const calls: string[][] = [];
  (f.services.files as unknown as { reclaim(ids: Iterable<string>): void }).reclaim = (ids) => { calls.push([...ids]); };
  return calls;
}

const put = (f: Fixture, bytes: Uint8Array, name: string, mime?: string): Promise<FileRef> => f.services.files.put(bytes, name, mime);
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');

test('blocks.file registers a stored WAV for an open agent mini-app to-do; repeating it changes nothing', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { message, todo } = setup(f);
  assert.ok(todo, 'the fence is a to-do');
  const take = await put(f, wav(), 'take.wav', 'audio/wav');
  assert.equal(take.mime, 'audio/wav');
  const phone = new TestClient(f.server, TODO_ONLY); // a To-do-only link stores takes like the PC
  const first = await phone.call<{ file: FileRef; count: number; bytes: number }>('blocks.file', { messageId: message.id, blockIndex: 0, fileId: take.id });
  assert.deepEqual([first.file.id, first.file.name, first.count, first.bytes], [take.id, 'take.wav', 1, take.size]);
  const again = await phone.call<{ count: number; bytes: number }>('blocks.file', { messageId: message.id, blockIndex: 0, fileId: take.id });
  assert.deepEqual([again.count, again.bytes], [1, take.size], 'idempotent');
  assert.deepEqual(appFileIds(f.db, message.id, 0), [take.id]);
  assert.deepEqual(new KvRepo(f.db).get(APP_FILES_NS, `${message.id}:0`), { ids: [take.id], bytes: take.size });
  assert.deepEqual(reclaimed, []);
  assert.equal(await code(new TestClient(f.server, CHAT_ONLY).call('blocks.file', { messageId: message.id, blockIndex: 0, fileId: take.id })), 'forbidden', "a device without 'todo'");
});

test('blocks.file refuses what is no open agent mini-app to-do, bad ids and types; refused known files go to the clean-up', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const owner = new TestClient(f.server, TODO_ONLY);
  const take = await put(f, wav(0.2, 1), 'take.wav');
  const call = (messageId: string, fileId = take.id, blockIndex = 0) => code(owner.call('blocks.file', { messageId, blockIndex, fileId }));

  const chat = f.chats.create({ agentIds: [], createdBy: HUMAN_ID });
  const human = f.chats.send({ conversationId: chat.id, body: APP, authorId: HUMAN_ID, authorKind: 'human' });
  assert.equal(await call(human.id), 'bad_request', 'the person wrote the fence');
  assert.equal(await call(setup(f, APP, { via: 'bridge' }).message.id), 'bad_request', 'a bridge relayed it');
  assert.equal(await call(setup(f, 'Calc:\n```app title="Calc"\n<p>1</p>\n```').message.id), 'bad_request', 'an app without todo=true');
  const open = setup(f);
  assert.equal(await call(open.message.id, take.id, 1), 'bad_request', 'no such fence');
  assert.equal(await call('msg_missing00001'), 'not_found');
  assert.equal(reclaimed.length, 5, 'each refusal queued the stored take');
  assert.ok(reclaimed.every((ids) => ids.length === 1 && ids[0] === take.id));

  reclaimed.length = 0;
  assert.equal(await call(open.message.id, 'not-a-file-id'), 'bad_request');
  assert.equal(await call(open.message.id, 'f'.repeat(64)), 'not_found', 'an unknown file');
  const page = await put(f, new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'page.html');
  assert.equal(page.mime, 'text/html');
  await assert.rejects(owner.call('blocks.file', { messageId: open.message.id, blockIndex: 0, fileId: page.id }), {
    code: 'bad_request', message: APP_TYPE_REFUSAL, details: { messageId: open.message.id, blockIndex: 0, fileId: page.id, count: 0, bytes: page.size },
  });
  assert.deepEqual(reclaimed, [[page.id]], 'only the known refused file');
  assert.deepEqual(new KvRepo(f.db).get(APP_FILES_NS, `${open.message.id}:0`), { ids: [], bytes: page.size }, 'stored for the block for nothing: it counts');

  // A file already waiting in the clean-up queue keeps its due time (an external upload's hold).
  reclaimed.length = 0;
  f.db.run("INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, '{}', ?)", [RECLAIM_NS, page.id, f.clock.now() + 3_600_000]);
  assert.equal(await call(open.message.id, page.id), 'bad_request');
  assert.deepEqual(reclaimed, []);
  assert.deepEqual(appFileIds(f.db, open.message.id, 0), [], 'nothing was registered');

  const unknownTodo = f.chats.send({ conversationId: open.chat.id, body: APP, authorId: 'ag_ava', authorKind: 'agent' }); // never ingested
  assert.equal(await call(unknownTodo.id), 'not_found', 'a fence without its to-do');

  // An older stored file is never queued or counted: blocks.file cannot send any stored file to the clean-up.
  reclaimed.length = 0;
  const old = await put(f, wav(0.2, 7), 'old.wav');
  const oldPage = await put(f, new TextEncoder().encode('<html><p>old</p></html>'), 'old.html');
  f.clock.advance(APP_FILE_FRESH_MS + 1);
  const before = new KvRepo(f.db).get(APP_FILES_NS, `${open.message.id}:0`);
  assert.equal(await call('msg_missing00001', old.id), 'not_found');
  assert.equal(await call(human.id, old.id), 'bad_request');
  assert.equal(await call(open.message.id, old.id, 1), 'bad_request');
  assert.equal(await call(open.message.id, oldPage.id), 'bad_request');
  assert.deepEqual(reclaimed, [], 'nothing older than two minutes is queued');
  assert.deepEqual(new KvRepo(f.db).get(APP_FILES_NS, `${open.message.id}:0`), before, 'nor counted against the block');
});

test('the block limits: 100 MB per file, 300 MB and 10 files per block (small limits injected), the 11th file over RPC', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { message } = setup(f);
  const small = { fileBytes: 1_000, blockBytes: 1_500, filesPerBlock: 2 };
  const input = (file: FileRef, messageId = message.id) => ({ messageId, blockIndex: 0, fileId: file.id });
  const a = await put(f, wav(0.05, 1), 'a.wav');
  const b = await put(f, wav(0.05, 2), 'b.wav');
  assert.equal(registerAppFile(f.services, input(a), small).count, 1);
  assert.throws(() => registerAppFile(f.services, input(b), small), {
    code: 'rate_limited', message: 'This mini-app already stored 1 KB.', details: { messageId: message.id, blockIndex: 0, fileId: b.id, count: 1, bytes: a.size },
  });
  assert.equal(registerAppFile(f.services, input(b), { ...small, blockBytes: 10_000 }).count, 2);
  const c = await put(f, wav(0.05, 3), 'c.wav');
  assert.throws(() => registerAppFile(f.services, input(c), { ...small, blockBytes: 10_000 }), { code: 'rate_limited', message: 'This mini-app already stored 2 files.' });
  assert.deepEqual(reclaimed, [[b.id], [c.id]]);

  // A file the block refuses for its size was stored for it for nothing: its bytes count, so refused
  // uploads cannot loop past the block's cap (the next file no longer fits).
  reclaimed.length = 0;
  const looped = setup(f).message.id;
  const big = await put(f, wav(0.1), 'big.wav');
  assert.throws(() => registerAppFile(f.services, input(big, looped), small), {
    code: 'bad_request', message: 'Files from a mini-app can be at most 1 KB.', details: { messageId: looped, blockIndex: 0, fileId: big.id, count: 0, bytes: big.size },
  });
  const d = await put(f, wav(0.05, 4), 'd.wav');
  assert.throws(() => registerAppFile(f.services, input(d, looped), small), { code: 'rate_limited', message: 'This mini-app already stored 1 KB.' });
  assert.deepEqual(appFileIds(f.db, looped, 0), []);
  assert.deepEqual(reclaimed, [[big.id], [d.id]]);

  const other = setup(f);
  const phone = new TestClient(f.server, TODO_ONLY);
  for (let i = 0; i < 10; i++) {
    const file = await put(f, wav(0.05, 10 + i), `take-${i}.wav`);
    assert.equal((await phone.call<{ count: number }>('blocks.file', { messageId: other.message.id, blockIndex: 0, fileId: file.id })).count, i + 1);
  }
  const eleventh = await put(f, wav(0.05, 99), 'take-11.wav');
  await assert.rejects(phone.call('blocks.file', { messageId: other.message.id, blockIndex: 0, fileId: eleventh.id }), { code: 'rate_limited', message: 'This mini-app already stored 10 files.' });
});

test('the answer attaches exactly the named take, wakes Ava with its path, keeps it as evidence and releases the rest', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { chat, message, todo } = setup(f);
  const take = await put(f, wav(0.2, 1), 'take.wav');
  const retake = await put(f, wav(0.2, 2), 'retake.wav');
  for (const file of [retake, take]) registerAppFile(f.services, { messageId: message.id, blockIndex: 0, fileId: file.id });
  f.db.run('DELETE FROM wakes');

  const phone = new TestClient(f.server, TODO_ONLY);
  const answer = { take: { fileId: take.id, name: 'take.wav', mime: 'audio/wav', size: take.size } };
  await phone.call('blocks.answer', { messageId: message.id, blockIndex: 0, answer, clientId: `app:b_${message.id}_0` });
  const done = f.tasks.get(todo.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.result?.summary, 'Done in mini-app · take: take.wav');
  assert.deepEqual(done.result?.evidence, [{ kind: 'file', label: 'take.wav', ref: take.id }]);
  const receipt = f.chats.messages(chat.id).find((item) => item.kind === 'answer')!;
  assert.equal(receipt.body, 'Done in mini-app\ntake: take.wav', 'the take by its name, never its id');
  assert.deepEqual(receipt.attachments.map((item) => [item.fileId, item.name, item.mime]), [[take.id, 'take.wav', 'audio/wav']]);
  const woken = f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava');
  assert.deepEqual(woken.map((wake) => [wake.reason, wake.note]), [['message', null]], 'woken as for a typed line');
  assert.ok(!receipt.attachments.some((item) => item.fileId === retake.id), 'the take it did not name is not offered');
  assert.equal(new KvRepo(f.db).get(APP_FILES_NS, `${message.id}:0`), undefined, 'the registry entry is gone');
  assert.deepEqual(reclaimed, [[retake.id]], 'the unnamed take goes to the clean-up');
  assert.equal(await code(phone.call('blocks.file', { messageId: message.id, blockIndex: 0, fileId: take.id })), 'conflict', 'a finished to-do takes no more files');
});

test('data that names no registered file hands back all; an unregistered id is never attached or given a path', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { chat, message, todo } = setup(f);
  const first = await put(f, wav(0.1, 1), 'first.wav');
  const second = await put(f, wav(0.1, 2), 'second.wav');
  const stranger = await put(f, wav(0.1, 3), 'stranger.wav'); // stored, but never registered for this block
  for (const file of [first, second]) registerAppFile(f.services, { messageId: message.id, blockIndex: 0, fileId: file.id });
  f.db.run('DELETE FROM wakes');

  f.tasks.answer({ messageId: message.id, blockIndex: 0, answer: { file: stranger.id, files: [stranger.id], ok: true }, by: HUMAN_ID });
  const receipt = f.chats.messages(chat.id).find((item) => item.kind === 'answer')!;
  assert.deepEqual(receipt.attachments.map((item) => item.fileId), [first.id, second.id], 'all registered, in order');
  assert.equal(receipt.body, 'Done in mini-app\nfile: a file\nfiles: a file\nok: yes', 'an unregistered id is never named');
  assert.ok(!receipt.body.includes(stranger.id) && !receipt.body.includes('stranger.wav'));
  assert.deepEqual(f.tasks.get(todo.id)?.result?.evidence?.map((item) => item.ref), [first.id, second.id]);
  assert.deepEqual(reclaimed, [], 'everything registered was handed back');

  assert.deepEqual(appAnswerFileIds({ a: [{ b: { c: 'x' } }] }, ['x', 'y']), ['x'], 'nested four levels deep');
  assert.deepEqual(appAnswerFileIds({ a: { b: { c: { d: { e: 'x' } } } } }, ['x', 'y']), ['x', 'y'], 'deeper is not read: names none');
  assert.deepEqual(appAnswerFileIds(null, ['x']), ['x']);
  assert.deepEqual(appAnswerFileIds({ take: 'x' }, []), []);
});

test('declining a mini-app to-do releases its registry and queues its takes; other widgets are left alone', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { message, todo } = setup(f);
  const take = await put(f, wav(0.1, 4), 'take.wav');
  registerAppFile(f.services, { messageId: message.id, blockIndex: 0, fileId: take.id });
  const declined = await new TestClient(f.server, TODO_ONLY).call<{ status: string }>('todos.decline', { id: todo.id, reason: 'No microphone here' });
  assert.equal(declined.status, 'cancelled');
  assert.equal(new KvRepo(f.db).get(APP_FILES_NS, `${message.id}:0`), undefined);
  assert.deepEqual(reclaimed, [[take.id]]);

  releaseAppFiles(f.services, { type: 'record', mode: 'audio' }, []);
  releaseAppFiles(f.services, undefined, []);
  assert.deepEqual(reclaimed, [[take.id]], 'catalog widgets have no registry');
});
