// B-050 K10 (tools/builtin/chat.ts, chat-rooms.ts, chat-members.ts, chat-lines.ts): agents act in chats like a human
// member – chat.direct finds or makes the default 1:1 with an agent, the person or a colleague (per_…), or a new
// chat of the two about a topic; chat.create and chat.add_members take every kind of member (agentIds and
// includeHuman stay as older names); chat.send takes a level (urgent / silent stay); chat.read and
// chat.search show the context's own lines (context/render.ts) with the #seq, persons by name; chat.list shows the
// title the agent sees and marks the default 1:1.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { renderContext } from '../../../src/runtime/context/delta.ts';
import { renderMessages } from '../../../src/runtime/context/render.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const ANNA = 'per_anna000000';
const GONE = 'per_gone000000';

function setup() {
  const h = harness();
  const people: Record<string, { name: string; title: string }> = { [ANNA]: { name: 'Anna Berg', title: 'Designer' } };
  // Anna may work with every agent (her spaces: all) – who may sit with whom is chat-joins.test.ts.
  h.db.run(`INSERT INTO people (id, name, title, status, scopes, created_at, updated_at) VALUES (?, 'Anna Berg', 'Designer', 'active', '{"spaces":"all"}', 0, 0)`, [ANNA]);
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Gone', 'revoked', 0, 0)`, [GONE]);
  Object.assign(h.services, {
    settings: { get: () => ({ profile: { name: 'Sam', timezone: 'UTC' } }) },
    people: { nameOf: (id: string) => (id === HUMAN_ID ? 'Sam' : people[id]?.name), get: (id: string) => people[id] },
  });
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben'));
  const ctx = (agentId = 'ag_ava', conversationId?: string) => ({
    agent: h.org.get(agentId)!, runId: `run_${agentId}`, conversationId, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  }) as ToolContext;
  const run = async (name: string, args: Record<string, unknown>, context = ctx()) => {
    const out = await chatTools.find((item) => item.name === name)!.run(args as never, context);
    const text = (out.content[0] as { text: string }).text;
    let data: Record<string, unknown> | undefined;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { failed: out.isError === true, text, data };
  };
  const active = (chatId: string) => h.chats.members(chatId).filter((m) => !m.leftAt).map((m) => m.memberId).sort();
  return { ...h, ctx, run, active };
}

test('chat.direct: one default 1:1 per pair for an agent, the person or a colleague; a topic makes a new chat of the two', async () => {
  const h = setup();
  const withBen = await h.run('chat.direct', { with: 'ag_ben' });
  assert.equal(withBen.failed, false, withBen.text);
  const benChat = withBen.data!.chatId as string;
  assert.equal(h.chats.get(benChat)!.settings.direct, true);
  assert.deepEqual(h.active(benChat), ['ag_ava', 'ag_ben']);
  assert.equal(withBen.data!.title, 'Ben', 'named after the other member');
  assert.equal((await h.run('chat.direct', { with: 'ag_ben' })).data!.chatId, benChat, 'found again');
  assert.equal((await h.run('chat.direct', { with: 'ag_ava' }, h.ctx('ag_ben'))).data!.chatId, benChat, 'the same chat from the other side');

  const withHuman = await h.run('chat.direct', { with: HUMAN_ID });
  assert.deepEqual(h.active(withHuman.data!.chatId as string), ['ag_ava', HUMAN_ID].sort());
  assert.equal(withHuman.data!.title, 'Sam');
  const withAnna = await h.run('chat.direct', { with: ANNA });
  assert.deepEqual(h.active(withAnna.data!.chatId as string), ['ag_ava', ANNA].sort());
  assert.equal(withAnna.data!.title, 'Anna Berg');

  const topic = await h.run('chat.direct', { with: ANNA, topic: 'Launch video' });
  const topicChat = h.chats.get(topic.data!.chatId as string)!;
  assert.notEqual(topicChat.id, withAnna.data!.chatId);
  assert.deepEqual([topicChat.title, topicChat.titleNamed, topicChat.settings.direct], ['Launch video', true, undefined]);
  assert.deepEqual(h.active(topicChat.id), ['ag_ava', ANNA].sort());
  assert.equal(topic.data!.title, 'Anna Berg · Launch video');

  for (const [other, why] of [['ag_ava', /someone else/], ['ag_nobody', /Unknown agent ag_nobody/], [GONE, /not a person of the organisation/]] as const) {
    const refused = await h.run('chat.direct', { with: other });
    assert.equal(refused.failed, true, other);
    assert.match(refused.text, why);
  }
});

