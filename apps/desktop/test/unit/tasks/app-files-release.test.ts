// X03 lifecycle gap (INT-13): a mini-app to-do that ends without the person's answer or decline
// still lets go of its registered takes (kv 'app_files'): an agent cancelling it, its message
// deleted (chat/lifecycle.ts cancelAppTodos), the to-do removed (tasks/lifecycle.ts), or its chat
// deleted (chat/lifecycle.ts removeConversation – the tasks go by cascade without hooks). The takes
// go to the blob clean-up; one already queued keeps its due time (a hold).
// Owns: these assertions only. Never: real engines, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECLAIM_NS } from '../../../src/runtime/files/references.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { APP_FILES_NS, appFileIds, registerAppFile } from '../../../src/runtime/tasks/app-files.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';

const APP = 'Record it:\n```app title="Voice take" todo=true reason=physical permissions="microphone"\n<button>Done</button>\n```';
type Fixture = ReturnType<typeof rpcFixture>;
let salts = 0;

/** A short mono 16-bit WAV (the store sniffs audio/wav); `salt` makes other bytes. */
function wav(salt: number): Uint8Array {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((i + salt * 7) / 3) * 8000), true);
  return bytes;
}

/** Ava's message with the app, the to-do it became and `count` takes registered for it. */
async function setup(f: Fixture, count = 1) {
  if (!f.org.get('ag_ava')) f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', `run_${Math.random().toString(36).slice(2)}`).id, { body: APP, state: 'final' });
  const [todo] = f.tasks.ingestBlocks(message, [], []);
  assert.ok(todo, 'the fence is a to-do');
  const takes: FileRef[] = [];
  for (let i = 0; i < count; i++) {
    const take = await f.services.files.put(wav(++salts), `take-${i}.wav`, 'audio/wav');
    registerAppFile(f.services, { messageId: message.id, blockIndex: 0, fileId: take.id });
    takes.push(take);
  }
  return { chat, message, todo, takes, entry: () => new KvRepo(f.db).get(APP_FILES_NS, `${message.id}:0`) };
}

/** Records what reaches the store's clean-up instead of queuing it. */
function spyReclaim(f: Fixture): string[][] {
  const calls: string[][] = [];
  (f.services.files as unknown as { reclaim(ids: Iterable<string>): void }).reclaim = (ids) => { calls.push([...ids]); };
  return calls;
}

test("an agent cancelling its mini-app to-do drops the registry entry and queues the takes", async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { message, todo, takes, entry } = await setup(f, 2);
  assert.deepEqual(appFileIds(f.db, message.id, 0), takes.map((take) => take.id));
  f.tasks.setStatus(todo.id, 'cancelled', 'ag_ava', 'Not needed any more');
  assert.equal(f.tasks.get(todo.id)?.status, 'cancelled');
  assert.equal(entry(), undefined, 'the registry entry is gone');
  assert.deepEqual(reclaimed, [takes.map((take) => take.id)], 'the takes go to the clean-up');
});

test('deleting the message or removing the to-do releases the takes too', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const deleted = await setup(f);
  f.chats.removeMessage(deleted.message.id, HUMAN_ID);
  assert.equal(f.tasks.get(deleted.todo.id)?.status, 'cancelled', 'its app cannot run any more');
  assert.equal(deleted.entry(), undefined);
  assert.deepEqual(reclaimed, [[deleted.takes[0].id]]);

  const removed = await setup(f);
  f.tasks.remove(removed.todo.id, HUMAN_ID);
  assert.equal(removed.entry(), undefined);
  assert.deepEqual(reclaimed.slice(1), [[removed.takes[0].id]]);
});

test('deleting the chat drops its takes and queues them; a take already queued keeps its due time', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  const reclaimed = spyReclaim(f);
  const { chat, takes, entry } = await setup(f, 2);
  const kept = await setup(f); // another chat's take stays registered
  const held = f.clock.now() + 120_000;
  f.db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, '{}', ?)`, [RECLAIM_NS, takes[1].id, held]);
  f.chats.remove(chat.id);
  assert.equal(entry(), undefined, 'the entry went with the chat');
  assert.deepEqual(reclaimed.flat(), [takes[0].id], 'only the take not queued yet');
  assert.equal(f.db.get<{ updated_at: number }>('SELECT updated_at FROM kv WHERE ns = ? AND key = ?', [RECLAIM_NS, takes[1].id])?.updated_at, held, 'the hold stays');
  assert.deepEqual(kept.entry(), { ids: [kept.takes[0].id], bytes: kept.takes[0].size });
});
