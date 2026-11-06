// End-to-end (F-52): people of the organisation over the real headless runtime (demo engine, temp
// profile) and the real WebSocket RPC. The owner adds Anna and invites her; her browser asks with
// the invite ticket (tokenless POST /rpc people.join), the owner allows it on the host-written
// to-do, the page collects a person token (people.awaitJoin) and connects to /ws as a person. She
// sees only her chats (from her perspective: she is "human", the CEO "owner"), talks with an agent
// that answers her, starts a chat without the CEO (the admin sees it as hers), gets a task
// on her For you that she finishes, gets changed rights at once (her live connection closes and
// the next one carries them), and loses her live connection the moment the owner removes her – the
// same token is then refused with 4403.
// Run: npm run build && node --test test/e2e/runtime-people.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { connect, startRuntime, waitForNew } from './lib/runtime-client.mjs';

async function postRpc(port, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) });
  const frame = await response.json();
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return frame.result;
}

/** Opens /ws with `token` and resolves with the close code. */
async function closeCode(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send(JSON.stringify({ protocol: 1, token, client: 'pwa' }));
  return closed;
}

async function until(read, ok, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('a person joins by invite, works with an agent and the owner, and is cut off on revoke', { timeout: 240_000 }, async (t) => {
  const live = await startRuntime();
  t.after(() => live.stop());
  const owner = live.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'localhost' }); // people connect like phones
  const manager = (await owner.call('agents.list'))[0];
  assert.ok(manager, 'the first agent');

  // 1. Invite and join.
  // The owner picks what she works with (a new person works with no space's agents by default).
  const anna = await owner.call('people.save', { name: 'Anna Berg', title: 'Designer', scopes: { spaces: 'all', startChats: true, assignAgents: true } });
  const invite = await owner.call('people.invite', { id: anna.id });
  const ticket = invite.url.split('#join=')[1];
  assert.ok(ticket, invite.url);
  const asked = await postRpc(live.port, 'people.join', { ticket, name: 'Android · Chrome' });
  const todo = await until(() => owner.call('todos.list').then((list) => list.find((entry) => entry.title === 'Let Android · Chrome join as Anna Berg · Designer?')), Boolean, 'the decision to-do');
  assert.equal(todo.createdBy, 'system');
  await owner.call('tasks.complete', { id: todo.id, answer: { choice: 'Allow' } });
  const joined = await postRpc(live.port, 'people.awaitJoin', { ticket: asked.ticket });
  assert.equal(joined.status, 'accepted', JSON.stringify(joined));
  await assert.rejects(postRpc(live.port, 'people.join', { ticket }), /no longer valid/);

  const person = await connect(live.port, joined.token, 'pwa');
  const info = await person.call('session.info');
  assert.equal(info.kind, 'person');
  assert.equal(info.person.name, 'Anna Berg');
  await assert.rejects(person.call('people.save', { name: 'Eve' }), /not allowed/);
  await assert.rejects(person.call('accounts.list'), /not allowed/);
  const settings = await person.call('settings.get');
  assert.equal(settings.profile.name, 'Anna Berg', 'her app reads her own name');
  assert.equal(settings.permissions, undefined, 'no permission setup any more');

  // 2. A shared chat with the agent: only her chats, from her side; the agent answers her.
  const shared = await owner.call('chats.create', { title: 'Launch', agentIds: [manager.id], people: [anna.id] });
  const own = await owner.call('chats.create', { title: 'Owner only', agentIds: [manager.id] });
  const list = await person.call('chats.list');
  assert.deepEqual(list.map((chat) => chat.title), ['Launch']);
  assert.ok(list[0].members.some((member) => member.memberId === 'owner'), 'the CEO reads as "owner"');
  await assert.rejects(person.call('messages.list', { conversationId: own.id }), /not found/);
  await person.call('events.subscribe', { topics: ['chats', 'tasks', 'org', `chat:${shared.id}`, `chat:${own.id}`] });
  const reply = waitForNew(person, 'message.updated', (message) => message.conversationId === shared.id && message.authorId === manager.id && message.state === 'final', 90_000);
  const sent = await person.call('messages.send', { conversationId: shared.id, body: `@${manager.name} hello from Anna`, mentions: [manager.id] });
  assert.equal(sent.authorId, 'human', 'her message is hers');
  assert.ok((await reply).body.length > 0, 'the agent answered her');
  const ownerView = (await owner.call('messages.list', { conversationId: shared.id })).find((message) => message.id === sent.id);
  assert.equal(ownerView.authorId, anna.id, 'the owner sees Anna as its author');

  // 3. A chat without the CEO: hers and the agent's; the admin sees it as hers (the owner-vs-people barrier went –
  //    Umbau Einfachheit: no guard layers).
  const side = await person.call('chats.create', { title: 'Side project', agentIds: [manager.id] });
  const meta = await owner.call('people.chats', { id: anna.id });
  assert.ok(meta.some((chat) => chat.id === side.id && chat.withOwner === false), 'the admin sees it as metadata');

  // 4. A task for her: her For you only; she finishes it (the owner could too – no barrier, Umbau Einfachheit).
  const task = await owner.call('tasks.create', { conversationId: shared.id, title: 'Pick the colours', assigneeKind: 'human', assigneeId: anna.id });
  const hers = await until(() => person.call('todos.list'), (entries) => entries.some((entry) => entry.id === task.id), 'her to-do');
  assert.equal(hers.find((entry) => entry.id === task.id).assigneeId, undefined, 'it reads as hers');
  assert.ok(!(await owner.call('todos.list')).some((entry) => entry.id === task.id), 'not on the owner\'s For you');
  await person.call('tasks.complete', { id: task.id, note: 'Blue and sand' });
  const done = await owner.call('tasks.get', { id: task.id });
  assert.equal(done.status, 'done');
  assert.equal(done.result.verification, 'reported_by_human');

  // 4b. Calls are the chat's voice conversation now (seats, floor and call lists went): she gets no realtime voice.
  await assert.rejects(person.call('calls.realtimeOpen', { conversationId: shared.id }), /not allowed|forbidden|unknown/i);

  // 4c. Changed rights reach her open app at once: the owner turns "start chats" off – her live
  // connection closes now (her app reconnects), and the next one no longer offers chats.create.
  const closedOnce = (client) => new Promise((resolve) => { const check = () => client.call('session.info').then(() => setTimeout(check, 100), resolve); check(); });
  const rightsChanged = closedOnce(person);
  await owner.call('people.save', { id: anna.id, scopes: { spaces: 'all', startChats: false, assignAgents: true } });
  await rightsChanged;
  const again = await connect(live.port, joined.token, 'pwa');
  const fresh = await again.call('session.info');
  assert.equal(fresh.allowedMethods.includes('chats.create'), false, 'her next connection carries the new rights');
  assert.equal(fresh.person.scopes.startChats, false);

  // 5. Revoke: the live connection ends at once; the token is refused as removed.
  const closed = closedOnce(again);
  const revoked = await owner.call('people.revoke', { id: anna.id });
  assert.equal(revoked.status, 'revoked');
  await closed;
  assert.equal(await closeCode(live.port, joined.token), 4403);
  const after = await owner.call('chats.get', { id: shared.id });
  assert.ok(!after.members.some((member) => member.memberId === anna.id), 'she left the chat');
  // her own chat stays (no barrier between the owner and people any more – Umbau Einfachheit): the owner reads it
  assert.ok((await owner.call('chats.list', { includeHidden: true })).some((chat) => chat.id === side.id), 'her chat stays');
  assert.ok(Array.isArray(await owner.call('messages.list', { conversationId: side.id })), 'the owner reads it');
});
