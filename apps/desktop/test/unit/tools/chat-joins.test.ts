// B-050 K10 (tools/builtin/chat-joins.ts with chat-rooms.ts and chat-members.ts): whom an agent may seat with whom.
// Colleagues join only by the chat's starter and never a person's default 1:1 (the reviewer's probe B: the owner's
// private line with an agent is not opened to a colleague); a colleague sits only with agents they may work with
// (their spaces), while a pair the room already had stays; members may be named by name – the full name, or a first
// name only one has, never a guess between two; chat.remove_members takes `members` like chat.add_members.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import { agent, harness } from '../chat/harness.ts';

const ANNA = 'per_anna000000'; // may work with every agent
const CARL = 'per_carl000000'; // only with the design space's agents

function setup() {
  const h = harness();
  h.db.run(`INSERT INTO people (id, name, title, status, scopes, created_at, updated_at) VALUES (?, 'Anna Berg', 'Designer', 'active', '{"spaces":"all"}', 0, 0)`, [ANNA]);
  h.db.run(`INSERT INTO people (id, name, status, scopes, created_at, updated_at) VALUES (?, 'Carl Diaz', 'active', '{"spaces":["spc_design"]}', 0, 0)`, [CARL]);
  const names: Record<string, string> = { [HUMAN_ID]: 'Sam', [ANNA]: 'Anna Berg', [CARL]: 'Carl Diaz' };
  Object.assign(h.services, {
    settings: { get: () => ({ profile: { name: 'Sam', timezone: 'UTC' } }) },
    people: { nameOf: (id: string) => names[id], get: () => undefined },
  });
  h.org.add(agent('ag_ava', 'Ava', { spaceId: 'spc_design' }));
  h.org.add(agent('ag_ben', 'Ben', { spaceId: 'spc_design' }));
  h.org.add(agent('ag_fin', 'Finn', { spaceId: 'spc_finance' }));
  const run = async (name: string, args: Record<string, unknown>, agentId = 'ag_ava') => {
    const ctx = {
      agent: h.org.get(agentId)!, runId: `run_${agentId}`, mode: 'general',
      services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
    } as ToolContext;
    const out = await chatTools.find((item) => item.name === name)!.run(args as never, ctx);
    const text = (out.content[0] as { text: string }).text;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* a plain line */ }
    return { failed: out.isError === true, text, data, chatId: data.chatId as string };
  };
  const active = (chatId: string) => h.chats.members(chatId).filter((m) => !m.leftAt).map((m) => m.memberId).sort();
  return { ...h, run, active };
}

test('probe B: the person\'s default 1:1 is never opened to a colleague; colleagues join only by the chat\'s starter', async () => {
  const h = setup();
  const direct = findOrCreateDirect(h.services, HUMAN_ID, 'ag_ava', { createdBy: HUMAN_ID });
  const refused = await h.run('chat.add_members', { chatId: direct, members: [ANNA] });
  assert.equal(refused.failed, true);
  assert.match(refused.text, /^Nothing was changed\. This 1:1 stays between the two of us\. For more people I start a group with chat\.create/, 'B-078 D7');
  assert.deepEqual(h.active(direct), ['ag_ava', HUMAN_ID].sort());
  assert.equal(h.chats.get(direct)!.settings.direct, true, 'still the person\'s default 1:1');
  const opened = (await h.run('chat.direct', { with: HUMAN_ID }, 'ag_ben')).chatId; // one the agent opened itself
  assert.match((await h.run('chat.add_members', { chatId: opened, members: [ANNA] }, 'ag_ben')).text, /This 1:1 stays between the two of us/);
  assert.match((await h.run('chat.add_members', { chatId: direct, members: ['ag_ben'] })).text, /This 1:1 stays between the two of us/, 'D7: agents too');

  const group = h.chats.create({ title: 'Q4', agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, lead: 'ag_ava' });
  assert.match((await h.run('chat.add_members', { chatId: group.id, members: [ANNA] })).text, /Sam started this chat and brings colleagues into it; I ask them/, 'not even its lead');
  assert.equal(h.active(group.id).includes(ANNA), false);
  assert.equal((await h.run('chat.add_members', { chatId: group.id, members: ['ag_fin'] })).failed, false, 'agents join as before');

  const room = h.chats.create({ title: 'Launch', agentIds: ['ag_ava', 'ag_ben'], humans: true, createdBy: 'ag_ava', lead: 'ag_ava' });
  assert.match((await h.run('chat.add_members', { chatId: room.id, members: [ANNA] }, 'ag_ben')).text, /Ava started this chat/);
  assert.equal((await h.run('chat.add_members', { chatId: room.id, members: [ANNA] })).failed, false, 'its starter brings colleagues in');
  assert.ok(h.active(room.id).includes(ANNA));
});

