// Agent membership tools (C2, tools/builtin/chat-members.ts) against the real chat service: the
// lead removes an agent with a quiet line and the removed agent is no longer woken there; a member
// who is neither lead, creator nor the agent's manager is refused, a manager of the agent may; an
// agent that still owns open work in the chat stays until it is handed on; the person can be
// taken out of an agent's room by its lead or creator, never out of a chat they started or one the
// runtime opened for them (createdBy SYSTEM_ID, e.g. 'From <PC>'); external members go only by the lead; the person is never added to a room (B-078 D7: the refusal
// names the 1:1 and chat.create, nobody is told); rename only by the lead or creator and
// never over a name the person gave; set_lead only by the current lead, with one line; app-owned
// chats refuse every change; chat.create hides a hidden room from its first event on.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { chatSection } from '../../../src/shared/text/chat-sections.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import { personNamed } from '../../../src/runtime/tools/builtin/chat-members.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_boss', 'Boss'));
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben', { managerId: 'ag_boss' }));
  h.org.add(agent('ag_cal', 'Cal'));
  const run = async (agentId: string, name: string, args: Record<string, unknown>) => {
    const tool = chatTools.find((item) => item.name === name)!;
    const ctx = {
      agent: h.org.get(agentId)!, runId: `run_${agentId}`, mode: 'general',
      services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
    } as ToolContext;
    const out = await tool.run(args as never, ctx);
    const text = (out.content[0] as { text: string }).text;
    return { failed: out.isError === true, text, data: out.isError ? undefined : safeJson(text) };
  };
  /** A room Ava starts (she is its creator and lead). */
  const room = async (args: Record<string, unknown> = {}) => (await run('ag_ava', 'chat.create', { title: 'Research', agentIds: ['ag_ben', 'ag_cal', 'ag_boss'], ...args })).data.chatId as string;
  const active = (chatId: string) => h.chats.members(chatId).map((member) => member.memberId);
  const lines = (chatId: string, type: string) => h.chats.messages(chatId).filter((message) => message.meta.status?.type === type);
  return { ...h, run, room, active, lines };
}

function safeJson(text: string) {
  try { return JSON.parse(text); } catch { return undefined; }
}

test('the lead removes an agent with a line; an outsider is refused, the agent\'s manager may remove it', async () => {
  const h = setup();
  const chatId = await h.room();
  const refused = await h.run('ag_cal', 'chat.remove_members', { chatId, memberIds: ['ag_ben'] });
  assert.equal(refused.failed, true);
  assert.match(refused.text, /^Nothing was changed\. Only this chat's lead or creator, or a manager of Ben/);
  assert.ok(h.active(chatId).includes('ag_ben'), 'nothing changed');

  assert.equal((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: ['ag_cal'] })).failed, false);
  const [line] = h.lines(chatId, 'member_removed');
  assert.equal(line.body, 'Removed Cal');
  assert.equal(line.authorId, 'ag_ava', 'the line names who did it');

  assert.equal((await h.run('ag_boss', 'chat.remove_members', { chatId, memberIds: ['ag_ben'] })).failed, false, 'a manager in the chain');
  assert.deepEqual(h.active(chatId).sort(), ['ag_ava', 'ag_boss']);
  assert.equal((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: ['ag_cal'] })).failed, true, 'no longer a member');

  // A removed agent is not woken by the room any more.
  h.chats.send({ conversationId: chatId, body: '@Cal @Ben the venue list is ready', authorId: 'ag_ava' });
  assert.equal(h.wakeRows().some((wake) => wake.agent_id === 'ag_cal' || wake.agent_id === 'ag_ben'), false);
});

