// End-to-end flows over the real headless runtime (demo engine, temp profile):
//  1. Agents may do everything (Umbau Einfachheit): an agent's command runs at once – no approval to-do.
//  2. Phone access: a pairing link is exchanged for a device token; the device sees the To-do
//     list and, on a secure transport, the accounts (B-078), but not the PC's own pairing link; removing the device in Settings › Devices (devices.revoke) locks it out (B-078 D5: no Phone access switch).
//  2b. One tier: a paired phone manages agents, chats and appearance and answers a secret form field (PM6: the PC
//     stores the value, the agent gets a handle).
//  3. Restart: chats, tasks and agents survive a runtime restart on the same data dir.
// Run: npm run build && node --test test/e2e/runtime-flows.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, startRuntime } from './lib/runtime-client.mjs';

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

/** Pairs a phone over the real HTTP pairing route; returns its token and device id. */
async function pair(runtime, name) {
  const link = await runtime.client.call('pwa.link', { name });
  const secret = decodeURIComponent(new URL(link.url).hash.match(/pair=([^&]+)/)?.[1] ?? '');
  const exchange = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret, name } }),
  }).then((response) => response.json());
  assert.ok(exchange.result?.token, `${name}: the secret is exchanged for a device token`);
  return exchange.result;
}

const refused = (promise) => assert.rejects(promise, (error) => error.code === 'forbidden');
/** The close a removed device gets (4403 removed; 4401 when the token itself is unknown). */
const REMOVED = /connection closed \(440[13]\)/;

async function managerChat(client, title) {
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title, agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', `chat:${chat.id}`] });
  return { manager, chat };
}

test('agents may do everything: a command runs at once, no approval to-do', { timeout: 180_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const { manager, chat } = await managerChat(client, 'No approvals');

  await client.call('messages.send', { conversationId: chat.id, body: 'Run it [[tool:shell.exec {"command":"echo approved-run"}]]' });
  const reply = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /shell\.exec/), 90_000);
  assert.match(reply.body, /approved-run/, 'the command ran at once');
  const approvals = (await client.call('todos.list')).filter((task) => task.widget?.type === 'approve' && task.createdBy === 'system');
  assert.deepEqual(approvals, [], 'no binding approval card');
});

test('phone access: device token sees the To-do list and accounts, not owner-only methods; removing the device locks it out', { timeout: 120_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const link = await client.call('pwa.link', { name: 'Test phone' });
  const secret = new URL(link.url).hash.match(/pair=([^&]+)/)?.[1];
  assert.ok(secret, 'the link carries a one-time pairing secret in the fragment');

  const exchange = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret: decodeURIComponent(secret), name: 'Test phone' } }),
  }).then((response) => response.json());
  assert.ok(exchange.result?.token, 'the secret is exchanged for a device token');

  await client.call('todos.add', { text: 'Sign the delivery note' });
  const phone = await connect(runtime.port, exchange.result.token, 'pwa');
  t.after(() => phone.close());
  const todos = await phone.call('todos.list');
  assert.ok(todos.some((item) => item.title.includes('Sign the delivery note')), 'the phone sees the To-do list');
  assert.ok(Array.isArray(await phone.call('accounts.list')), 'B-078: accounts reach a phone on a secure transport (loopback)');
  await refused(phone.call('pwa.link', { name: 'Another phone' }));

  // Removing the device in Settings › Devices (the RPC that removes its row) locks it out immediately.
  await client.call('devices.revoke', { id: exchange.result.deviceId });
  assert.equal((await client.call('devices.list')).some((device) => device.id === exchange.result.deviceId && device.status !== 'revoked'), false, 'the row is gone or marked revoked');
  await assert.rejects(phone.call('todos.list'), REMOVED, 'the open socket closes as removed');
  await assert.rejects(connect(runtime.port, exchange.result.token, 'pwa').then((again) => again.call('todos.list')), REMOVED, 'a new connection is refused');
});

