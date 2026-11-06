// Hidden chats (agent-only rooms, the To-do chat) are not in chats.list, so the store loads a
// missing chat on demand (chats.get, deduplicated) – links from the agent view and tasks open –
// and a reconnect reload keeps the open one instead of unmounting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { rpc, RpcError } from '../../../src/ui/lib/rpc.ts';
import { conversationMap, conversations, ensureConversation, loadAll, route } from '../../../src/ui/lib/store.ts';

function summary(id: string): ConversationSummary {
  return { id, title: id, members: [], settings: { hiddenFromList: true }, createdAt: 0, unread: 0, working: [] } as unknown as ConversationSummary;
}

function stubCalls(answer: (id: string) => Promise<unknown>): Array<{ method: string; params: unknown }> {
  const calls: Array<{ method: string; params: unknown }> = [];
  (rpc as unknown as { call: unknown }).call = (method: string, params: { id: string }) => {
    calls.push({ method, params });
    return answer(params.id);
  };
  return calls;
}

test('ensureConversation: fetches a missing chat once and keeps it in the store', async () => {
  conversations.value = [summary('ch_known')];
  const calls = stubCalls(async (id) => summary(id));
  assert.equal((await ensureConversation('ch_known'))?.id, 'ch_known');
  assert.equal(calls.length, 0, 'known chats need no call');

  const [first, second] = await Promise.all([ensureConversation('ch_room'), ensureConversation('ch_room')]);
  assert.equal(first?.id, 'ch_room');
  assert.equal(second?.id, 'ch_room');
  assert.deepEqual(calls, [{ method: 'chats.get', params: { id: 'ch_room' } }], 'concurrent opens share one request');
  assert.ok(conversationMap.value.has('ch_room'));
  await ensureConversation('ch_room');
  assert.equal(calls.length, 1);
});

test('ensureConversation: a deleted chat resolves undefined, a lost connection rejects (retry later)', async () => {
  conversations.value = [];
  stubCalls(async (id) => { throw new RpcError({ code: id === 'ch_gone' ? 'not_found' : 'unavailable', message: 'x' }); });
  assert.equal(await ensureConversation('ch_gone'), undefined);
  await assert.rejects(ensureConversation('ch_offline'), (error: unknown) => error instanceof RpcError && error.code === 'unavailable');
  // The failed request is not cached: the next attempt asks again.
  const calls = stubCalls(async (id) => summary(id));
  assert.equal((await ensureConversation('ch_offline'))?.id, 'ch_offline');
  assert.equal(calls.length, 1);
  assert.equal(conversations.value.length, 1);
});

function stubMethods(answers: Record<string, (params: { id?: string }) => unknown>): string[] {
  const calls: string[] = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: { id?: string }) => {
    calls.push(method);
    const answer = answers[method];
    return answer ? answer(params ?? {}) : [];
  };
  return calls;
}

const SNAPSHOT = { 'settings.get': () => ({}), 'ui.state': () => ({ drafts: {} }), 'system.info': () => ({}) };

test('loadAll (reconnect): an open hidden chat stays in the store and is refreshed', async () => {
  conversations.value = [summary('ch_listed'), summary('ch_room')];
  route.value = { view: 'chat', id: 'ch_room' };
  const calls = stubMethods({ ...SNAPSHOT, 'chats.list': () => [summary('ch_listed')], 'chats.get': ({ id }) => ({ ...summary(String(id)), title: 'Fresh' }) });
  await loadAll();
  assert.deepEqual(conversations.value.map((chat) => chat.id), ['ch_listed', 'ch_room'], 'no unmount of the open chat');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(conversationMap.value.get('ch_room')?.title, 'Fresh');
  assert.equal(calls.filter((method) => method === 'chats.get').length, 1);
});

test('loadAll (reconnect): a deleted open hidden chat is dropped; closed hidden chats are not kept', async () => {
  conversations.value = [summary('ch_listed'), summary('ch_room'), summary('ch_other_hidden')];
  route.value = { view: 'chat', id: 'ch_room' };
  const gone = () => new Promise((_resolve, reject) => setImmediate(() => reject(new RpcError({ code: 'not_found', message: 'x' }))));
  stubMethods({ ...SNAPSHOT, 'chats.list': () => [summary('ch_listed')], 'chats.get': gone });
  await loadAll();
  assert.deepEqual(conversations.value.map((chat) => chat.id), ['ch_listed', 'ch_room']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(conversations.value.map((chat) => chat.id), ['ch_listed']);

  // A listed open chat needs no extra request.
  route.value = { view: 'chat', id: 'ch_listed' };
  const calls = stubMethods({ ...SNAPSHOT, 'chats.list': () => [summary('ch_listed')] });
  await loadAll();
  assert.equal(calls.includes('chats.get'), false);
  route.value = { view: 'home' };
});
