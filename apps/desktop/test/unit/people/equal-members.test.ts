// B-050 K1–K3 for people of the organisation: a person's "Message" opens their one default 1:1 with an agent,
// a colleague or the owner (chats.direct, person variant); a colleague's edit or delete of their own line
// reaches agents like the owner's (notice, tombstone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from './rig.ts';
import { findDirect, findOrCreateDirect, isDirect } from '../../../src/runtime/chat/direct.ts';
import type { ConversationSummary, Message } from '../../../src/shared/model/chat.ts';

test('chats.direct for a person: one default 1:1 with an agent, a colleague or the owner – no new chat per click', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const ben = await r.join('Ben Vogt');
  const first = await anna.client.call<ConversationSummary>('chats.direct', { memberId: 'ag_research' });
  assert.equal((await anna.client.call<ConversationSummary>('chats.direct', { memberId: 'ag_research' })).id, first.id);
  assert.equal(first.id, findDirect(r.services, anna.person.id, 'ag_research'));
  assert.equal(isDirect(r.chats.get(first.id)!), true);
  assert.equal(r.chats.list({ includeHidden: true }).filter((chat) => chat.members.some((m) => m.memberId === anna.person.id)).length, 1);
  const owners = await anna.client.call<ConversationSummary>('chats.direct', { memberId: 'owner' });
  assert.equal(owners.id, findDirect(r.services, 'human', anna.person.id), 'the owner\'s 1:1 with her, as "Message" on her opens it');
  assert.ok(owners.members.some((member) => member.memberId === 'owner'), 'seen from her side');
  const bens = await anna.client.call<ConversationSummary>('chats.direct', { memberId: ben.person.id });
  assert.equal(bens.id, findDirect(r.services, ben.person.id, anna.person.id));
  assert.equal((await anna.client.request('chats.direct', { memberId: 'human' })).error?.code, 'bad_request', 'not with herself');
  assert.equal((await anna.client.request('chats.direct', { memberId: 'ag_secret' })).error?.code, 'forbidden', 'an agent of another space');

  r.chats.archive(first.id);
  const back = await anna.client.call<ConversationSummary>('chats.direct', { memberId: 'ag_research' });
  assert.deepEqual([back.id, back.archivedAt], [first.id, undefined], 'archived: opened again and back, never a second one');

  const cara = await r.join('Cara Lind', { scopes: { spaces: ['sp_company'], startChats: false, assignAgents: false } });
  assert.equal((await cara.client.request('chats.direct', { memberId: 'ag_research' })).error?.code, 'forbidden', 'no right to start chats: no new one');
  const given = findOrCreateDirect(r.services, cara.person.id, 'ag_research', { createdBy: 'system' });
  assert.equal((await cara.client.call<ConversationSummary>('chats.direct', { memberId: 'ag_research' })).id, given, 'an existing one opens');
});

test('a colleague\'s edit and delete of their own line reach the agents like the owner\'s', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const room = r.chats.create({ title: 'Launch', agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human' });
  const line = await anna.client.call<Message>('messages.send', { conversationId: room.id, body: 'deploy to staging now' });
  await anna.client.call('messages.edit', { id: line.id, body: 'do NOT deploy' });
  const notice = r.chats.messages(room.id).find((message) => message.meta.status?.details?.edited === line.id);
  assert.ok(notice, 'agents learn the line changed');
  assert.equal(notice!.meta.status?.details?.by, anna.person.id);
  const gone = await anna.client.call<Message>('messages.send', { conversationId: room.id, body: 'typo' });
  await anna.client.call('messages.delete', { id: gone.id });
  const log = r.chats.messages(room.id);
  assert.ok(log.some((message) => message.meta.status?.details?.tombstone === gone.id), 'her deleted line leaves its tombstone');
  assert.ok(log.some((message) => message.meta.status?.details?.deleted === gone.id), 'and a notice for agents');
  // B-057 (owner 30.10.2026): a colleague suggests Ultra for a message like the owner – a hint stored on that message.
  const ultra = await anna.client.call<Message>('messages.send', { conversationId: room.id, body: 'check all six contracts', ultra: true });
  assert.equal(r.chats.message(ultra.id)?.meta.ultra, true);
  assert.equal((await anna.client.request('messages.send', { conversationId: room.id, body: 'x', ultra: 'yes' })).error?.code, 'bad_request');
});