test('chat.create and chat.add_members take agents, the person and colleagues alike; the older names still work', async () => {
  const h = setup();
  const created = await h.run('chat.create', { title: 'Launch', members: ['ag_ben', HUMAN_ID, ANNA] });
  assert.equal(created.failed, false, created.text);
  const chatId = created.data!.chatId as string;
  assert.deepEqual(h.active(chatId), ['ag_ava', 'ag_ben', ANNA, HUMAN_ID].sort());
  assert.equal(h.chats.lead(chatId), 'ag_ava');
  assert.equal(h.chats.members(chatId).find((m) => m.memberId === ANNA)!.kind, 'human');

  const older = await h.run('chat.create', { agentIds: ['ag_ben'], includeHuman: true });
  assert.deepEqual(h.active(older.data!.chatId as string), ['ag_ava', 'ag_ben', HUMAN_ID].sort());
  assert.match((await h.run('chat.create', { members: [GONE] })).text, /not a person of the organisation/);
  assert.equal((await h.run('chat.create', { members: ['ag_ava'] })).failed, true, 'no member besides oneself');

  const room = (await h.run('chat.create', { title: 'Q4', members: ['ag_ben'] })).data!.chatId as string;
  const added = await h.run('chat.add_members', { chatId: room, members: [ANNA] }, h.ctx('ag_ava', room));
  assert.equal(added.failed, false, added.text);
  assert.ok(h.active(room).includes(ANNA));
  assert.match((await h.run('chat.add_members', { chatId: room, members: [GONE] })).text, /not a person of the organisation/);
  assert.ok(!h.active(room).includes(GONE), 'nothing changed');
  assert.equal((await h.run('chat.add_members', { chatId: room, agentIds: ['ag_ben', ANNA] })).failed, false, 'agentIds is still taken');
  // B-078 D7: the person is reached in my 1:1 with them or a group with them – never added to a room
  assert.match((await h.run('chat.add_members', { chatId: room, members: [HUMAN_ID] })).text, /The person is not added to rooms/);
  assert.ok(!h.active(room).includes(HUMAN_ID));
});

test('chat.send: level important / silent (urgent and silent stay), status stays plain', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const ctx = h.ctx('ag_ava', chat.id);
  const sent = async (args: Record<string, unknown>) => h.chats.message((await h.run('chat.send', { text: 'x', ...args }, ctx)).data!.messageId as string)!;
  const level = (message: Message) => [message.priority, message.silent];
  assert.deepEqual(level(await sent({ level: 'important' })), ['important', false]);
  assert.deepEqual(level(await sent({ level: 'silent' })), ['normal', true]);
  assert.deepEqual(level(await sent({ level: 'normal', urgent: true })), ['normal', false], 'level wins over the older flag');
  assert.deepEqual(level(await sent({ urgent: true })), ['important', false]);
  assert.deepEqual(level(await sent({ silent: true })), ['normal', true]);

  assert.equal((await h.run('chat.send', { text: 'working', status: true, level: 'important' }, ctx)).failed, true);
});

test('chat.read and chat.search show the context\'s lines with #seq, people by name; seq brings one message in full', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_ava'], people: [ANNA], createdBy: HUMAN_ID });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: chat.id, body, authorId, ...extra });
  post(HUMAN_ID, 'Can you draft the launch post?', { priority: 'important' });
  post(ANNA, 'I have the photos ready', { authorKind: 'human' });
  post(HUMAN_ID, 'just a note for later', { silent: true });
  const long = post('ag_ava', `Draft: ${'word '.repeat(1500)}end of draft`);
  const ctx = h.ctx('ag_ava', chat.id);

  const read = await h.run('chat.read', {}, ctx);
  const messages = h.chats.messages(chat.id);
  const rctx = renderContext(h.services as RuntimeServices, 'ag_ava');
  const expected = messages.map((message) => `#${message.seq} ${renderMessages(rctx, [message], { images: false }).lines.join('\n')}`);
  assert.equal(read.text, expected.join('\n'), 'the lines of the context, each led by its #seq');
  assert.match(read.text, /^#1 \[[^\]]+\] Sam\b.*\(important\).*Can you draft the launch post\?$/m, 'time, author and level');
  assert.match(read.text, /Anna Berg \(colleague, Designer\): I have the photos ready/);
  assert.ok(!read.text.includes(ANNA), 'a person by name, never by id');

  const full = await h.run('chat.read', { seq: long.seq }, ctx);
  assert.ok(full.text.startsWith(`#${long.seq} `));
  assert.ok(full.text.includes(`Full text of #${long.seq}:\n${long.body}`), 'the whole body after the cut line');
  assert.match((await h.run('chat.read', { seq: 99 }, ctx)).text, /No message #99/);

  const search = await h.run('chat.search', { text: 'photos' }, ctx);
  assert.match(search.text, new RegExp(`^${chat.id} #2 \\[[^\\]]+\\] Anna Berg \\(colleague, Designer\\): .*photos`));
});

test('chat.list: the title the agent sees, the default 1:1 marked, members by name', async () => {
  const h = setup();
  const direct = (await h.run('chat.direct', { with: HUMAN_ID })).data!.chatId as string;
  const group = (await h.run('chat.create', { title: 'Launch', members: ['ag_ben', ANNA] })).data!.chatId as string;
  // From a turn in the colleagues' room: the owner's 1:1 is the organisation's, so both are within reach (F-52).
  const list = (await h.run('chat.list', {}, h.ctx('ag_ava', group))).data as unknown as Array<Record<string, unknown>>;
  const row = (id: string) => list.find((item) => item.id === id)!;
  assert.deepEqual([row(direct).title, row(direct).direct], ['Sam', true]);
  assert.deepEqual([row(group).title, row(group).direct], ['Launch', undefined]);
  assert.ok((row(group).members as string[]).includes(`Anna Berg (${ANNA})`));
});
