// DEV2 device tiers against the real chat service and RPC server: what a chat-capable phone may
// change in a chat, own-message edits, agent edits, the event side of the tiers (providers, runs,
// settings, notifications, feedback/knowledge/theme), a To-do link seeing no chat content and
// closing the live connections of a revoked device. (Paired phones get every tier but
// 'permissions' since B5; the tiers stay the table's vocabulary.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { maySubscribe, mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import { topicOf } from '../../../src/shared/api/events.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { OWNER, TestClient, rpcFixture, settle } from './s1-helpers.ts';

const FULL: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage'];
const device = (capabilities: DeviceCapability[], secure = true, deviceId = 'dev_tier'): ClientScope => ({ kind: 'device', deviceId, capabilities, secure });

function setup() {
  const f = rpcFixture({ table: createHandlerTable() });
  f.org.add(agent('ag_ava', 'Ava'));
  const updates: Array<{ id: string; patch: Partial<Agent> }> = [];
  Object.assign(f.org, { update: (id: string, patch: Partial<Agent>) => { updates.push({ id, patch }); return { ...f.org.require(id), ...patch }; } });
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  return { ...f, chat, updates };
}

test("a device edits and deletes only the human's messages; nobody rewrites an agent's message (C6)", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const phone = new TestClient(f.server, device(['chat']));
  const mine = f.chats.send({ conversationId: f.chat.id, body: 'Draft', authorId: 'human', authorKind: 'human' });
  const theirs = f.chats.send({ conversationId: f.chat.id, body: 'Agent answer', authorId: 'ag_ava', authorKind: 'agent' });
  assert.equal((await phone.call<{ body: string }>('messages.edit', { id: mine.id, body: 'Draft v2' })).body, 'Draft v2');
  assert.equal((await phone.request('messages.edit', { id: theirs.id, body: 'rewritten' })).error?.code, 'forbidden');
  assert.equal((await phone.request('messages.delete', { id: theirs.id })).error?.code, 'forbidden');
  assert.equal(f.chats.message(theirs.id)?.body, 'Agent answer');
  assert.equal((await phone.request('messages.edit', { id: 'msg_missing0001', body: 'x' })).error?.code, 'not_found');
  assert.deepEqual(await phone.call('messages.delete', { id: mine.id }), { ok: true });
  assert.equal(f.chats.message(mine.id), undefined);
  const owner = new TestClient(f.server, OWNER);
  assert.equal((await owner.request('messages.edit', { id: theirs.id, body: 'fixed typo' })).error?.code, 'forbidden'); // C6: an agent's answer stays what it said
  assert.equal(f.chats.message(theirs.id)?.body, 'Agent answer');
});

test('manage edits agents; a chat-only device does not; there are no permission or budget fields', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const full = new TestClient(f.server, device(FULL));
  await full.call('agents.update', { id: 'ag_ava', patch: { name: 'Ava Lee', role: 'Editor' } });
  await full.call('agents.update', { id: 'ag_ava', patch: { team: 'Ops' } });
  assert.deepEqual(f.updates.map((entry) => entry.patch), [{ name: 'Ava Lee', role: 'Editor' }, { team: 'Ops' }]);
  assert.equal((await full.request('agents.update', { id: 'ag_ava', patch: { permissions: { shell: true } } })).error?.code, 'bad_request');
  assert.equal((await full.request('agents.update', { id: 'ag_ava', patch: { budget: { monthlyUsd: 5 } } })).error?.code, 'bad_request');
  assert.equal((await new TestClient(f.server, device(['todo', 'chat'])).request('agents.update', { id: 'ag_ava', patch: { name: 'X' } })).error?.code, 'forbidden');
});

