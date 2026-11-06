// B-050 K10 (tools/builtin/chat-messages.ts): an agent edits and deletes only its own messages (by seq or id), never
// the person's or a colleague's, and of its status lines only its work updates – the lines that record a change
// (members, name, archive) stay; it archives a room of agents only, or one it started with the person, with one line
// naming it – never a chat of the person it merely leads, a default 1:1 (K1: the person still finds it), a chat with
// colleagues or an app-owned chat; it sets its own reply mode in a group, each change with one line naming it (so a
// mode the person set is not changed unseen).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { setReplyMode } from '../../../src/runtime/chat/reply-modes.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const ANNA = 'per_anna000000';

function setup() {
  const h = harness();
  (h.services as { settings?: unknown }).settings = { get: () => ({ profile: { name: 'Sam' } }) };
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben'));
  const run = async (agentId: string, name: string, args: Record<string, unknown>) => {
    const ctx = {
      agent: h.org.get(agentId)!, runId: '', mode: 'general',
      services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
    } as ToolContext;
    const out = await chatTools.find((item) => item.name === name)!.run(args as never, ctx);
    return { failed: out.isError === true, text: (out.content[0] as { text: string }).text };
  };
  return { ...h, run };
}

test('chat.edit and chat.delete: only the agent\'s own messages, by seq or by id', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  const human = h.chats.send({ conversationId: chat.id, body: 'Plan the launch', authorId: HUMAN_ID });
  const own = h.chats.send({ conversationId: chat.id, body: 'On it, draft by 5', authorId: 'ag_ava' });
  const bens = h.chats.send({ conversationId: chat.id, body: 'I take the video', authorId: 'ag_ben' });

  const edited = await h.run('ag_ava', 'chat.edit', { chatId: chat.id, seq: own.seq, text: 'On it, draft by 6' });
  assert.equal(edited.failed, false, edited.text);
  assert.equal(h.chats.message(own.id)!.body, 'On it, draft by 6');
  assert.ok(h.chats.message(own.id)!.editedAt !== undefined);
  for (const other of [human, bens]) {
    const refused = await h.run('ag_ava', 'chat.edit', { messageId: other.id, text: 'changed' });
    assert.equal(refused.failed, true);
    assert.match(refused.text, /Only my own messages/);
    assert.equal(h.chats.message(other.id)!.body, other.body, 'unchanged');
  }
  assert.match((await h.run('ag_ava', 'chat.edit', { chatId: chat.id, text: 'x' })).text, /Name the message/);
  assert.match((await h.run('ag_ava', 'chat.edit', { chatId: chat.id, seq: 99, text: 'x' })).text, /No such message/);

  assert.equal((await h.run('ag_ava', 'chat.delete', { chatId: chat.id, seq: bens.seq })).failed, true, 'not a colleague\'s');
  assert.ok(h.chats.message(bens.id));
  const deleted = await h.run('ag_ava', 'chat.delete', { messageId: own.id });
  assert.equal(deleted.failed, false, deleted.text);
  assert.equal(h.chats.message(own.id), undefined);
  assert.ok(h.chats.message(human.id), 'the person\'s message stays');
});

test('chat.delete: of the agent\'s status lines only its work updates go; the lines that record a change stay', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  assert.equal((await h.run('ag_ava', 'chat.add_members', { chatId: chat.id, members: ['ag_ben'] })).failed, false);
  assert.equal((await h.run('ag_ava', 'chat.rename', { chatId: chat.id, title: 'Launch' })).failed, false);
  const update = JSON.parse((await h.run('ag_ava', 'chat.send', { chatId: chat.id, text: 'Drafting the post', status: true })).text) as { messageId: string };
  const lines = h.chats.messages(chat.id).filter((message) => message.kind === 'status' && message.id !== update.messageId);
  assert.deepEqual(lines.map((line) => [line.meta.status?.type, line.authorId]), [['member_added', 'ag_ava'], ['renamed', 'ag_ava']]);
  for (const line of lines) {
    const refused = await h.run('ag_ava', 'chat.delete', { chatId: chat.id, seq: line.seq });
    assert.equal(refused.failed, true, line.body);
    assert.match(refused.text, /records what happened in the chat: it stays/);
    assert.ok(h.chats.message(line.id), 'the record stays');
  }
  const deleted = await h.run('ag_ava', 'chat.delete', { messageId: update.messageId });
  assert.equal(deleted.failed, false, deleted.text);
  assert.equal(h.chats.message(update.messageId), undefined, 'its own work update goes');
});

test('chat.edit refuses in a chat the agent is not a member of', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ben'], createdBy: HUMAN_ID });
  const bens = h.chats.send({ conversationId: chat.id, body: 'mine', authorId: 'ag_ben' });
  await assert.rejects(h.run('ag_ava', 'chat.edit', { messageId: bens.id, text: 'x' }), /not a member/);
});

