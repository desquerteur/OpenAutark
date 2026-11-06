// B-050 K8 (a): the derived chat mirror (runtime/chat-files/mirror.ts) over the real chat services:
// finished lines are appended to their month, a streamed answer when it finishes; an edit or a delete
// rewrites the month from the database (the deleted text is gone); a title change renames the folder
// and keeps the id suffix; the people's own chats and the app's own chats are left out (a chat that
// becomes the people's loses its folder), a deleted chat's folder goes; at start the backfill writes
// chats whose stamp differs and leaves current ones alone, and a stopped start resumes; README.md is written;
// a folder or month file deleted by hand while the app runs comes back whole with the next line, and a
// line posted while its month is rewritten from the database is written once.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { ChatMirror, MIRROR_NS } from '../../../src/runtime/chat-files/mirror.ts';
import { idSuffix } from '../../../src/runtime/chat-files/format.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';

const ANNA = 'per_anna000000';

function setup() {
  const f = rpcFixture({ table: createHandlerTable() });
  f.org.add(agent('ag_ada', 'Ada'));
  f.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  const root = path.join(f.paths.data, 'chats');
  const start = () => { const mirror = new ChatMirror({ services: () => f.services, root, flushMs: 5 }); mirror.start(); return mirror; };
  return { f, root, start };
}

const folders = (root: string) => (existsSync(root) ? readdirSync(root).filter((name) => name !== 'README.md').sort() : []);
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
const shard = (root: string, folder: string, month: string) => path.join(root, folder, 'messages', `${month}.jsonl`);