test('events per tier: provider usage/models and feedback/knowledge for chat, run insight for manage, settings for settings/permissions, theme for all', () => {
  const chat = device(['todo', 'chat']);
  assert.ok(maySubscribe(chat, 'providers'));
  assert.ok(mayReceive(chat, 'providers', 'usage.updated') && mayReceive(chat, 'providers', 'models.updated'));
  assert.ok(!mayReceive(chat, 'providers', 'account.upserted') && !mayReceive(chat, 'providers', 'account.removed'));
  assert.ok(!maySubscribe(device(['todo']), 'providers'));
  assert.ok(!maySubscribe(chat, 'runs:ag_ava'));
  assert.ok(maySubscribe(device(['manage']), 'runs:ag_ava') && mayReceive(device(['manage']), 'runs:ag_ava', 'run.item'));
  assert.ok(!mayReceive(chat, 'system', 'settings.updated'));
  assert.ok(mayReceive(device(['settings']), 'system', 'settings.updated'));
  assert.ok(mayReceive(device(['permissions'], true), 'system', 'settings.updated'));
  assert.ok(!mayReceive(device(['permissions'], false), 'system', 'settings.updated'));
  assert.ok(!mayReceive(device([...FULL, 'permissions']), 'system', 'device.upserted'));
  assert.ok(mayReceive(device(['todo']), 'system', 'notify', { kind: 'todo' }) && mayReceive(device(['todo']), 'system', 'notify', { kind: 'blocker' }));
  for (const kind of ['reply', 'important', 'done', 'info', undefined]) assert.ok(!mayReceive(device(['todo', 'tasks']), 'system', 'notify', { kind }), String(kind));
  assert.ok(!mayReceive(device(['todo']), 'system', 'notify'), 'no payload: fail closed');
  assert.ok(mayReceive(chat, 'system', 'notify', { kind: 'reply' }));
  assert.ok(!mayReceive(device([...FULL, 'permissions']), 'system', 'pwa.updated'), 'phone access state stays with the owner (like pwa.state)');
  assert.ok(mayReceive(device(['todo'], false), 'system', 'theme.updated'), 'theme.get is open to every device');
  for (const event of ['feedback.upserted', 'knowledge.upserted', 'knowledge.removed'] as const) {
    assert.ok(mayReceive(chat, 'system', event), event);
    assert.ok(!mayReceive(device(['todo', 'tasks', 'settings', 'manage']), 'system', event), event);
  }
});

test('a To-do link sees no chat content: no drafts, only For-you notifications, no phone-access state', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const owner = new TestClient(f.server, OWNER);
  await owner.call('ui.saveDraft', { conversationId: f.chat.id, text: 'half a secret plan' });
  const todo = new TestClient(f.server, device(['todo']));
  const phone = new TestClient(f.server, device(['todo', 'chat']));
  assert.deepEqual(await todo.call('ui.state'), { drafts: {} });
  assert.deepEqual((await phone.call<{ drafts: Record<string, string> }>('ui.state')).drafts, { [f.chat.id]: 'half a secret plan' });
  for (const client of [owner, todo, phone]) await client.call('events.subscribe', { topics: ['system', 'tasks'] });
  for (const kind of ['reply', 'important', 'done', 'info', 'todo', 'blocker'] as const) {
    f.bus.emit('notify', { kind, title: `${kind} title`, body: `${kind} body`, conversationId: f.chat.id });
  }
  f.bus.emit('pwa.updated', { enabled: true, urls: ['http://192.168.1.5:47811'], secure: false, devices: [], pushReady: false });
  await settle();
  const kinds = (client: TestClient) => client.events('notify').map((e) => (e.data as { kind: string }).kind);
  assert.deepEqual(kinds(todo), ['todo', 'blocker']);
  assert.deepEqual(kinds(phone), ['reply', 'important', 'done', 'info', 'todo', 'blocker']);
  assert.equal(owner.events('pwa.updated').length, 1);
  assert.equal(todo.events('pwa.updated').length + phone.events('pwa.updated').length, 0);
});

test('a revoked device loses its live connections at once; other devices and the owner stay', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const phone = new TestClient(f.server, device(FULL, true, 'dev_phone_a'));
  const other = new TestClient(f.server, device(FULL, true, 'dev_phone_b'));
  const owner = new TestClient(f.server, OWNER);
  f.bus.emit('device.upserted', { id: 'dev_phone_a', status: 'online' } as never);
  await settle();
  assert.equal(phone.raw.closed, false, 'a live device keeps its connection');
  f.bus.emit('device.upserted', { id: 'dev_phone_a', status: 'revoked', revokedAt: 1 } as never);
  await settle();
  assert.equal(phone.raw.closed, true);
  assert.equal(other.raw.closed, false);
  f.bus.emit('device.removed', { id: 'dev_phone_b' });
  await settle();
  assert.equal(other.raw.closed, true);
  assert.ok((await owner.call<{ kind: string }>('session.info')).kind === 'owner', 'owner connections stay');
});