test('chat.archive: a room of agents only, or one the agent started with the person – with one line naming it', async () => {
  const h = setup();
  const started = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], humans: true, createdBy: 'ag_ava', lead: 'ag_ava' });
  assert.match((await h.run('ag_ben', 'chat.archive', { chatId: started.id })).text, /I did not start it: only they archive it/);
  assert.equal(h.chats.get(started.id)!.archivedAt, undefined);
  assert.equal((await h.run('ag_ava', 'chat.archive', { chatId: started.id })).failed, false, 'its starter');
  assert.ok(h.chats.get(started.id)!.archivedAt !== undefined);
  const line = h.chats.messages(started.id).find((message) => message.meta.status?.details?.archived === true)!;
  assert.deepEqual([line.body, line.authorId], ['Archived by Ava', 'ag_ava']);
  assert.match((await h.run('ag_ava', 'chat.delete', { messageId: line.id })).text, /records what happened/, 'the line stays');
  assert.match((await h.run('ag_ava', 'chat.archive', { chatId: started.id })).text, /archived already/);

  const agentsOnly = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], humans: false, createdBy: 'ag_ava', lead: 'ag_ava' });
  assert.equal((await h.run('ag_ben', 'chat.archive', { chatId: agentsOnly.id })).failed, false, 'a room of agents only');
});

test('chat.archive never takes the person\'s chat its agent leads, a default 1:1, a chat with colleagues or an app chat', async () => {
  const h = setup();
  // The person's chat: its agent leads it without having started it (the reviewer's probes A and D).
  const persons = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, lead: 'ag_ava' });
  for (const agentId of ['ag_ava', 'ag_ben']) {
    const refused = await h.run(agentId, 'chat.archive', { chatId: persons.id });
    assert.equal(refused.failed, true, agentId);
    assert.match(refused.text, /^Nothing was changed\. The person is in this chat and I did not start it/);
  }
  assert.equal(h.chats.get(persons.id)!.archivedAt, undefined);
  assert.equal(h.chats.messages(persons.id).some((message) => message.meta.status?.details?.archived === true), false, 'no line where nothing changed');

  // K1: a default 1:1 – the person's, a colleague's one the agent opened, two agents' – stays findable.
  h.db.run(`INSERT INTO people (id, name, status, scopes, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', '{"spaces":"all"}', 0, 0)`, [ANNA]);
  const directs = [
    findOrCreateDirect(h.services, HUMAN_ID, 'ag_ava', { createdBy: HUMAN_ID }),
    findOrCreateDirect(h.services, ANNA, 'ag_ava', { createdBy: 'ag_ava' }),
    findOrCreateDirect(h.services, 'ag_ava', 'ag_ben'),
  ];
  for (const chatId of directs) {
    assert.match((await h.run('ag_ava', 'chat.archive', { chatId })).text, /A default 1:1 stays: it is the one chat of its pair/);
    assert.equal(h.chats.get(chatId)!.archivedAt, undefined);
  }
  assert.equal(findDirect(h.services, HUMAN_ID, 'ag_ava'), directs[0], 'the person\'s "Message Ava" still finds it');

  // A colleague could not write in an archived chat: only the person archives it, even when the agent started it.
  const withAnna = h.chats.create({ title: 'Design questions', agentIds: ['ag_ava'], people: [ANNA], humans: false, createdBy: 'ag_ava', lead: 'ag_ava' });
  assert.match((await h.run('ag_ava', 'chat.archive', { chatId: withAnna.id })).text, /Colleagues or outside members are in this chat/);
  assert.equal(h.chats.get(withAnna.id)!.archivedAt, undefined);

  const app = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID, settings: { system: 'todo' } });
  assert.match((await h.run('ag_ava', 'chat.archive', { chatId: app.id })).text, /belongs to the app/);
});

test('chat.reply_mode: the agent sets and clears its own mode in a group, each change with one line naming it', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  assert.equal((await h.run('ag_ava', 'chat.reply_mode', { chatId: chat.id, mode: 'mentions' })).failed, false);
  assert.deepEqual(h.chats.get(chat.id)!.settings.replyModes, { ag_ava: 'mentions' });
  assert.match((await h.run('ag_ava', 'chat.reply_mode', { chatId: chat.id, mode: 'mentions' })).text, /is "mentions" already/);
  await h.run('ag_ava', 'chat.reply_mode', { chatId: chat.id, mode: 'auto' });
  assert.equal(h.chats.get(chat.id)!.settings.replyModes, undefined);

  // The person set Ben to mentions; Ben decides for himself and may widen it again.
  setReplyMode(h.services, chat.id, 'ag_ben', 'mentions', HUMAN_ID);
  assert.deepEqual(h.chats.get(chat.id)!.settings.replyModes, { ag_ben: 'mentions' });
  assert.equal((await h.run('ag_ben', 'chat.reply_mode', { chatId: chat.id, mode: 'all' })).failed, false);
  assert.deepEqual(h.chats.get(chat.id)!.settings.replyModes, { ag_ben: 'all' });
  const lines = h.chats.messages(chat.id).filter((message) => message.meta.status?.details?.replyMode !== undefined);
  assert.deepEqual(lines.map((line) => [line.body, line.authorId, line.silent]), [
    ['Ava answers here only when @mentioned', 'ag_ava', true],
    ['Ava answers here when the lead or a pick decides', 'ag_ava', true],
    ['Ben answers here to every message', 'ag_ben', true],
  ]);
});