test('one tier: a paired phone manages agents and chats and answers a secret form field', { timeout: 120_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const pairing = await pair(runtime, 'Phone');
  const full = await connect(runtime.port, pairing.token, 'pwa');
  t.after(() => full.close());

  // session.info mirrors the server's rules (loopback counts as a secure transport).
  const info = await full.call('session.info');
  assert.equal(info.kind, 'device');
  for (const capability of ['todo', 'chat', 'tasks', 'settings', 'manage']) assert.ok(info.capabilities.includes(capability), `${capability}: ${info.capabilities.join(', ')}`);
  assert.equal(info.secure, true);
  assert.ok(info.allowedMethods.includes('agents.create'));

  // Hire, chat, rename, models/usage/modes/knowledge reads, appearance.
  assert.ok((await full.call('agents.templates')).length > 0, 'templates reach the phone');
  const hired = await full.call('agents.create', { name: 'Phone Hire' });
  assert.equal(hired.name, 'Phone Hire');
  const chat = await full.call('chats.create', { title: 'From the phone', agentIds: [hired.id] });
  assert.equal((await full.call('chats.update', { id: chat.id, title: 'Renamed on the phone' })).title, 'Renamed on the phone');
  assert.ok(Array.isArray(await full.call('models.list')));
  assert.ok(Array.isArray(await full.call('usage.list')));
  assert.ok((await full.call('modes.list')).length > 0, 'modes reach the phone');
  assert.ok(Array.isArray(await full.call('skills.list')));
  assert.ok(Array.isArray((await full.call('knowledge.list', {})).items));
  assert.equal((await full.call('settings.update', { preferences: { theme: 'dark' } })).preferences.theme, 'dark');
  assert.ok(Array.isArray(await full.call('accounts.list')), 'B-078: accounts reach the phone on a secure transport');
  await refused(full.call('pwa.link', { name: 'Another phone' }));
  await full.call('ui.saveDraft', { conversationId: chat.id, text: 'Half a thought' });
  assert.equal((await full.call('ui.state')).drafts[chat.id], 'Half a thought');

  // PM6: an agent asks for a login in a form; the phone types the secret (loopback is a secure transport). The PC
  // stores it in the catalog for every agent, saved from the domain (29.10.2026: no binding); only the handle reaches
  // the to-do, the chat and the agent.
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  const form = { type: 'form', title: 'Shop login', fields: [{ name: 'user', label: 'User' }, { name: 'password', label: 'Password', kind: 'secret', domain: 'login.shop.example', required: true }] };
  await client.call('messages.send', { conversationId: chat.id, body: `Ask me for the login [[ui:${JSON.stringify(form)}]]` });
  await client.waitFor('message.updated', finalFrom(chat.id, hired.id, /```ui/), 60_000);
  let ask;
  for (let i = 0; i < 40 && !ask; i++) {
    ask = (await full.call('todos.list')).find((item) => item.widget?.type === 'form' && item.widget.title === 'Shop login');
    if (!ask) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ask, 'the form reaches the phone\'s list');
  await full.call('tasks.complete', { id: ask.id, answer: { values: { user: 'ada', password: 'Phone-typed-Secret-42' } } });
  const stored = (await client.call('secrets.list')).find((entry) => entry.label === 'Shop login · Password');
  assert.ok(stored, 'stored in the vault');
  const done = await client.call('tasks.get', { id: ask.id });
  assert.equal(done.status, 'done');
  assert.ok(JSON.stringify(done).includes(`secret://${stored.id}`), 'the to-do keeps the handle');
  const seen = JSON.stringify([done, await client.call('messages.list', { conversationId: chat.id })]);
  assert.ok(!seen.includes('Phone-typed-Secret-42'), 'the value is nowhere in the to-do or the chat');

  // Removing the device in Settings › Devices locks it out at once.
  await client.call('devices.revoke', { id: pairing.deviceId });
  await assert.rejects(full.call('todos.list'), REMOVED, 'the open socket closes as removed');
  await assert.rejects(connect(runtime.port, pairing.token, 'pwa').then((socket) => socket.call('todos.list')), REMOVED, 'a new connection is refused');
});

test('restart keeps chats, tasks and agents', { timeout: 120_000 }, async (t) => {
  const first = await startRuntime({ keepData: true });
  const { client } = first;
  const { manager, chat } = await managerChat(client, 'Persistence');
  await client.call('messages.send', { conversationId: chat.id, body: 'Note [[tool:tasks.create {"title":"Survives restart"}]]' });
  const task = await client.waitFor('task.upserted', (item) => item.title === 'Survives restart', 90_000);
  await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /tasks\.create/), 90_000);
  await first.stop();

  const second = await startRuntime({ dataDir: first.dataDir });
  t.after(() => second.stop());
  const chats = await second.client.call('chats.list');
  assert.ok(chats.some((item) => item.id === chat.id), 'the chat is still there');
  const tasks = await second.client.call('tasks.list', { conversationId: chat.id });
  assert.ok(tasks.some((item) => item.id === task.id), 'the task is still there');
  const agents = await second.client.call('agents.list');
  assert.equal(agents.filter((agent) => agent.template === 'manager').length, 1, 'no second manager is seeded');
});
