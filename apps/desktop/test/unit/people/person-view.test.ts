// B-050 integration for a person's device (people/perspective.ts, people/access.ts): her own important unread
// turns her chat row red (K4 – the owner's counts never travel), the default-1:1 mark reaches her with its pair
// in her view (K1/K2), and a task's chat is named as she sees it, never after herself (K2).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig } from './rig.ts';
import { findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';

test("a person's chat row: her own important unread turns it red, reading clears it; the default 1:1 mark comes with its pair in her view", async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const id = findOrCreateDirect(r.services, anna.person.id, 'ag_research', { createdBy: 'system' });
  r.chats.send({ conversationId: id, authorId: 'ag_research', authorKind: 'agent', body: 'The server is down', priority: 'important' });
  const last = r.chats.send({ conversationId: id, authorId: 'ag_research', authorKind: 'agent', body: 'Details follow' });
  const row = async () => (await anna.client.call<ConversationSummary[]>('chats.list')).find((chat) => chat.id === id)!;
  const before = await row();
  assert.deepEqual([before.unread, before.importantUnread], [2, 1]);
  assert.equal(before.settings.direct, true);
  assert.deepEqual(before.settings.directPair, ['ag_research', 'human'], 'her own id reads "human" on her device');
  await anna.client.call('chats.markRead', { id, seq: last.seq });
  const after = await row();
  assert.deepEqual([after.unread, after.importantUnread], [0, undefined], 'read: blue and then no badge');
});

test("a person's task names its chat as she sees it – in the owner's 1:1 with her, never her own name", async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const chat = findOrCreateDirect(r.services, 'human', anna.person.id, { createdBy: 'human' });
  const task = r.tasks.create({ conversationId: chat, title: 'Sign the offer', assigneeKind: 'human', assigneeId: anna.person.id, createdBy: 'human' });
  assert.equal(r.tasks.get(task.id)!.conversationTitle, 'Anna Berg', 'the owner sees it named after her');
  const seen = (await anna.client.call<TaskView[]>('tasks.list')).find((entry) => entry.id === task.id);
  assert.ok(seen, 'she reads her task');
  assert.notEqual(seen!.conversationTitle, 'Anna Berg');
  assert.ok(seen!.conversationTitle, 'named after the owner');
});
