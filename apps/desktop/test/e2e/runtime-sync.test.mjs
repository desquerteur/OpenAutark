// End-to-end (B-072, linked PCs share their work): two headless runtimes on this machine. B joins A as the CEO
// (Remote ID over loopback discovery, the person on A accepts) – then an agent, a task and a chat made on A reach
// B, and B's own untouched Manager steps back (one personal manager); the agent's home is B, so A's message wakes her
// on B only (fake engine) and her one answer shows on both. A PC that joins as an employee gets that person's chat
// with the CEO as 'owner', and the person's reply written there reaches the CEO's PC as hers.
// The link travels over the peer listeners' LAN/tailnet addresses of this machine (skipped without any).
// Run: npm run build && node --test test/e2e/runtime-sync.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const A_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.2,127.0.0.3' };
const B_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.3,127.0.0.2' };

async function until(read, ok, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const answersOf = (runtime, chatId, agentId) => runtime.client.call('messages.list', { conversationId: chatId })
  .then((list) => list.filter((message) => message.authorId === agentId && message.kind === 'text' && message.state === 'final'));

test('two linked runtimes share agents, tasks and chats; an agent runs on its home PC', { timeout: 300_000 }, async (t) => {
  const a = await startRuntime({ env: A_ENV });
  t.after(() => a.stop());
  const b = await startRuntime({ env: B_ENV });
  t.after(() => b.stop());
  const peer = await until(() => a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no LAN or tailnet address for the peer listener'); return; }

  const aId = (await a.client.call('remote.state')).self.deviceId;
  const bId = (await b.client.call('remote.state')).self.deviceId;
  await b.client.call('remote.connect', { target: (await a.client.call('remote.state')).self.remoteId });
  const incoming = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  await a.client.call('remote.decide', { id: incoming[0].id, accept: true });
  await until(() => a.client.call('devices.list').then((list) => list.find((device) => device.id === bId)?.status), (status) => status === 'online', 'A to list B online');
  await until(() => b.client.call('devices.list').then((list) => list.find((device) => device.id === aId)?.status), (status) => status === 'online', 'B to list A online');

  const started = Date.now();
  const mara = await a.client.call('agents.create', { name: 'Mara', role: 'Writer' });
  await a.client.call('agents.update', { id: mara.id, patch: { deviceId: bId } });
  await until(() => b.client.call('agents.list').then((list) => list.find((agent) => agent.id === mara.id)?.deviceId), (id) => id === bId, 'Mara on B, at home there');
  const managers = (runtime) => runtime.client.call('agents.list').then((list) => list.filter((agent) => !agent.archivedAt && (agent.template === 'manager' || agent.role === 'Personal manager')).length);
  for (const runtime of [b, a]) await until(() => managers(runtime), (n) => n === 1, 'one personal manager (B retired its own first-run Manager)');
  const task = await a.client.call('tasks.create', { title: 'Sync check' });
  await until(() => b.client.call('tasks.list').then((list) => list.some((item) => item.id === task.id)), Boolean, 'the task on B');
  t.diagnostic(`agent and task on B: ${Date.now() - started} ms`);

  const chat = await a.client.call('chats.create', { title: 'Sync', agentIds: [mara.id] });
  await a.client.call('messages.send', { conversationId: chat.id, body: 'Hello Mara' });
  // Changed rows gather for FLUSH_MS before they go, so the chat may not be on B yet.
  await until(() => b.client.call('messages.list', { conversationId: chat.id }).catch(() => []).then((list) => list.some((message) => message.body === 'Hello Mara')), Boolean, 'the message on B');
  const [answer] = await until(() => answersOf(a, chat.id, mara.id), (list) => list.length > 0, 'Mara\'s answer on A', 90_000);
  assert.match(answer.body, /Hello Mara/);
  t.diagnostic(`message on A → answer from B on A: ${Date.now() - started} ms`);

  await new Promise((resolve) => setTimeout(resolve, 3000)); // a second turn on A would show by now
  assert.equal((await answersOf(a, chat.id, mara.id)).length, 1, 'one answer: A ran no turn for her');
  assert.deepEqual((await answersOf(b, chat.id, mara.id)).map((message) => message.id), [answer.id], 'B wrote it');
});

test('an employee\'s PC gets her chat in her ids and her reply goes back to the CEO\'s PC as hers', { timeout: 300_000 }, async (t) => {
  const a = await startRuntime({ env: A_ENV });
  t.after(() => a.stop());
  const e = await startRuntime({ env: B_ENV });
  t.after(() => e.stop());
  const peer = await until(() => a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no LAN or tailnet address for the peer listener'); return; }

  const lena = await a.client.call('people.save', { name: 'Lena' });
  const eId = (await e.client.call('remote.state')).self.deviceId;
  await e.client.call('remote.connect', { target: (await a.client.call('remote.state')).self.remoteId, role: 'employee' });
  const incoming = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  await a.client.call('remote.decide', { id: incoming[0].id, accept: true, personId: lena.id });
  await until(() => a.client.call('devices.list').then((list) => list.find((device) => device.id === eId)?.status), (status) => status === 'online', 'A to list her PC online');

  const chat = await a.client.call('chats.create', { title: 'With Lena', agentIds: [], people: [lena.id] });
  await a.client.call('messages.send', { conversationId: chat.id, body: 'Hi Lena' });
  const down = await until(() => e.client.call('messages.list', { conversationId: chat.id }).catch(() => []), (list) => list.some((message) => message.body === 'Hi Lena'), 'the CEO\'s line on her PC');
  assert.equal(down.find((message) => message.body === 'Hi Lena').authorId, 'owner', 'the CEO is the owner there');

  await e.client.call('messages.send', { conversationId: chat.id, body: 'Hi, from my PC' });
  const back = await until(() => a.client.call('messages.list', { conversationId: chat.id }), (list) => list.some((message) => message.body === 'Hi, from my PC'), 'her line on the CEO\'s PC');
  assert.equal(back.find((message) => message.body === 'Hi, from my PC').authorId, lena.id, 'hers, not the CEO\'s');
});
