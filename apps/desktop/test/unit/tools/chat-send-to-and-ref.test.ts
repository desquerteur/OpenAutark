// B-054 P16 and S10: chat.send {to} and chat.send {taskId}. `to` sends into the agent's default 1:1 with that
// member (opened once, then reused) – also from a run without a chat; `to` and chatId together are refused.
// `taskId` without text posts one kind 'task' live reference (never a second anchor); an "Only me" task is never
// linked into another chat.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import { findDirect } from '../../../src/runtime/chat/direct.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const ANNA = 'per_anna000000';
const textOf = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_lea', 'Lea'));
  Object.assign(f.org, { canManage: (viewer: string) => viewer === 'human' }); // no agent manages another here
  f.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  const s = f.services as RuntimeServices;
  const send = chatTools.find((tool) => tool.name === 'chat.send')!;
  const call = async (args: Record<string, unknown>, conversationId?: string, agentId = 'ag_ava') => {
    const ctx = { agent: f.org.get(agentId)!, runId: 'run_1', conversationId, mode: 'general', services: s, signal: new AbortController().signal, status() {} } as ToolContext;
    let out: ToolOutput;
    try { out = await send.run(args as never, ctx); } catch (error) { return { error: true, text: `ERROR ${(error as Error).message}`, data: undefined }; }
    const text = textOf(out);
    return { error: out.isError === true, text, data: out.isError ? undefined : JSON.parse(text) as Record<string, unknown> };
  };
  const chatCount = () => f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n;
  return { f, s, call, chatCount };
}

test('chat.send {to:"human"} from a run without a chat opens the 1:1 once and reuses it', async (t) => {
  const { f, s, call, chatCount } = rig(t);
  const before = chatCount();
  const first = await call({ to: 'human', text: 'I answered Maria and filed the newsletter.' });
  assert.equal(first.error, false, first.text);
  const direct = findDirect(s, 'ag_ava', 'human');
  assert.equal(first.data?.chatId, direct);
  assert.equal(chatCount(), before + 1, 'one 1:1 opened');
  const second = await call({ to: 'human', text: 'Delivery confirmed.' });
  assert.equal(second.data?.chatId, direct, 'reused');
  assert.equal(chatCount(), before + 1);
  assert.deepEqual(f.chats.messages(direct!, { limit: 10 }).filter((m) => m.authorId === 'ag_ava').map((m) => m.body), ['I answered Maria and filed the newsletter.', 'Delivery confirmed.']);
  const both = await call({ to: 'human', chatId: direct, text: 'x' });
  assert.equal(both.error, true);
  assert.match(both.text, /chatId or to, not both/);
  const empty = await call({ to: 'human' });
  assert.match(empty.text, /give text, or taskId/);
});

test('chat.send {taskId} without text: a live reference in another chat, never a second anchor', async (t) => {
  const { f, call } = rig(t);
  const a = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const b = f.chats.create({ agentIds: ['ag_ava', 'ag_lea'], createdBy: 'human' });
  const task = f.tasks.create({ conversationId: a.id, title: 'Prepare the offer', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const out = await call({ chatId: b.id, taskId: task.id }, a.id);
  assert.equal(out.error, false, out.text);
  const message = f.chats.message(String(out.data?.messageId))!;
  assert.equal(message.conversationId, b.id);
  assert.equal(message.kind, 'task');
  assert.equal(message.taskId, task.id);
  assert.notEqual(message.id, f.tasks.get(task.id)!.messageId, 'a reference, not the anchor');
  assert.equal(f.tasks.get(task.id)!.conversationId, a.id, 'the task stays handed over in A');
});

test('an "Only me" task is never linked into another chat', async (t) => {
  const { f, call } = rig(t);
  const own = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const mine = f.tasks.create({ conversationId: own.id, title: 'Private plan', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  f.db.run('UPDATE tasks SET private = 1 WHERE id = ?', [mine.id]);
  const other = f.chats.create({ agentIds: ['ag_ava', 'ag_lea'], createdBy: 'human' });
  const onlyMe = await call({ chatId: other.id, taskId: mine.id }, own.id);
  assert.match(onlyMe.text, /"Only me"/);
  const withText = await call({ chatId: other.id, taskId: mine.id, text: 'About this one' }, own.id);
  assert.match(withText.text, /"Only me"/, 'a message with text links the task too');
});