test('an agent that still owns open work in the chat stays until it is handed on', async () => {
  const h = setup();
  const chatId = await h.room();
  const task = h.tasks.create({ conversationId: chatId, title: 'Compare venues', assigneeKind: 'agent', assigneeId: 'ag_cal', createdBy: 'ag_ava' });
  const kept = await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: ['ag_ben', 'ag_cal'] });
  assert.equal(kept.text, 'Nothing was changed. Cal still owns an open task here – hand it on first (tasks.assign).');
  assert.ok(h.active(chatId).includes('ag_ben') && h.active(chatId).includes('ag_cal'), 'all or nothing');

  h.tasks.setStatus(task.id, 'cancelled', 'ag_ava', 'Not needed');
  assert.equal((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: ['ag_cal'] })).failed, false);
  assert.equal(h.active(chatId).includes('ag_cal'), false);
});

test('the person leaves an agent\'s room only by its lead or creator, never a chat they or the runtime started', async () => {
  const h = setup();
  const chatId = await h.room({ includeHuman: true });
  assert.match((await h.run('ag_boss', 'chat.remove_members', { chatId, memberIds: [HUMAN_ID] })).text, /Only this chat's lead or creator can take the person out/);
  assert.equal((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: [HUMAN_ID] })).failed, false);
  assert.equal(chatSection(h.chats.summary(chatId)), 'team', 'the room moved to Team activity');

  const own = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  const lead = h.chats.lead(own.id)!;
  const kept = await h.run(lead, 'chat.remove_members', { chatId: own.id, memberIds: [HUMAN_ID, 'ag_ben'] });
  assert.match(kept.text, /The person stays in this chat: only a chat an agent started can lose them/);
  assert.deepEqual(h.active(own.id).sort(), [HUMAN_ID, 'ag_ava', 'ag_ben'].sort(), 'all or nothing');

  // A chat the runtime opened for the person (they are a plain 'member', an agent leads it).
  const inbox = h.chats.create({ title: 'From Office PC', agentIds: ['ag_ava'], humans: true, createdBy: SYSTEM_ID, lead: 'ag_ava' });
  assert.equal(h.chats.members(inbox.id).find((member) => member.memberId === HUMAN_ID)?.role, 'member');
  assert.equal(h.chats.lead(inbox.id), 'ag_ava');
  const stays = await h.run('ag_ava', 'chat.remove_members', { chatId: inbox.id, memberIds: [HUMAN_ID] });
  assert.equal(stays.failed, true);
  assert.match(stays.text, /The person stays in this chat/);
  assert.ok(h.active(inbox.id).includes(HUMAN_ID));
});

test('external members only by the lead; set_lead only by the current lead, with one line', async () => {
  const h = setup();
  const chatId = await h.room();
  const ext = 'ext:tg:1:Ann (Telegram)';
  h.chats.setMembers(chatId, { add: [ext] }, HUMAN_ID);

  assert.match((await h.run('ag_ben', 'chat.set_lead', { chatId, agentId: 'ag_ben' })).text, /Only this chat's current lead/);
  assert.match((await h.run('ag_ava', 'chat.set_lead', { chatId, agentId: 'ag_zed' })).text, /not an agent in this chat/);
  assert.equal((await h.run('ag_ava', 'chat.set_lead', { chatId, agentId: 'ag_ben' })).failed, false);
  assert.equal(h.chats.lead(chatId), 'ag_ben');
  assert.deepEqual(h.lines(chatId, 'lead_changed').map((message) => message.body), ['Ben leads this chat now']);
  assert.equal((await h.run('ag_ava', 'chat.set_lead', { chatId, agentId: 'ag_cal' })).failed, true, 'Ava no longer leads');

  // Ava is still the creator, but external members go only by the lead.
  assert.match((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: [ext] })).text, /Only this chat's lead removes external members/);
  assert.equal((await h.run('ag_ava', 'chat.remove_members', { chatId, memberIds: ['ag_cal'] })).failed, false, 'agents still by the creator');
  assert.equal((await h.run('ag_ben', 'chat.remove_members', { chatId, memberIds: [ext] })).failed, false);
  assert.equal(h.active(chatId).includes(ext), false);
});

