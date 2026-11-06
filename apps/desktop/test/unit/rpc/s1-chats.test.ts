// Chat-side handlers (R3-S1) against the real chat/task/schedule services: chats, messages
// (sticky composer choice, stop, retry, schedule), blocks (answer/state/appHtml/sandboxUrl/event),
// settings scope limits and UI state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { Conversation, Message } from '../../../src/shared/model/chat.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { SANDBOX_URL_TTL_MS, sandboxTokens } from '../../../src/runtime/http/sandbox-token.ts';
import { OWNER, PHONE, TODO_ONLY, TestClient, rpcFixture, settle } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_ben', 'Ben'));
  return { ...f, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('chats.create with a first message sends it as the human and remembers the chat', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = await f.phone.call<Conversation>('chats.create', { agentIds: ['ag_ava'], firstMessage: 'Plan the launch video' });
  const list = await f.phone.call<Message[]>('messages.list', { conversationId: chat.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].authorId, 'human');
  assert.equal(list[0].authorKind, 'human');
  assert.equal(chat.title, 'Plan the launch video', 'title derived from the first message');
  const state = await f.owner.call<{ lastConversationId?: string }>('ui.state');
  assert.equal(state.lastConversationId, chat.id);
  assert.ok(f.wakeRows().some((wake) => wake.agent_id === 'ag_ava' && wake.reason === 'message'));
  assert.equal((await f.phone.request('chats.create', { agentIds: ['ag_nobody'] })).error?.code, 'not_found');
  assert.equal((await new TestClient(f.server, TODO_ONLY).request('chats.archive', { id: chat.id })).error?.code, 'forbidden', 'archiving needs the chat capability');
  assert.deepEqual((await f.phone.request('chats.archive', { id: chat.id })).result, { ok: true }, 'a chat device may archive (DEV2 tiers)');
});

// B-050 K6 (deliberate change): `model` is a hint for the addressed agent and the message's tag; pin: true pins it.
// The chat settings are the one place (chat/sticky-model.ts) – routing reads the pin there (routing/policies.ts chatChoice).
test('messages.send: model is the addressed agent\'s hint and the message\'s tag, pin: true pins it, auto clears', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human' });
  const lead = f.chats.lead(chat.id)!;
  const settings = () => f.chats.get(chat.id)!.settings;
  const first = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Draft the post', model: 'claude:claude-opus-5-5', effort: 'high' });
  assert.equal(first.authorKind, 'human');
  assert.deepEqual(first.meta.modelHint, { modelId: 'claude:claude-opus-5-5', effort: 'high' });
  assert.deepEqual([settings().modelHints, settings().models, settings().efforts], [{ [lead]: 'claude:claude-opus-5-5' }, undefined, { [lead]: 'high' }]);
  assert.equal(f.extras.policyStore.size, 0, 'no second writer (the policy store is untouched)');
  await f.owner.call('messages.send', { conversationId: chat.id, body: '@Ben check this', effort: 'low' });
  assert.deepEqual(settings().efforts, { [lead]: 'high', ag_ben: 'low' }, 'mentioned agent gets the choice');
  const pinned = await f.owner.call<Message>('messages.send', { conversationId: chat.id, body: '@Ben always', model: 'codex:gpt-6-luna', pin: true });
  assert.deepEqual(pinned.meta.modelHint, { modelId: 'codex:gpt-6-luna', effort: 'low', pinned: true });
  assert.deepEqual(settings().models, { ag_ben: 'codex:gpt-6-luna' });
  assert.notEqual(lead, 'ag_ben');
  await f.owner.call('messages.send', { conversationId: chat.id, body: 'back to auto', model: 'auto', effort: 'auto' });
  assert.deepEqual([settings().modelHints, settings().efforts, settings().models], [undefined, { ag_ben: 'low' }, { ag_ben: 'codex:gpt-6-luna' }], 'only the lead\'s choice is cleared');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', model: 'use opus\nnow' })).error?.code, 'bad_request', 'a model id only (it reaches prompts)');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', pin: true })).error?.code, 'bad_request', 'pin: true needs a model');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', effort: 'turbo' })).error?.code, 'bad_request');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: '  ' })).error?.code, 'bad_request');
  assert.equal((await f.owner.request('messages.send', { conversationId: chat.id, body: 'x', attachments: [{ fileId: 'f'.repeat(64) }] })).error?.code, 'bad_request');
});