test('a colleague sits only with agents they may work with; a pair the room already had stays', async () => {
  const h = setup();
  const fin = await h.run('chat.direct', { with: CARL }, 'ag_fin');
  assert.equal(fin.failed, true);
  assert.equal(fin.text, 'Nothing was opened. Carl Diaz does not work with Finn (not in the spaces the person gave them).');
  assert.equal(findDirect(h.services, CARL, 'ag_fin'), undefined, 'nothing was made');
  assert.equal((await h.run('chat.direct', { with: CARL, topic: 'Budget' }, 'ag_fin')).failed, true, 'nor a topic chat');
  assert.equal((await h.run('chat.direct', { with: CARL })).failed, false, 'Ava is in his space');
  assert.match((await h.run('chat.create', { members: [CARL, 'ag_fin'] })).text, /^Nothing was created\. Carl Diaz does not work with Finn/);

  const room = (await h.run('chat.create', { title: 'Brand', members: [CARL, 'ag_ben'] })).chatId;
  assert.match((await h.run('chat.add_members', { chatId: room, members: ['ag_fin'] })).text, /^Nothing was changed\. Carl Diaz does not work with Finn/, 'nor an agent added to his room');
  assert.equal(h.active(room).includes('ag_fin'), false);
  h.chats.setMembers(room, { add: ['ag_fin'] }, HUMAN_ID); // the person may seat them together
  assert.equal((await h.run('chat.add_members', { chatId: room, members: [ANNA] })).failed, false, 'an older pair does not block others');

  const old = findOrCreateDirect(h.services, CARL, 'ag_fin'); // e.g. opened by an escalation
  assert.equal((await h.run('chat.direct', { with: CARL }, 'ag_fin')).chatId, old, 'found again: nothing new is opened');
});

test('members by name: the full name or a first name only one has, case ignored; never a guess between two', async () => {
  const h = setup();
  const anna = await h.run('chat.direct', { with: 'Anna' });
  assert.equal(anna.failed, false, anna.text);
  assert.deepEqual(h.active(anna.chatId), ['ag_ava', ANNA].sort());
  assert.equal((await h.run('chat.direct', { with: 'anna berg' })).chatId, anna.chatId);
  assert.deepEqual(h.active((await h.run('chat.direct', { with: 'Ben' })).chatId), ['ag_ava', 'ag_ben']);
  assert.deepEqual(h.active((await h.run('chat.direct', { with: 'Sam' })).chatId), ['ag_ava', HUMAN_ID].sort(), 'the person by the profile name');
  const room = (await h.run('chat.create', { title: 'Brand', members: ['Ben', 'Carl Diaz'] })).chatId;
  assert.deepEqual(h.active(room), ['ag_ava', 'ag_ben', CARL].sort());

  h.org.add(agent('ag_anna', 'Anna Lee', { spaceId: 'spc_design' }));
  const two = await h.run('chat.direct', { with: 'Anna' });
  assert.equal(two.failed, true);
  assert.equal(two.text, '"Anna" fits Anna Berg (per_anna000000), Anna Lee (ag_anna): name one by id.');
  assert.match((await h.run('chat.add_members', { chatId: room, members: ['Zed'] })).text, /^Nobody is called "Zed": name members by id/);
  assert.match((await h.run('chat.direct', { with: 'ag_nobody' })).text, /Unknown agent ag_nobody/, 'an id is never looked up as a name');
});