test('B-078 D7: the person is never added to a room – the refusal names my 1:1 with them and chat.create; nothing changes, nobody is told', async () => {
  const h = setup();
  const chatId = await h.room({ hidden: true });
  const first = h.of('conversation.upserted').find((chat) => chat.id === chatId)!;
  assert.equal(first.settings.hiddenFromList, true, 'hidden from its first event on');

  assert.match((await h.run('ag_ava', 'chat.add_members', { chatId, agentIds: ['ag_nobody'] })).text, /Unknown agent ag_nobody/);
  const refused = await h.run('ag_ava', 'chat.add_members', { chatId, agentIds: [HUMAN_ID] });
  assert.equal(refused.failed, true);
  assert.match(refused.text, /^Nothing was changed\. The person is not added to rooms: what they should know I tell them in my 1:1 with them/);
  assert.match(refused.text, /chat\.create/);
  const summary = h.chats.summary(chatId);
  assert.ok(!summary.members.some((member) => member.memberId === HUMAN_ID && !member.leftAt));
  assert.equal(summary.settings.hiddenFromList, true, 'the internal room stays internal');
  assert.equal(chatSection(summary), 'team');
  assert.deepEqual(h.lines(chatId, 'member_added'), []);
  assert.equal(h.notified.filter((item) => item.conversationId === chatId).length, 0, 'an internal room never pings the person');
});

test('rename: the lead or creator only, never over a name the person gave', async () => {
  const h = setup();
  const chatId = await h.room();
  assert.match((await h.run('ag_ben', 'chat.rename', { chatId, title: 'Mine' })).text, /Only this chat's lead or creator can rename it/);
  const renamed = await h.run('ag_ava', 'chat.rename', { chatId, title: 'Venue research' });
  assert.deepEqual(renamed.data, { ok: true, chatId, title: 'Venue research' });
  assert.equal(h.chats.get(chatId)?.settings.namedBy, 'ag_ava');
  assert.deepEqual(h.lines(chatId, 'renamed').map((message) => [message.body, message.authorId]), [['Renamed to Venue research', 'ag_ava']]);

  h.chats.update(chatId, { title: 'Offsite venues' }, HUMAN_ID);
  assert.equal(h.chats.get(chatId)?.settings.namedBy, HUMAN_ID);
  assert.match((await h.run('ag_ava', 'chat.rename', { chatId, title: 'Again' })).text, /The person named this chat/);
  assert.equal(h.chats.get(chatId)?.title, 'Offsite venues');

  const named = h.chats.create({ title: 'Q4 plan', agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  assert.equal((await h.run('ag_ava', 'chat.rename', { chatId: named.id, title: 'Plan' })).failed, true, 'a title the person gave at creation');
  const unnamed = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  assert.equal((await h.run('ag_ava', 'chat.rename', { chatId: unnamed.id, title: 'Tax return' })).failed, false, 'a generated title may be renamed');

  assert.equal(personNamed({ titleNamed: true, createdBy: 'ag_ava', settings: {} }), false);
  assert.equal(personNamed({ titleNamed: true, createdBy: HUMAN_ID, settings: { namedBy: 'ag_ava' } }), false, 'the latest rename decides');
});

test('app-owned chats keep their members, name and lead', async () => {
  const h = setup();
  // The old To-do chat as a pre-B-054 profile keeps it (an inert 'todo' system row; nothing creates one any more).
  const todo = h.chats.create({ title: 'To-do', agentIds: [], humans: true, createdBy: HUMAN_ID }).id;
  h.chats.update(todo, { settings: { hiddenFromList: true, system: 'todo' } }, HUMAN_ID);
  h.chats.setMembers(todo, { add: ['ag_ava'] }, HUMAN_ID);
  for (const [name, args] of [
    ['chat.add_members', { agentIds: ['ag_ben'] }], ['chat.remove_members', { memberIds: [HUMAN_ID] }],
    ['chat.rename', { title: 'Mine' }], ['chat.set_lead', { agentId: 'ag_ava' }],
  ] as const) {
    const out = await h.run('ag_ava', name, { chatId: todo, ...args });
    assert.match(out.text, /belongs to the app/, name);
  }
  assert.deepEqual(h.active(todo).sort(), [HUMAN_ID, 'ag_ava'].sort());
});
