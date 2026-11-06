// C2 archive (chat/lifecycle.ts, agents/turn-prepare.ts, tools/builtin/util.ts, rpc chats.unarchive):
// archiving only hides a chat from the person's list – a wake for its task still plans a turn,
// members still post with chat.send and chat.list marks it; includeHidden lists archived chats;
// unarchive emits the summary without a line; an agent's important message or @mention of the
// person and a new to-do or approval for the person bring it back with exactly one 'unarchived'
// line – replies, the person's own messages and to-dos, older to-dos and agents' urgent messages
// in an agent-only or hidden room (nothing there needs the person) do not; chats.unarchive is
// on the 'chat' tier; a deleted message cancels its open mini-app to-do; a deleted message or chat
// takes its saved mini-app state (kv 'block_state') with it; engine files stored for an answer
// deleted meanwhile go to the blob clean-up.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { setup as turnSetup } from '../agents/fixture.ts';
import { OWNER, TODO_ONLY, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { agent, harness, tick } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const archive = () => { h.clock.advance(1000); h.chats.archive(chat.id); h.clock.advance(1000); };
  const archived = () => h.chats.get(chat.id)?.archivedAt !== undefined;
  const lines = () => h.chats.messages(chat.id).filter((message) => message.meta.status?.type === 'unarchived').map((message) => message.body);
  return { ...h, chat, archive, archived, lines };
}

test('an archived chat keeps working: its task plans a turn, members post and chat.list marks it', async () => {
  const h = turnSetup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Draft the plan', assigneeId: h.tom.id, createdBy: h.tom.id });
  h.chats.archive(h.chat.id);
  const plan = await planTurn(h.services, h.request({ taskId: task.id, reason: 'task' }));
  assert.equal(plan?.task?.id, task.id, 'the wake runs a turn instead of being skipped');
  assert.equal(plan?.conversationId, h.chat.id);

  const ctx = {
    agent: h.tom, runId: 'run_send', conversationId: h.chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
  const tool = (name: string) => chatTools.find((item) => item.name === name)!;
  assert.equal((await tool('chat.send').run({ text: 'Plan drafted.' }, ctx)).isError, undefined);
  assert.ok(h.chats.messages(h.chat.id).some((message) => message.body === 'Plan drafted.'));
  assert.ok(h.chats.get(h.chat.id)?.archivedAt, 'an ordinary reply leaves it archived');
  const listed = JSON.parse(((await tool('chat.list').run({}, ctx)).content[0] as { text: string }).text) as Array<{ id: string; archived?: boolean }>;
  assert.equal(listed.find((chat) => chat.id === h.chat.id)?.archived, true);

  assert.equal(h.chats.list().some((chat) => chat.id === h.chat.id), false, 'out of the default list');
  assert.ok(h.chats.list({ includeHidden: true }).find((chat) => chat.id === h.chat.id)?.archivedAt, 'includeHidden lists it');
});

test('unarchive brings the chat back without a line; a listed chat stays as it is', () => {
  const h = setup();
  h.archive();
  const before = h.of('conversation.upserted').length;
  h.chats.unarchive(h.chat.id);
  const events = h.of('conversation.upserted').slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0].archivedAt, undefined);
  assert.equal(h.archived(), false);
  assert.deepEqual(h.lines(), []);
  h.chats.unarchive(h.chat.id);
  assert.equal(h.of('conversation.upserted').length, before + 1);
  assert.ok(h.chats.list().some((chat) => chat.id === h.chat.id));
});

test('an agent\'s important message or @mention of the person brings it back with one line', () => {
  const h = setup();
  h.archive();
  h.chats.send({ conversationId: h.chat.id, body: 'Draft is ready', authorId: 'ag_ava' });
  h.chats.send({ conversationId: h.chat.id, body: 'Please look at it', authorId: HUMAN_ID, priority: 'important' });
  assert.equal(h.archived(), true, 'replies and the person\'s own important messages keep it archived');

  h.chats.send({ conversationId: h.chat.id, body: 'The server is down', authorId: 'ag_ava', priority: 'important' });
  assert.equal(h.archived(), false);
  assert.deepEqual(h.lines(), ['Unarchived: important message from Ava']);
  const line = h.chats.messages(h.chat.id).at(-1)!;
  assert.equal(line.silent, true, 'a quiet line after the message');
  assert.equal(h.chats.summary(h.chat.id).unread, 1, 'only the important message is unread (the person wrote after the draft), not the line');

  h.archive();
  const answer = h.chats.beginAgentMessage(h.chat.id, 'ag_ava', 'run_1');
  h.chats.finishAgentMessage(answer.id, { body: '@Human please sign the offer', state: 'final' });
  assert.equal(h.archived(), false);
  assert.deepEqual(h.lines(), ['Unarchived: important message from Ava', 'Unarchived: Ava mentioned you']);
  assert.ok(h.notified.some((item) => item.kind === 'important' && item.conversationId === h.chat.id), 'the person is told as before');
});

test('agents\' urgent messages in an agent-only or hidden room leave it archived', () => {
  const h = setup();
  h.org.add(agent('ag_ben', 'Ben'));
  const agentsOnly = h.chats.create({ title: 'Ops', agentIds: ['ag_ava', 'ag_ben'], humans: false, createdBy: 'ag_ava', lead: 'ag_ava' });
  const hidden = h.chats.create({ title: 'Notes', agentIds: ['ag_ava', 'ag_ben'], humans: true, createdBy: 'ag_ava', lead: 'ag_ava', settings: { hiddenFromList: true } });
  for (const room of [agentsOnly, hidden]) {
    h.chats.archive(room.id);
    h.chats.send({ conversationId: room.id, body: '@Ben the build is red', authorId: 'ag_ava', priority: 'important' });
    h.chats.send({ conversationId: room.id, body: '@Human FYI', authorId: 'ag_ben' });
    assert.ok(h.chats.get(room.id)?.archivedAt, room.title);
    assert.equal(h.chats.messages(room.id).some((message) => message.meta.status?.type === 'unarchived'), false, room.title);
  }
  assert.equal(h.notified.some((item) => item.conversationId === agentsOnly.id || item.conversationId === hidden.id), false, 'nobody is told either');
});