test('chat.remove_members takes members like chat.add_members (memberIds stays); a colleague who started a chat stays', async () => {
  const h = setup();
  const tool = chatTools.find((item) => item.name === 'chat.remove_members')!;
  assert.deepEqual(validate({ chatId: 'chat_x', members: [ANNA] }, tool.inputSchema), [], 'the reviewer\'s K10-6 call');
  const room = h.chats.create({ title: 'Launch', agentIds: ['ag_ava', 'ag_ben'], people: [ANNA, CARL], humans: false, createdBy: 'ag_ava', lead: 'ag_ava' });
  assert.equal((await h.run('chat.remove_members', { chatId: room.id, members: [ANNA] })).failed, false);
  assert.equal((await h.run('chat.remove_members', { chatId: room.id, memberIds: [CARL] })).failed, false, 'the older name');
  assert.deepEqual(h.active(room.id), ['ag_ava', 'ag_ben']);
  assert.match((await h.run('chat.remove_members', { chatId: room.id })).text, /Name the members to remove/);

  const hers = h.chats.create({ agentIds: ['ag_ava'], people: [ANNA], humans: false, createdBy: ANNA });
  assert.match((await h.run('chat.remove_members', { chatId: hers.id, members: [ANNA] })).text, /Anna Berg stays in this chat: only a chat an agent started can lose them/);
});

test('chat.create with one member and no title opens the pair\'s default 1:1 (K1, as chat.direct); chat.list marks only the agent\'s own default as direct', async () => {
  const h = setup();
  const first = await h.run('chat.create', { members: ['ag_ben'] });
  assert.equal(first.failed, false);
  assert.equal(first.chatId, findDirect(h.services, 'ag_ava', 'ag_ben'));
  assert.equal((await h.run('chat.create', { members: ['Ben'] })).chatId, first.chatId, 'no second chat of the pair');
  assert.equal((await h.run('chat.direct', { with: 'ag_ben' })).chatId, first.chatId);
  const topic = await h.run('chat.create', { members: ['ag_ben'], title: 'Q4 numbers' });
  assert.notEqual(topic.chatId, first.chatId, 'a topic makes its own chat');
  assert.notEqual((await h.run('chat.create', { members: ['ag_ben'], hidden: true })).chatId, first.chatId, 'a hidden work room is never the default');
  const own = await h.run('chat.create', { title: 'Launch research', agentIds: ['ag_ava'] });
  assert.equal(own.failed, false, 'a titled work room of the agent alone, as before B-050');
  assert.deepEqual(h.active(own.chatId), ['ag_ava']);
  assert.equal((await h.run('chat.create', { agentIds: ['ag_ava'] })).failed, true, 'without a title nothing names it');

  // The owner's default 1:1 with Ava, which Ben joined before B-078 (older data – a 1:1 takes nobody now): Ava's own, not Ben's.
  const owners = findOrCreateDirect(h.services, HUMAN_ID, 'ag_ava', { createdBy: HUMAN_ID });
  h.db.run(`INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at, left_at) VALUES (?, 'ag_ben', 'agent', 'member', 0, 0, NULL)`, [owners]);
  const listed = async (agentId: string) => JSON.parse((await h.run('chat.list', {}, agentId)).text) as Array<{ id: string; direct?: boolean }>;
  assert.equal((await listed('ag_ava')).find((chat) => chat.id === owners)?.direct, true);
  assert.equal((await listed('ag_ben')).find((chat) => chat.id === owners)?.direct, undefined, 'a default of others it joined is not its own');
  assert.equal((await listed('ag_ben')).find((chat) => chat.id === first.chatId)?.direct, true);
});
