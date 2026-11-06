// B-050 K8 (b): chats.export writes chat folders fresh from the database with their files (owner only); the
// agents' change notices stay on this PC.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { isAgentNotice } from '../../../src/shared/model/message-changes.ts';
import { ChatMirror } from '../../../src/runtime/chat-files/mirror.ts';
import { idSuffix } from '../../../src/runtime/chat-files/format.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const ANNA = 'per_anna000000';

/** The source PC: a chat of the owner, Ada and Anna with an attached file and every level. */
async function source() {
  const f = rpcFixture({ table: createHandlerTable() });
  f.org.add(agent('ag_ada', 'Ada'));
  f.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  const chat = f.chats.create({ title: 'Launch', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  f.chats.setMembers(chat.id, { add: [ANNA] }, HUMAN_ID);
  const file = await f.services.files.put(new TextEncoder().encode('quarterly numbers'), 'numbers.txt', 'text/plain');
  const sent: Message[] = [
    f.chats.send({ conversationId: chat.id, body: 'Numbers attached', attachments: [{ fileId: file.id, name: 'numbers.txt', mime: 'text/plain', size: file.size }], authorId: HUMAN_ID, authorKind: 'human' }),
    f.chats.send({ conversationId: chat.id, body: 'Urgent: check', authorId: HUMAN_ID, authorKind: 'human', priority: 'important' }),
    f.chats.send({ conversationId: chat.id, body: 'Looks fine', authorId: 'ag_ada', authorKind: 'agent', meta: { model: 'gpt-x' } }),
    f.chats.send({ conversationId: chat.id, body: 'thanks', authorId: ANNA, authorKind: 'human', silent: true }),
  ];
  return { f, chat, file, sent, owner: new TestClient(f.server, OWNER) };
}

/** The target PC: another Ada (other id, same name), no Anna. */
function target() {
  const f = rpcFixture({ table: createHandlerTable() });
  f.org.add(agent('ag_ada_here', 'Ada'));
  return { f, owner: new TestClient(f.server, OWNER) };
}

test('export: chat folders with chat.json, month files and files/<sha256>; owner only', async (t) => {
  const src = await source();
  t.after(src.f.cleanup);
  const dir = path.join(src.f.paths.data, 'out');
  const result = await src.owner.call<{ dir: string; chats: number; messages: number; files: number }>('chats.export', { conversationIds: [src.chat.id], dir });
  const total = src.f.chats.messages(src.chat.id, { limit: 500 }).length;
  assert.deepEqual(result, { dir, chats: 1, messages: total, files: 1 });
  const folder = path.join(dir, `launch-${idSuffix(src.chat.id)}`);
  assert.equal(JSON.parse(readFileSync(path.join(folder, 'chat.json'), 'utf8')).id, src.chat.id);
  assert.equal(readFileSync(path.join(dir, 'files', src.file.id), 'utf8'), 'quarterly numbers');
  const lines = readFileSync(path.join(folder, 'messages', '2026-10.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.filter((line) => line.kind === 'text').map((line) => [line.body, line.level, line.author.name]), [
    ['Numbers attached', 'normal', 'Owner'], ['Urgent: check', 'important', 'Owner'], ['Looks fine', 'normal', 'Ada'], ['thanks', 'silent', 'Former colleague'],
  ]);
  const byDefault = await src.owner.call<{ dir: string }>('chats.export', { conversationIds: [src.chat.id] });
  assert.ok(byDefault.dir.startsWith(path.join(src.f.paths.data, 'exports', 'chats-')), byDefault.dir);
  const phone = new TestClient(src.f.server, PHONE);
  assert.equal((await phone.request('chats.export', { conversationIds: [src.chat.id] })).error?.code, 'forbidden');
  assert.equal((await src.owner.request('chats.export', { conversationIds: [src.chat.id], dir: 'relative/out' })).error?.code, 'bad_request');
  assert.equal((await src.owner.request('chats.export', { conversationIds: ['ch_nothere00000'] })).error?.code, 'not_found');
});

test('the agents\' change notices stay on this PC: neither the mirror nor an export writes them (live test 28.10.)', async (t) => {
  const src = await source();
  t.after(src.f.cleanup);
  const root = path.join(src.f.paths.data, 'chats');
  const mirror = new ChatMirror({ services: () => src.f.services, root, flushMs: 5 });
  mirror.start();
  t.after(() => mirror.stop());
  src.f.chats.edit(src.sent[0].id, 'Numbers attached (v2)', HUMAN_ID);
  await mirror.settled();
  const all = src.f.chats.messages(src.chat.id, { limit: 500 });
  assert.equal(all.filter(isAgentNotice).length, 1, 'the notice exists for the agents here');
  const mirrored = readFileSync(path.join(root, `launch-${idSuffix(src.chat.id)}`, 'messages', '2026-10.jsonl'), 'utf8');
  assert.equal(/was (edited|deleted)/.test(mirrored), false, 'the mirror leaves it out');
  assert.ok(mirrored.includes('Numbers attached (v2)'), 'the edit itself is written');
  const dir = path.join(src.f.paths.data, 'out-notices');
  const result = await src.owner.call<{ messages: number }>('chats.export', { conversationIds: [src.chat.id], dir });
  assert.equal(result.messages, all.length - 1);
  const exported = readFileSync(path.join(dir, `launch-${idSuffix(src.chat.id)}`, 'messages', '2026-10.jsonl'), 'utf8');
  assert.equal(/was (edited|deleted)/.test(exported), false, 'the export leaves them out');
});

