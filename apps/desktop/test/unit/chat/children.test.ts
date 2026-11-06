// B-078 sub-chats and threads (src/runtime/chat/children.ts, shared/text/chat-sections.ts chatKind, ui/chat/list-order.ts
// nestChats): a chat goes under another one level deep (never under a sub-chat, never itself, never an app chat; a chat
// with sub-chats stays on top), back on top with null; an agent only between chats it is in; a thread is one per
// message, made with its chat's members, and stays on its message; the list nests sub-chats under their parent and
// never shows a thread as a row.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { chatKind } from '../../../src/shared/text/chat-sections.ts';
import { childrenOf, openThread, setParent, threadOf } from '../../../src/runtime/chat/children.ts';
import { nestChats } from '../../../src/ui/chat/list-order.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { agent, harness } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ada', 'Ada'));
  h.org.add(agent('ag_tom', 'Tom'));
  const s = h.services as RuntimeServices;
  const group = h.chats.create({ title: 'Launch', agentIds: ['ag_ada', 'ag_tom'], createdBy: HUMAN_ID });
  const design = h.chats.create({ title: 'Design', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  const copy = h.chats.create({ title: 'Copy', agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  return { ...h, s, group, design, copy };
}

const code = (error: unknown) => (error as { code?: string }).code;

test('a chat goes under another one level deep and back on top', () => {
  const h = setup();
  setParent(h.s, h.design.id, h.group.id, HUMAN_ID);
  assert.equal(h.chats.get(h.design.id)!.settings.parentId, h.group.id);
  assert.deepEqual(childrenOf(h.s, h.group.id), [h.design.id]);
  assert.throws(() => setParent(h.s, h.copy.id, h.design.id, HUMAN_ID), (error: Error) => code(error) === 'conflict' && /itself a sub-chat/.test(error.message), 'never under a sub-chat');
  assert.throws(() => setParent(h.s, h.group.id, h.copy.id, HUMAN_ID), /has sub-chats of its own/, 'a parent stays on top');
  assert.throws(() => setParent(h.s, h.copy.id, h.copy.id, HUMAN_ID), /not under itself/);
  assert.throws(() => setParent(h.s, h.copy.id, 'ch_nothing', HUMAN_ID), (error: Error) => code(error) === 'not_found');
  setParent(h.s, h.design.id, null, HUMAN_ID);
  assert.equal(h.chats.get(h.design.id)!.settings.parentId, undefined, 'back on top');
  assert.deepEqual(childrenOf(h.s, h.group.id), []);
});

test('an agent places only chats it is in, under chats it is in; app chats stay where they are', () => {
  const h = setup();
  assert.throws(() => setParent(h.s, h.copy.id, h.group.id, 'ag_ada'), (error: Error) => code(error) === 'forbidden', 'Ada is not in Copy');
  assert.throws(() => setParent(h.s, h.design.id, h.copy.id, 'ag_ada'), (error: Error) => code(error) === 'forbidden', 'Ada is not in the parent');
  setParent(h.s, h.design.id, h.group.id, 'ag_ada');
  assert.equal(h.chats.get(h.design.id)!.settings.parentId, h.group.id);
  const app = h.chats.create({ title: 'Customize', agentIds: [], createdBy: HUMAN_ID, settings: { system: 'customize' } });
  assert.throws(() => setParent(h.s, h.copy.id, app.id, HUMAN_ID), /belongs to the app/);
});

test('a thread: one per message, the chat\'s members, named after the message, on its message for good', () => {
  const h = setup();
  const line = h.chats.send({ conversationId: h.group.id, body: 'Who picks the venue for the launch party?', authorId: HUMAN_ID, authorKind: 'human' });
  const thread = openThread(h.s, line.id, 'ag_ada');
  assert.equal(thread.settings.parentId, h.group.id);
  assert.equal(thread.settings.anchorId, line.id);
  assert.equal(thread.title, 'Who picks the venue for the launch party?');
  assert.deepEqual(h.chats.members(thread.id).map((member) => member.memberId).sort(), ['ag_ada', 'ag_tom', HUMAN_ID]);
  assert.equal(h.chats.lead(thread.id), 'ag_ada', 'the one who opened it leads it');
  assert.equal(openThread(h.s, line.id, HUMAN_ID).id, thread.id, 'one thread per message');
  assert.equal(threadOf(h.s, line.id), thread.id);
  const inside = h.chats.send({ conversationId: thread.id, body: 'I can', authorId: 'ag_tom' });
  assert.equal(openThread(h.s, inside.id, 'ag_tom').id, thread.id, 'a line in a thread is answered in that thread');
  assert.throws(() => setParent(h.s, thread.id, null, HUMAN_ID), /stays on its message/);
  assert.throws(() => openThread(h.s, h.chats.send({ conversationId: h.copy.id, body: 'x', authorId: 'ag_tom' }).id, 'ag_ada'), (error: Error) => code(error) === 'forbidden');
  // a thread on a sub-chat's message is fine – threads are never list rows, so the one-level rule is the list's
  setParent(h.s, h.design.id, h.group.id, HUMAN_ID);
  const sub = openThread(h.s, h.chats.send({ conversationId: h.design.id, body: 'Logo draft', authorId: 'ag_ada' }).id, 'ag_ada');
  assert.equal(sub.settings.parentId, h.design.id);
});

test('chatKind: thread, sub-chat, 1:1, group, internal room', () => {
  const human = { memberId: HUMAN_ID, kind: 'human' as const };
  const ada = { memberId: 'ag_ada', kind: 'agent' as const };
  const kind = (settings: Record<string, unknown>, members: Array<{ memberId: string; kind: 'human' | 'agent' }>) =>
    chatKind({ settings, members: members.map((member) => ({ ...member, conversationId: 'ch_x', role: 'member' as const, readSeq: 0, joinedAt: 0 })) });
  assert.equal(kind({ parentId: 'ch_p', anchorId: 'msg_1' }, [human, ada]), 'thread');
  assert.equal(kind({ parentId: 'ch_p' }, [human, ada]), 'sub');
  assert.equal(kind({ direct: true }, [human, ada]), 'direct');
  assert.equal(kind({}, [human, ada]), 'group');
  assert.equal(kind({}, [ada]), 'internal');
});

test('the list nests sub-chats under their parent, one level; threads are never rows; no chat drops out', () => {
  const row = (id: string, settings: Record<string, string> = {}) => ({ id, settings });
  const nodes = nestChats([
    row('a'), row('b', { parentId: 'a' }), row('t', { parentId: 'a', anchorId: 'msg_1' }), row('c'),
    row('d', { parentId: 'b' }), row('e', { parentId: 'gone' }), row('f', { parentId: 'a' }),
  ]);
  assert.deepEqual(nodes.map((node) => [node.chat.id, node.children.map((child) => child.id)]), [
    ['a', ['b', 'f']], ['c', []], ['d', []], ['e', []],
  ]);
});

test('a thread counts its real replies – no status line, no silent or streaming row – and names the last author', () => {
  const h = setup();
  const line = h.chats.send({ conversationId: h.group.id, body: 'Who books the band?', authorId: HUMAN_ID, authorKind: 'human' });
  const thread = openThread(h.s, line.id, HUMAN_ID);
  const replies = () => h.chats.list({ includeHidden: true }).find((chat) => chat.id === thread.id)?.replies;
  assert.deepEqual(replies(), { count: 0 }, 'empty: no line under the message');
  h.chats.send({ conversationId: thread.id, body: 'I do', authorId: 'ag_tom' });
  h.chats.status(thread.id, { type: 'note', text: 'Assigned to Tom: Book the band' }, { authorId: SYSTEM_ID });
  h.chats.send({ conversationId: thread.id, body: 'Thanks', authorId: HUMAN_ID, authorKind: 'human' });
  h.chats.status(thread.id, { type: 'note', text: 'Done: Book the band' }, { authorId: SYSTEM_ID });
  assert.deepEqual(replies(), { count: 2, authorId: HUMAN_ID }, 'two replies, the person last – status lines never count');
  assert.equal(h.chats.list({ includeHidden: true }).find((chat) => chat.id === h.group.id)?.replies, undefined, 'only threads carry it');
});

test('a deleted chat takes its threads along and puts its sub-chats on top; a deleted message keeps its thread as a sub-chat', () => {
  const h = setup();
  setParent(h.s, h.design.id, h.group.id, HUMAN_ID);
  const line = h.chats.send({ conversationId: h.group.id, body: 'Venue?', authorId: HUMAN_ID, authorKind: 'human' });
  const thread = openThread(h.s, line.id, HUMAN_ID);
  h.chats.remove(h.group.id);
  assert.equal(h.chats.get(thread.id), undefined, 'its thread went with it');
  assert.equal(h.chats.get(h.design.id)!.settings.parentId, undefined, 'its sub-chat is back on top');

  const top = h.chats.send({ conversationId: h.copy.id, body: 'Headline?', authorId: HUMAN_ID, authorKind: 'human' });
  const kept = openThread(h.s, top.id, HUMAN_ID);
  h.chats.removeMessage(top.id, HUMAN_ID);
  const after = h.chats.get(kept.id)!;
  assert.equal(after.settings.anchorId, undefined, 'no longer a thread on a gone message');
  assert.equal(after.settings.parentId, h.copy.id, 'a sub-chat of that chat, shown in the list');
  assert.equal(chatKind({ settings: after.settings, members: h.chats.members(kept.id) }), 'sub');

  // a thread on a sub-chat's message goes beside that sub-chat (one level)
  const inner = h.chats.create({ title: 'Inner', agentIds: ['ag_ada'], createdBy: HUMAN_ID });
  setParent(h.s, inner.id, h.design.id, HUMAN_ID);
  const msg = h.chats.send({ conversationId: inner.id, body: 'Colour?', authorId: HUMAN_ID, authorKind: 'human' });
  const deep = openThread(h.s, msg.id, HUMAN_ID);
  h.chats.removeMessage(msg.id, HUMAN_ID);
  assert.equal(h.chats.get(deep.id)!.settings.parentId, h.design.id, 'beside its sub-chat, under the top chat');
});
