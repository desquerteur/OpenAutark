// B-050 K8 (e) and K4 for connector tokens (bridges/external-rpc.ts): `as: {key, name}` posts as a
// sender behind the connector – its own external member 'ext:api:<token key>:<sender hash>:<label>'
// that joins on its first message, keeps its first name, is heard in its mentions and – through the
// owner's real chats.members and messages.send, a '+' key and a name with a space included – can be
// @mentioned and removed, and then stays out; `silent: true` posts quietly; `priority: 'important'`
// only with a token made trusted and only as the connector itself; the rate limit counts the token
// with all its senders; the external view keeps the model tag.
// Owns: these checks. Never: opens a network socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { authenticateExternal } from '../../../src/runtime/bridges/external-agents.ts';
import { senderHash } from '../../../src/runtime/bridges/external-rpc.ts';
import { isIdLike } from '../../../src/runtime/rpc/params.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { externalMessage, mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

function setup() {
  const f = rpcFixture({ table: createHandlerTable() });
  f.org.add(agent('ag_ada', 'Ada'));
  const chat = f.chats.create({ title: 'Family', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const connect = async (trusted?: boolean) => {
    const made = await owner.call<{ memberId: string; token: string }>('chats.connectExternal', { conversationId: chat.id, name: 'WhatsApp bridge', ...(trusted ? { trusted } : {}) });
    const scope = authenticateExternal(f.services, made.token)!;
    return { ...made, scope, client: new TestClient(f.server, scope) };
  };
  return { f, chat, owner, connect };
}

test('as {key, name}: a sender joins on its first message, keeps its first name, stays out once removed, is heard in its mentions', async (t) => {
  const s = setup();
  t.after(s.f.cleanup);
  const { client, memberId, scope } = await s.connect();
  const prefix = `${memberId.split(':').slice(0, 3).join(':')}:`;
  const first = await client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'Hallo', as: { key: '+4917012345', name: 'Anna: Müller' } });
  assert.equal(first.authorId, `${prefix}${senderHash('+4917012345')}:Anna-Muller`);
  assert.ok(isIdLike(first.authorId), 'the sender id passes the RPC id check');
  assert.equal(first.authorKind, 'external');
  const member = s.f.chats.members(s.chat.id).find((m) => m.memberId === first.authorId);
  assert.equal(member?.kind, 'external');
  assert.ok(s.f.chats.messages(s.chat.id).some((m) => m.meta.status?.type === 'member_added' && m.meta.status.details?.memberId === first.authorId));
  const renamed = await client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'Again', as: { key: '+4917012345', name: 'Anna M.' } });
  assert.equal(renamed.authorId, first.authorId, 'the first name stays');
  const own = await client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'From the bridge itself' });
  assert.equal(own.authorId, memberId);
  assert.equal((await client.request('messages.send', { conversationId: s.chat.id, body: 'x', as: { key: 'a:b', name: 'X' } })).error?.code, 'bad_request');
  assert.equal((await client.request('messages.send', { conversationId: s.chat.id, body: 'x', as: { key: 'k', name: 'X', extra: 1 } })).error?.code, 'bad_request');

  assert.ok(mayReceive(scope, `chat:${s.chat.id}`, 'external.mention', { memberId: first.authorId }), 'a mention of its sender reaches the token');
  assert.ok(!mayReceive(scope, `chat:${s.chat.id}`, 'external.mention', { memberId: 'ext:api:9999999999:+4917012345:Anna' }));

  // The owner's real RPC: @mention the sender, then remove it from the chat.
  const reply = await s.owner.call<Message>('messages.send', { conversationId: s.chat.id, body: 'Hi Anna', mentions: [first.authorId] });
  assert.deepEqual(reply.mentions, [first.authorId]);
  await s.owner.call('chats.members', { id: s.chat.id, remove: [first.authorId] });
  assert.equal(s.f.chats.members(s.chat.id).some((m) => m.memberId === first.authorId), false);
  const refused = await client.request('messages.send', { conversationId: s.chat.id, body: 'Still here?', as: { key: '+4917012345', name: 'Anna' } });
  assert.deepEqual([refused.error?.code, refused.error?.details?.reason], ['forbidden', 'removed']);
  const other = await client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'Hi', as: { key: 'anna', name: 'Anna Mueller' } });
  assert.notEqual(other.authorId, first.authorId, 'another key is another sender');
  assert.equal((await client.request('messages.send', { conversationId: s.chat.id, body: 'Own line' })).error, undefined, 'removing a sender leaves the connector');
});

test('silent posts quietly; important needs a trusted token; the minute limit counts the token with its senders', async (t) => {
  const s = setup();
  t.after(s.f.cleanup);
  const plain = await s.connect();
  const quiet = await plain.client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'quiet note', silent: true });
  assert.deepEqual([quiet.silent, quiet.priority], [true, 'normal']);
  assert.equal((await plain.client.request('messages.send', { conversationId: s.chat.id, body: 'x', priority: 'important' })).error?.code, 'bad_request');
  const trusted = await s.connect(true);
  const loud = await trusted.client.call<Message>('messages.send', { conversationId: s.chat.id, body: 'Door is open!', priority: 'important' });
  assert.deepEqual([loud.priority, loud.silent], ['important', false]);
  const asSender = await trusted.client.request('messages.send', { conversationId: s.chat.id, body: 'URGENT!!', priority: 'important', as: { key: 'spam', name: 'Spam' } });
  assert.equal(asSender.error?.code, 'bad_request', 'a contact behind a trusted connector posts no important message');
  assert.equal(s.f.chats.members(s.chat.id).some((m) => m.memberId.endsWith(':Spam')), false);

  for (let i = 0; i < 9; i++) await plain.client.call('messages.send', { conversationId: s.chat.id, body: `line ${i}`, as: { key: `s${i}`, name: `Sender ${i}` } });
  const limited = await plain.client.request('messages.send', { conversationId: s.chat.id, body: 'one too many', as: { key: 'late', name: 'Late' } });
  assert.equal(limited.error?.code, 'rate_limited');
  assert.equal(s.f.chats.members(s.chat.id).some((m) => m.memberId.endsWith(':late:Late')), false, 'a refused send adds no sender');
});

test('the external view keeps the model tag and a status line, nothing else of meta', () => {
  const message = {
    id: 'msg_1', conversationId: 'ch_1', seq: 1, authorId: HUMAN_ID, authorKind: 'human', kind: 'text', body: 'Use the big one', attachments: [], mentions: [],
    priority: 'normal', state: 'final', silent: false, runId: 'run_1', createdAt: 1,
    meta: { modelHint: { modelId: 'opus', effort: 'high' }, secrets: ['sec_1'], model: 'x' },
  } as Message;
  assert.deepEqual(externalMessage(message).meta, { modelHint: { modelId: 'opus', effort: 'high' } });
  assert.equal(externalMessage(message).runId, undefined);
});