test('finished lines are appended (a streamed answer once it finishes); chat.json names the members; a rename moves the folder', async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const mirror = start();
  t.after(() => mirror.stop());
  const chat = f.chats.create({ title: 'Launch plan', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  const hello = f.chats.send({ conversationId: chat.id, body: 'Hello @Ada', authorId: HUMAN_ID, authorKind: 'human' });
  const quiet = f.chats.send({ conversationId: chat.id, body: 'fyi', authorId: HUMAN_ID, authorKind: 'human', silent: true });
  const answer = f.chats.beginAgentMessage(chat.id, 'ag_ada', 'run_0123456789', { model: 'gpt-x' });
  await mirror.settled();
  const folder = `launch-plan-${idSuffix(chat.id)}`;
  assert.deepEqual(folders(root), [folder]);
  assert.ok(!lines(shard(root, folder, '2026-10')).some((line) => line.id === answer.id), 'a streaming answer is not written yet');
  f.chats.finishAgentMessage(answer.id, { body: 'On it.', state: 'final' });
  await mirror.settled();
  const written = lines(shard(root, folder, '2026-10'));
  assert.deepEqual(written.filter((line) => line.kind === 'text').map((line) => [line.id, line.author.name, line.level, line.body]), [
    [hello.id, 'Owner', 'normal', 'Hello @Ada'], [quiet.id, 'Owner', 'silent', 'fyi'], [answer.id, 'Ada', 'normal', 'On it.'],
  ]);
  assert.equal(written.filter((line) => line.id === answer.id).length, 1, 'written once');
  assert.deepEqual(written.find((line) => line.id === answer.id)?.meta, { model: 'gpt-x' });
  const file = JSON.parse(readFileSync(path.join(root, folder, 'chat.json'), 'utf8'));
  assert.equal(file.format, 'workforce-chat');
  assert.equal(file.id, chat.id);
  assert.deepEqual(file.members.map((member: { id: string; name: string }) => [member.id, member.name]), [[HUMAN_ID, 'Owner'], ['ag_ada', 'Ada']]);
  assert.match(readFileSync(path.join(root, 'README.md'), 'utf8'), /stays the original/);

  f.chats.update(chat.id, { title: 'Go live' }, HUMAN_ID);
  await mirror.settled();
  assert.deepEqual(folders(root), [`go-live-${idSuffix(chat.id)}`], 'renamed; the id suffix stays');
  assert.ok(lines(shard(root, `go-live-${idSuffix(chat.id)}`, '2026-10')).some((line) => line.kind === 'status' && /Renamed/.test(line.body)));
});

test('an edit and a delete rewrite their month from the database; another month gets its own file', async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const mirror = start();
  t.after(() => mirror.stop());
  const chat = f.chats.create({ title: 'Notes', agentIds: [], createdBy: HUMAN_ID });
  const first = f.chats.send({ conversationId: chat.id, body: 'Secret plan', authorId: HUMAN_ID, authorKind: 'human' });
  const second = f.chats.send({ conversationId: chat.id, body: 'Draft two', authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  f.chats.edit(first.id, 'Public plan', HUMAN_ID);
  f.chats.removeMessage(second.id, HUMAN_ID);
  f.clock.set(Date.UTC(2026, 10, 2, 8));
  const november = f.chats.send({ conversationId: chat.id, body: 'November', authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  const folder = `notes-${idSuffix(chat.id)}`;
  const october = readFileSync(shard(root, folder, '2026-10'), 'utf8');
  assert.match(october, /Public plan/);
  assert.doesNotMatch(october, /Secret plan|Draft two/, 'the old and the deleted text are gone');
  assert.equal(lines(shard(root, folder, '2026-10')).filter((line) => line.id === first.id).length, 1);
  assert.ok(lines(shard(root, folder, '2026-10')).find((line) => line.id === first.id)?.editedAt);
  assert.deepEqual(lines(shard(root, folder, '2026-11')).map((line) => line.id), [november.id]);
});

test("the app's own chats stay out; a deleted chat loses its folder; a chat with people is mirrored like any other", async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const mirror = start();
  t.after(() => mirror.stop());
  const todo = f.chats.create({ title: 'To-do', agentIds: [], createdBy: HUMAN_ID });
  f.chats.update(todo.id, { settings: { system: 'todo' } }, 'system');
  f.chats.send({ conversationId: todo.id, body: 'anchor', authorId: HUMAN_ID, authorKind: 'human' });
  const shared = f.chats.create({ title: 'Design', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  f.chats.send({ conversationId: shared.id, body: 'Plans', authorId: HUMAN_ID, authorKind: 'human' });
  const doomed = f.chats.create({ title: 'Doomed', agentIds: [], createdBy: HUMAN_ID });
  f.chats.send({ conversationId: doomed.id, body: 'bye', authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  assert.deepEqual(folders(root), [`design-${idSuffix(shared.id)}`, `doomed-${idSuffix(doomed.id)}`]);
  f.chats.setMembers(shared.id, { add: [ANNA] }, HUMAN_ID);
  f.chats.remove(doomed.id);
  await mirror.settled();
  assert.deepEqual(folders(root), [`design-${idSuffix(shared.id)}`], 'the deleted chat is gone; the owner reads every chat');
  assert.equal(new KvRepo(f.db).get(MIRROR_NS, doomed.id), undefined);
});

test('backfill at start: chats behind are written whole, current ones stay as they are; a stopped start resumes', async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const a = f.chats.create({ title: 'Alpha', agentIds: [], createdBy: HUMAN_ID });
  const b = f.chats.create({ title: 'Beta', agentIds: [], createdBy: HUMAN_ID });
  f.chats.send({ conversationId: a.id, body: 'one', authorId: HUMAN_ID, authorKind: 'human' });
  f.chats.send({ conversationId: b.id, body: 'two', authorId: HUMAN_ID, authorKind: 'human' });

  const stopped = start();
  await stopped.stop(); // stopped before its backfill ran: nothing written, nothing stamped
  assert.deepEqual(folders(root), []);
  assert.equal(new KvRepo(f.db).list(MIRROR_NS).length, 0);

  const first = start();
  await first.settled();
  await first.stop();
  const alpha = `alpha-${idSuffix(a.id)}`;
  const beta = `beta-${idSuffix(b.id)}`;
  assert.deepEqual(folders(root), [alpha, beta]);
  assert.equal(new KvRepo(f.db).list(MIRROR_NS).length, 2);

  // While no mirror runs: Alpha's shard is deleted by hand (current – stays deleted), Beta gets a line (behind – written again).
  rmSync(shard(root, alpha, '2026-10'));
  const missed = f.chats.send({ conversationId: b.id, body: 'missed', authorId: HUMAN_ID, authorKind: 'human' });
  const second = start();
  await second.settled();
  await second.stop();
  assert.equal(existsSync(shard(root, alpha, '2026-10')), false, 'a current chat is not written again');
  assert.deepEqual(lines(shard(root, beta, '2026-10')).map((line) => line.body), ['two', 'missed']);
  assert.ok(lines(shard(root, beta, '2026-10')).some((line) => line.id === missed.id));
});

test('a folder or month file deleted by hand while the app runs is written whole again with the next line (and stays whole after a restart)', async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const mirror = start();
  const chat = f.chats.create({ title: 'Ledger', agentIds: [], createdBy: HUMAN_ID });
  for (let i = 0; i < 20; i++) f.chats.send({ conversationId: chat.id, body: `line ${i}`, authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  const folder = `ledger-${idSuffix(chat.id)}`;
  const texts = () => lines(shard(root, folder, '2026-10')).filter((line) => line.kind === 'text').length;
  assert.equal(texts(), 20);
  rmSync(path.join(root, folder), { recursive: true, force: true });
  f.chats.send({ conversationId: chat.id, body: 'after the folder went', authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  assert.equal(texts(), 21, 'the whole chat, not just the new line');
  rmSync(shard(root, folder, '2026-10'));
  f.chats.send({ conversationId: chat.id, body: 'after the month file went', authorId: HUMAN_ID, authorKind: 'human' });
  await mirror.settled();
  assert.equal(texts(), 22, 'the whole month, not just the new line');
  await mirror.stop();
  const again = start();
  await again.settled();
  await again.stop();
  assert.equal(texts(), 22);
});

test('a line posted while its month is rewritten is written once (before the rewrite began, and between its pages)', async (t) => {
  const { f, root, start } = setup();
  t.after(f.cleanup);
  const mirror = start();
  t.after(() => mirror.stop());
  const chat = f.chats.create({ title: 'Busy', agentIds: [], createdBy: HUMAN_ID });
  const sent = Array.from({ length: 700 }, (_, i) => f.chats.send({ conversationId: chat.id, body: `line ${i}`, authorId: HUMAN_ID, authorKind: 'human' }));
  await mirror.settled();
  const folder = `busy-${idSuffix(chat.id)}`;
  const count = (id: string) => lines(shard(root, folder, '2026-10')).filter((line) => line.id === id).length;

  // Posted after the edit's batch was taken, before its rewrite began: the rewrite has it, the append is dropped.
  f.chats.edit(sent[2].id, 'line 2 (edited)', HUMAN_ID);
  const settled = mirror.settled();
  const early = f.chats.send({ conversationId: chat.id, body: 'early', authorId: HUMAN_ID, authorKind: 'human' });
  await settled;
  await mirror.settled();
  assert.equal(count(early.id), 1);

  // Posted between the rewrite's pages: it becomes one more rewrite, never an append on top.
  const db = f.services.db;
  const all = db.all.bind(db);
  let middle: { id: string } | undefined;
  db.all = ((sql: string, params?: unknown[]) => {
    if (!middle && /FROM messages WHERE conversation_id = \? AND state != 'streaming' AND created_at/.test(sql) && Number(params?.[3]) > -1) {
      middle = f.chats.send({ conversationId: chat.id, body: 'middle', authorId: HUMAN_ID, authorKind: 'human' });
    }
    return all(sql as never, params as never);
  }) as typeof db.all;
  t.after(() => { db.all = all; });
  f.chats.edit(sent[3].id, 'line 3 (edited)', HUMAN_ID);
  await mirror.settled();
  db.all = all;
  await mirror.settled();
  assert.ok(middle, 'the line was posted during the rewrite');
  assert.equal(count(middle!.id), 1);
  assert.equal(lines(shard(root, folder, '2026-10')).length, new Set(lines(shard(root, folder, '2026-10')).map((line) => line.id)).size, 'no line twice');
});