test('a new to-do or approval for the person brings it back; their own and older to-dos do not', () => {
  const h = setup();
  const older = h.tasks.create({ conversationId: h.chat.id, title: 'Pick a venue', assigneeKind: 'human', humanReason: 'taste', createdBy: 'ag_ava' });
  h.archive();
  h.tasks.update(older.id, { notes: 'Two options left' }, HUMAN_ID);
  h.tasks.create({ conversationId: h.chat.id, title: 'Buy stamps', assigneeKind: 'human', humanReason: 'physical', createdBy: HUMAN_ID });
  h.tasks.create({ conversationId: h.chat.id, title: 'Book the hall', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'ag_ava' });
  assert.equal(h.archived(), true, 'an older to-do, the person\'s own and agent work keep it archived');

  h.tasks.create({ conversationId: h.chat.id, title: 'Sign the contract', assigneeKind: 'human', humanReason: 'identity', createdBy: 'ag_ava' });
  assert.equal(h.archived(), false);
  h.archive();
  h.tasks.create({ conversationId: h.chat.id, title: 'Run the deploy', assigneeKind: 'human', humanReason: 'approval', createdBy: 'system' });
  assert.equal(h.archived(), false);
  assert.deepEqual(h.lines(), ['Unarchived: a to-do for you', 'Unarchived: an approval for you']);
});

test('chats.unarchive is on the chat tier', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  f.chats.archive(chat.id);
  const owner = new TestClient(f.server, OWNER);
  const listed = await owner.call<Array<{ id: string; archivedAt?: number }>>('chats.list', { includeHidden: true });
  assert.ok(listed.find((item) => item.id === chat.id)?.archivedAt, 'the window snapshot holds archived chats');
  assert.equal((await new TestClient(f.server, TODO_ONLY).request('chats.unarchive', { id: chat.id })).error?.code, 'forbidden');
  const phone = new TestClient(f.server, { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat'], secure: true });
  assert.deepEqual(await phone.call('chats.unarchive', { id: chat.id }), { ok: true });
  assert.equal(f.chats.get(chat.id)?.archivedAt, undefined);
  assert.equal((await owner.request('chats.unarchive', { id: 'ch_missing' })).error?.code, 'not_found');
});

test('deleting a message cancels its open mini-app to-do', () => {
  const h = setup();
  const message = h.chats.send({ conversationId: h.chat.id, body: 'Record it here:\n```app title="Voice take" todo=true\n<button>Done</button>\n```', authorId: 'ag_ava' });
  h.tasks.ingestBlocks(message, [], []);
  const [todo] = h.tasks.todos();
  assert.equal(todo?.title, 'Voice take');
  h.chats.removeMessage(message.id, HUMAN_ID);
  assert.equal(h.tasks.get(todo.id)?.status, 'cancelled');
});

test('a deleted message or chat takes its saved mini-app state with it', () => {
  const h = setup();
  const keys = () => h.db.all<{ key: string }>(`SELECT key FROM kv WHERE ns = 'block_state' ORDER BY key`).map((row) => row.key);
  const first = h.chats.send({ conversationId: h.chat.id, body: 'One', authorId: 'ag_ava' });
  const second = h.chats.send({ conversationId: h.chat.id, body: 'Two', authorId: 'ag_ava' });
  const other = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const elsewhere = h.chats.send({ conversationId: other.id, body: 'Three', authorId: 'ag_ava' });
  for (const key of [`${first.id}:0`, `${first.id}:1`, `${second.id}:0`, `${elsewhere.id}:0`]) {
    h.db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('block_state', ?, '{}', 0)`, [key]);
  }
  h.chats.removeMessage(first.id, HUMAN_ID);
  assert.deepEqual(keys(), [`${second.id}:0`, `${elsewhere.id}:0`].sort());
  h.chats.remove(h.chat.id);
  assert.deepEqual(keys(), [`${elsewhere.id}:0`]);
});

test('engine files stored for an answer deleted meanwhile go to the blob clean-up', async () => {
  const h = setup();
  let release!: () => void;
  const stored = new Promise<void>((resolve) => { release = resolve; });
  const fileId = 'b'.repeat(64);
  const reclaimed: string[] = [];
  Object.assign(h.services, {
    paths: { workspace: 'workspace', temp: 'temp' },
    files: {
      put: async (_data: Uint8Array, name: string) => { await stored; return { id: fileId, name, mime: 'image/png', size: 3, createdAt: 0 }; },
      reclaim: (ids: string[]) => { reclaimed.push(...ids); }, reconcileOrphans: () => {}, remove: () => {},
    },
  });
  const answer = h.chats.beginAgentMessage(h.chat.id, 'ag_ava', 'run_1');
  h.chats.finishAgentMessage(answer.id, { body: 'Here is the chart', state: 'final', files: [{ name: 'chart.png', dataBase64: 'AAAA' }] });
  h.chats.removeMessage(answer.id, HUMAN_ID);
  release();
  await tick();
  await tick();
  assert.deepEqual(reclaimed, [fileId]);
  assert.equal(h.of('message.updated').some((message) => message.id === answer.id), false, 'never announced');
});
