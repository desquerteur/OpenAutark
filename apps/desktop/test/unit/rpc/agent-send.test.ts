// AF-001 – messages.send from an agent's own wf (owner scope with `agentId`, set by the /ws handshake for a valid
// AUTARK_AGENT_TOKEN): the line is the agent's – author, kind and name – written through its chat.send tool, so it reaches
// only chats the agent is a member of and never wakes the agent itself; the person's fields (model, attachments …) are
// refused; while the agent has a turn running, the line belongs to that run. The plain owner still writes as the person.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from './s1-helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

function rig(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_lea', 'Lea'));
  const services = f.services as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of chatTools) registry.register(tool);
  services.tools = registry;
  const asAva: ClientScope = { kind: 'owner', agentId: 'ag_ava' };
  return { f, ava: new TestClient(f.server, asAva), owner: new TestClient(f.server, OWNER) };
}

test('an agent\'s wf: messages.send posts as that agent, with its name, and wakes nobody but the others', async (t) => {
  const { f, ava } = rig(t);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const sent = await ava.call<Message>('messages.send', { conversationId: chat.id, body: 'Report is ready: workspace/report.pdf', clientId: 'wf-1' });
  assert.equal(sent.authorId, 'ag_ava');
  assert.equal(sent.authorKind, 'agent');
  const stored = f.chats.message(sent.id)!;
  assert.deepEqual([stored.authorId, stored.authorKind, stored.body], ['ag_ava', 'agent', 'Report is ready: workspace/report.pdf']);
  assert.equal(f.org.get(stored.authorId)?.name, 'Ava', 'the line carries the agent\'s name');
  assert.equal(f.wakeRows().filter((row) => row.agent_id === 'ag_ava').length, 0, 'its own line never wakes the agent again');

  const group = f.chats.create({ agentIds: ['ag_ava', 'ag_lea'], createdBy: 'human' });
  await ava.call<Message>('messages.send', { conversationId: group.id, body: '@Lea can you check page 3?', mentions: ['ag_lea'] });
  assert.ok(f.wakeRows().some((row) => row.agent_id === 'ag_lea'), 'a colleague it mentions is woken as by chat.send');
});

test('an agent\'s wf: only into its own chats; the person\'s fields are refused; levels map onto chat.send', async (t) => {
  const { f, ava } = rig(t);
  const other = f.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  const outside = await ava.request('messages.send', { conversationId: other.id, body: 'Hello there' });
  assert.equal(outside.error?.code, 'forbidden', 'a chat the agent is no member of');
  assert.equal(f.chats.messages(other.id).filter((message) => message.kind !== 'status').length, 0, 'nothing posted there');

  const own = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  for (const key of ['model', 'pin', 'attachments', 'speech', 'secrets', 'ultra', 'effort']) {
    const refused = await ava.request('messages.send', { conversationId: own.id, body: 'x', [key]: key === 'attachments' ? [] : 'x' });
    assert.equal(refused.error?.code, 'bad_request', `${key} is the person's`);
  }
  const quiet = await ava.call<Message>('messages.send', { conversationId: own.id, body: 'For later', silent: true });
  assert.equal(f.chats.message(quiet.id)!.silent, true);
  const both = await ava.request('messages.send', { conversationId: own.id, body: 'x', silent: true, priority: 'important' });
  assert.equal(both.error?.code, 'bad_request');
});

test('an agent\'s wf during its running turn: the line belongs to that run', async (t) => {
  const { f, ava } = rig(t);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const run = f.services.runs.start({ id: 'run_ava_1', agentId: 'ag_ava', conversationId: chat.id, trigger: 'message' } as never);
  f.dispatcher.active.push({ agentId: 'ag_ava', runId: run.id, conversationId: chat.id, note: 'Working', startedAt: 0 });
  const sent = await ava.call<Message>('messages.send', { conversationId: chat.id, body: 'Halfway there.' });
  const stored = f.chats.message(sent.id)!;
  assert.equal(stored.runId, run.id);
  assert.equal(stored.meta?.sentDuringRun, true);
});

test('the plain owner (the window, the person\'s own wf) still writes as the person', async (t) => {
  const { f, owner } = rig(t);
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const sent = await owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Thanks!' });
  assert.deepEqual([sent.authorId, sent.authorKind], ['human', 'human']);
  assert.ok(f.wakeRows().some((row) => row.agent_id === 'ag_ava'), 'the person\'s line wakes the agent as before');
});
