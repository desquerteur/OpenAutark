// B-057 foundation: splits.list / splits.get / splits.stop over the real RPC server (runtime/rpc/handlers/splits.ts)
// with a recording split service – runs.items' access rule through the group's parent run (a phone with 'chat' sees
// the groups of chats it can open and of chat-free runs; a group whose parent chat is gone is left out / refused),
// splits.stop with the rights of runs.cancel as the person, parameter checks, and the answers without a split service.
// Owns: these handler checks. Never: the split lifecycle (services.splits is a fake here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/splits.ts';
import type { SplitService } from '../../../src/runtime/contracts.ts';
import type { SplitGroupView, SplitView } from '../../../src/shared/model/splits.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const T = 1_700_000_000_000;

function view(id: string, parentRunId: string, conversationId?: string): SplitGroupView {
  const split: SplitView = {
    id: `${id}_p1`, groupId: id, agentId: 'ag_ava', idx: 1, of: 1, title: 'Part', brief: 'Brief', context: 'fork', after: [],
    worktree: false, status: 'running', attempts: 1, createdAt: T, runs: 1,
  };
  return {
    id, agentId: 'ag_ava', parentRunId, ...(conversationId ? { conversationId } : {}), thread: conversationId ?? 'src:news', goal: 'Goal',
    ultra: false, status: 'running', parts: 1, createdAt: T, splits: [split],
  };
}

function setup(wired = true) {
  const table = new HandlerTable();
  register(table);
  const f = rpcFixture({ table });
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  f.services.runs.start({ id: 'rn_chat', agentId: 'ag_ava', conversationId: chat.id, trigger: 'message' });
  f.services.runs.start({ id: 'rn_free', agentId: 'ag_ava', trigger: 'event', origin: { source: 'news', label: 'Task news' } });
  f.services.runs.start({ id: 'rn_gone', agentId: 'ag_ava', conversationId: 'cv_gone', trigger: 'message' });
  const groups = [view('sg_chat', 'rn_chat', chat.id), view('sg_free', 'rn_free'), view('sg_gone', 'rn_gone', 'cv_gone')];
  const stops: Array<{ q: unknown; by: string }> = [];
  const service: Pick<SplitService, 'list' | 'get' | 'stop'> = {
    list: (q) => groups.filter((g) => (!q.groupId || g.id === q.groupId) && (!q.agentId || g.agentId === q.agentId)),
    get: (splitId) => {
      const group = groups.find((g) => g.splits.some((s) => s.id === splitId));
      return group ? { split: group.splits[0], group } : undefined;
    },
    stop: (q, by) => { stops.push({ q, by }); return 1; },
  };
  if (wired) f.services.splits = service as SplitService;
  return { f, chat, stops, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

const code = async (promise: Promise<unknown>) => { try { await promise; return 'ok'; } catch (error) { return (error as { code?: string }).code; } };

test('without a split service: an empty list, no split, nothing stopped', async (t) => {
  const { f, owner } = setup(false);
  t.after(f.cleanup);
  assert.deepEqual(await owner.call('splits.list', { agentId: 'ag_ava' }), []);
  assert.equal(await code(owner.call('splits.get', { id: 'sg_chat_p1' })), 'not_found');
  assert.deepEqual(await owner.call('splits.stop', { id: 'sg_chat_p1' }), { stopped: 0 });
});

test('reads follow runs.items through the parent run: the owner sees all, a chat phone what it can open', async (t) => {
  const { f, owner, phone } = setup();
  t.after(f.cleanup);
  const ids = (list: SplitGroupView[]) => list.map((g) => g.id);
  assert.deepEqual(ids(await owner.call<SplitGroupView[]>('splits.list', {})), ['sg_chat', 'sg_free', 'sg_gone']);
  assert.deepEqual(ids(await phone.call<SplitGroupView[]>('splits.list', { agentId: 'ag_ava' })), ['sg_chat', 'sg_free'], 'a gone chat is left out');
  assert.equal((await phone.call<{ group: SplitGroupView }>('splits.get', { id: 'sg_chat_p1' })).group.id, 'sg_chat');
  assert.equal(await code(phone.call('splits.get', { id: 'sg_gone_p1' })), 'forbidden');
  assert.equal(await code(owner.call('splits.get', { id: 'sp_none' })), 'not_found');
  assert.equal(await code(owner.call('splits.list', { colour: 'red' })), 'bad_request');
  assert.equal(await code(owner.call('splits.list', { limit: 0 })), 'bad_request');
});

test('splits.stop needs manage and stops as the person, by split or by group', async (t) => {
  const { f, owner, phone, stops } = setup();
  t.after(f.cleanup);
  assert.equal(await code(phone.call('splits.stop', { id: 'sg_chat_p1' })), 'forbidden');
  assert.deepEqual(await owner.call('splits.stop', { id: 'sg_chat_p1' }), { stopped: 1 });
  assert.deepEqual(await owner.call('splits.stop', { groupId: 'sg_free' }), { stopped: 1 });
  assert.deepEqual(stops, [{ q: { splitId: 'sg_chat_p1' }, by: HUMAN_ID }, { q: { groupId: 'sg_free' }, by: HUMAN_ID }]);
  assert.equal(await code(owner.call('splits.stop', {})), 'bad_request');
  assert.equal(await code(owner.call('splits.stop', { id: 'sg_chat_p1', groupId: 'sg_free' })), 'bad_request', 'that split is not in that group');
  assert.equal(await code(owner.call('splits.stop', { groupId: 'sg_none' })), 'not_found');
});