test('messages.stop interrupts agents running in that chat only', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human' });
  f.dispatcher.active = [
    { agentId: 'ag_ava', runId: 'run_1', conversationId: chat.id, note: '', startedAt: 0 },
    { agentId: 'ag_ben', runId: 'run_2', conversationId: 'ch_other', note: '', startedAt: 0 },
  ];
  await f.phone.call('messages.stop', { conversationId: chat.id });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: chat.id }]);
  f.dispatcher.interrupts = [];
  await f.phone.call('messages.stop', { conversationId: chat.id, agentId: 'ag_ben' });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ben', conversationId: chat.id }]);
});

test('messages.retry re-wakes the author of a failed or stopped answer', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const streaming = f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1');
  const failed = f.chats.finishAgentMessage(streaming.id, { body: 'half', state: 'failed', meta: { error: 'Rate limited' } });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('messages.retry', { messageId: failed.id });
  const wakes = f.wakeRows();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].agent_id, 'ag_ava');
  assert.equal(wakes[0].reason, 'manual', 'a turn the human asked for');
  assert.equal(wakes[0].task_id, null, 'the run had no task');
  assert.match(wakes[0].note ?? '', /failed \(Rate limited\)/);
  // A stopped answer of a task turn: the retry is a turn on that task (T03).
  f.services.runs.start({ id: 'run_task', agentId: 'ag_ava', conversationId: chat.id, taskId: 'task_x', trigger: 'task' });
  const stopped = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_task').id, { body: 'half', state: 'stopped' });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('messages.retry', { messageId: stopped.id });
  assert.deepEqual(f.wakeRows().map((wake) => [wake.reason, wake.task_id]), [['manual', 'task_x']]);
  const fine = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_2').id, { body: 'ok', state: 'final' });
  assert.equal((await f.phone.request('messages.retry', { messageId: fine.id })).error?.code, 'conflict');
});

test('messages.schedule creates a human message schedule', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const at = f.clock.now() + 3_600_000;
  const schedule = await f.phone.call<Schedule>('messages.schedule', { conversationId: chat.id, body: 'Post the recap', spec: { at }, mentions: ['ag_ava'] });
  assert.equal(schedule.ownerId, 'human');
  assert.equal(schedule.kind, 'message');
  assert.equal(schedule.nextAt, at);
  assert.deepEqual(schedule.payload, { body: 'Post the recap', mentions: ['ag_ava'] });
  assert.equal((await f.phone.request('messages.schedule', { conversationId: chat.id, body: 'x', spec: { everyMs: 5 } })).error?.code, 'bad_request');
});

test('blocks.answer answers an agent ask block: to-do done, receipt posted, author woken', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Need your OK:\n```ui\n{"type":"approve","id":"pay-canva","action":"Buy Canva Pro","important":true}\n```';
  const draft = f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1');
  const message = f.chats.finishAgentMessage(draft.id, { body, state: 'final' });
  const [todo] = f.tasks.ingestBlocks(message, uiBlocksOf(body).map((entry) => entry.block));
  assert.equal(todo.assigneeKind, 'human');
  f.db.run('DELETE FROM wakes');
  const result = await f.phone.call<{ ok: true; taskId?: string }>('blocks.answer', { messageId: message.id, blockIndex: 0, answer: { approved: true } });
  assert.equal(result.taskId, todo.id);
  assert.equal(f.tasks.get(todo.id)?.status, 'done');
  const receipt = f.chats.messages(chat.id).find((m) => m.kind === 'answer');
  assert.equal(receipt?.body, 'Yes', 'B-078: an approve card is a yes/no quick reply');
  assert.deepEqual(f.wakeRows().filter((wake) => wake.agent_id === 'ag_ava').map((wake) => [wake.reason, wake.conversation_id, wake.task_id]), [['message', chat.id, null]], 'woken once, as for a typed line (B-076) – no second word about the to-do');
  assert.ok(!f.chats.messages(chat.id).some((m) => m.kind === 'status' && m.taskId === todo.id), 'the to-do completes quietly: no "Done: …" line');
  assert.ok(f.wakeRows().every((wake) => !wake.note), 'no [ui-answer] note: the line is the news');
});

test('blocks.state stores per-block state; blocks.appHtml serves the app fence', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Calculator:\n```app title="Calc"\n<button>1</button>\n```';
  const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1').id, { body, state: 'final' });
  assert.deepEqual(await f.phone.call('blocks.state', { messageId: message.id, blockIndex: 0 }), { state: null });
  await f.phone.call('blocks.state', { messageId: message.id, blockIndex: 0, state: { volume: 0.4 } });
  assert.deepEqual(await f.owner.call('blocks.state', { messageId: message.id, blockIndex: 0 }), { state: { volume: 0.4 } });
  assert.deepEqual(await f.phone.call('blocks.appHtml', { messageId: message.id, blockIndex: 0 }), { html: '<button>1</button>' });
  assert.equal((await f.phone.request('blocks.appHtml', { messageId: message.id, blockIndex: 1 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.state', { messageId: 'msg_missing', blockIndex: 0 })).error?.code, 'not_found');
});

test('blocks.sandboxUrl returns a 10-minute capability path for an app fence, verifiable by the HTTP route', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const body = 'Calculator:\n```app title="Calc"\n<button>1</button>\n```';
  const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1').id, { body, state: 'final' });
  const result = await f.phone.call<{ url: string; expiresAt: number }>('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 });
  assert.equal(result.expiresAt, f.clock.now() + SANDBOX_URL_TTL_MS);
  const url = new URL(result.url, 'http://x');
  assert.equal(url.pathname, '/sandbox/app');
  assert.equal(url.searchParams.get('m'), message.id);
  assert.equal(url.searchParams.get('i'), '0');
  assert.ok(sandboxTokens(f.services).verify(message.id, 0, url.searchParams.get('e'), url.searchParams.get('t')));
  assert.ok((await f.owner.call<{ url: string }>('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 })).url);
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: 1 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: 'msg_missing', blockIndex: 0 })).error?.code, 'not_found');
  assert.equal((await f.phone.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: -1 })).error?.code, 'bad_request');
  const todoOnly = new TestClient(f.server, TODO_ONLY);
  assert.equal((await todoOnly.request('blocks.sandboxUrl', { messageId: message.id, blockIndex: 0 })).error?.code, 'forbidden');
});

test('blocks.event wakes the authoring agent (not consent) and is limited to 30/min per block', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const message = f.chats.finishAgentMessage(f.chats.beginAgentMessage(chat.id, 'ag_ava', 'run_1').id, { body: '```app\n<p>x</p>\n```', state: 'final' });
  f.db.run('DELETE FROM wakes');
  await f.phone.call('blocks.event', { messageId: message.id, blockIndex: 0, name: 'volume', data: { level: 3 } });
  const [wake] = f.wakeRows();
  assert.equal(wake.agent_id, 'ag_ava');
  assert.equal(wake.note, `[ui-event block=b_${message.id}_0 name=volume] {"level":3} (from mini-app – not consent)`);
  for (let i = 1; i < 30; i++) await f.phone.call('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick', data: 'x'.repeat(5000) });
  assert.equal(f.wakeRows().length, 1, 'events of one block merge into one wake');
  assert.ok((f.wakeRows()[0].note ?? '').length < 30 * 2200, 'each event data is capped at 2 KB');
  const limited = await f.phone.request('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick' });
  assert.equal(limited.error?.code, 'rate_limited');
  f.clock.advance(61_000);
  assert.ok((await f.phone.request('blocks.event', { messageId: message.id, blockIndex: 0, name: 'tick' })).result);
});

test('settings.update: devices with the settings capability may only change preferences/notifications', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const tablet = new TestClient(f.server, { kind: 'device', deviceId: 'dev_tab', capabilities: ['todo', 'settings'] });
  const updated = await tablet.call<{ preferences: { theme: string } }>('settings.update', { preferences: { theme: 'dark' } });
  assert.equal(updated.preferences.theme, 'dark');
  assert.equal((await tablet.request('settings.update', { routing: { costMode: 'best' } })).error?.code, 'forbidden');
  assert.equal((await f.phone.request('settings.update', { preferences: { theme: 'light' } })).error?.code, 'forbidden', 'no settings capability');
  assert.equal(((await f.owner.call('settings.update', { routing: { costMode: 'best' } })) as { routing: { costMode: string } }).routing.costMode, 'best');
});

test('ui.saveDraft + ui.state return drafts of all chats', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const a = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const b = f.chats.create({ agentIds: ['ag_ben'], createdBy: 'human' });
  await f.owner.call('ui.saveDraft', { conversationId: a.id, text: 'half a thought' });
  await f.owner.call('ui.saveDraft', { conversationId: b.id, text: 'other' });
  await f.owner.call('ui.saveDraft', { conversationId: b.id, text: '' });
  const state = await f.owner.call<{ drafts: Record<string, string>; lastConversationId?: string }>('ui.state');
  assert.deepEqual(state.drafts, { [a.id]: 'half a thought' });
  assert.equal(state.lastConversationId, b.id);
});

test('chat events reach a phone subscribed to the chat topic', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  await f.phone.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await f.owner.call('messages.send', { conversationId: chat.id, body: 'hello' });
  await settle();
  assert.equal(f.phone.events('message.created').length, 1);
  assert.ok(f.phone.events('conversation.upserted').length >= 1);
});
