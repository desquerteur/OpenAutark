// F-52 people: the owner is the first person, people are created, invited (link/QR ticket or code,
// one use), admitted only by the owner on the host-bound to-do, authenticated with a person scope,
// audited, and revoked at once (tokens, connections, chats, open work, reports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from './rig.ts';
import { DEVICE_SCOPE_PHONE } from './scopes.ts';
import { TestClient } from '../rpc/s1-helpers.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';

test('the owner is the first person; a new person is invited, audited and listed with an open invite', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  r.services.settings.update({ profile: { name: 'Mara' } });
  const anna = await r.owner.call<Person>('people.save', { name: 'Anna Berg', title: 'Designer', managerId: 'human' });
  assert.match(anna.id, /^per_/);
  assert.equal(anna.status, 'invited');
  assert.equal(anna.managerId, 'human');
  const list = await r.owner.call<Person[]>('people.list');
  assert.deepEqual(list.map((person) => [person.name, person.owner]), [['Mara', true], ['Anna Berg', false]]);
  const invite = await r.owner.call<{ url: string; code: string; reachable: boolean; expiresAt: number }>('people.invite', { id: anna.id });
  assert.match(invite.url, /^https:\/\/pc\.tailnet\.ts\.net\/#join=[A-Za-z0-9_-]{40,}$/);
  assert.match(invite.code, /^\d{6}$/);
  assert.equal(invite.reachable, true);
  assert.ok((await r.owner.call<Person[]>('people.list'))[1].inviteOpenUntil);
  const audit = await r.owner.call<Array<{ action: string }>>('people.audit', { id: anna.id });
  assert.deepEqual(audit.map((line) => line.action), ['invited', 'created']);
  assert.ok(!JSON.stringify(audit).includes(invite.url.split('#join=')[1]), 'no ticket in the audit');
  await assert.rejects(r.owner.call('people.save', { id: anna.id, managerId: anna.id }), /themselves/);
  await assert.rejects(r.owner.call('people.save', { id: 'human', managerId: anna.id }), /top of the organisation/);
});

test('joining: the ticket works once, the owner allows on the to-do, the page collects a person token', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const joined = await r.join('Anna Berg', { title: 'Designer' });
  assert.equal(joined.person.status, 'active');
  assert.equal(joined.scope.kind, 'person');
  assert.equal(joined.scope.personId, joined.person.id);
  assert.equal(joined.person.devices?.length, 1);
  assert.equal(joined.person.devices?.[0].name, "Anna Berg's phone");
  const info = await joined.client.call<{ kind: string; person: { name: string }; allowedMethods: string[] }>('session.info');
  assert.equal(info.kind, 'person');
  assert.equal(info.person.name, 'Anna Berg');
  assert.ok(info.allowedMethods.includes('messages.send'));
  assert.ok(info.allowedMethods.includes('pwa.pushSubscribe') && info.allowedMethods.includes('pwa.pushConfig'), 'notifications on their device');
  for (const method of ['people.save', 'people.invite', 'agents.update', 'tasks.delete', 'secrets.list', 'remote.state', 'files.uploadPath', 'pwa.state']) {
    assert.ok(!info.allowedMethods.includes(method), method);
  }
  assert.ok(!info.allowedMethods.includes('settings.update'), 'a person keeps no settings of their own on this PC');
  await assert.rejects(joined.client.call('people.save', { name: 'Eve' }), /not allowed/);
  await assert.rejects(joined.client.call('tasks.delete', { id: 'task_x' }), /not allowed/);
  // The same invite link does not work a second time.
  const invite = await r.owner.call<{ url: string }>('people.invite', { id: joined.person.id });
  const ticket = invite.url.split('#join=')[1];
  const first = await r.server.handleHttp({ id: 1, method: 'people.join', params: { ticket } }, { remote: '10.0.0.7' });
  assert.ok(first.result, JSON.stringify(first));
  const again = await r.server.handleHttp({ id: 2, method: 'people.join', params: { ticket } }, { remote: '10.0.0.7' });
  assert.equal(again.error?.code, 'forbidden');
});

test('joining by code, a declined request, and an Allow from a phone that is refused', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const ben = await r.owner.call<Person>('people.save', { name: 'Ben' });
  const invite = await r.owner.call<{ code: string }>('people.invite', { id: ben.id });
  const wrong = await r.server.handleHttp({ id: 1, method: 'people.join', params: { code: '000000' === invite.code ? '111111' : '000000' } }, { remote: '10.0.0.2' });
  assert.equal(wrong.error?.code, 'forbidden');
  const asked = await r.server.handleHttp({ id: 2, method: 'people.join', params: { code: invite.code.replace(/^(\d{3})/, '$1 '), name: 'Laptop · Firefox' } }, { remote: '10.0.0.2' });
  const ticket = (asked.result as { ticket: string; proven: boolean }).ticket;
  assert.equal((asked.result as { proven: boolean }).proven, true);
  const todo = (await r.owner.call<Array<{ id: string; title: string }>>('todos.list')).find((entry) => entry.title === 'Let Laptop · Firefox join as Ben?');
  assert.ok(todo, 'the owner decides on a host-written to-do');
  // The owner's phone may not admit people: its Allow is refused and the to-do comes back.
  const phone = new TestClient(r.server, DEVICE_SCOPE_PHONE);
  await phone.call('tasks.complete', { id: todo!.id, answer: { choice: 'Allow' } });
  await settle();
  const back = (await r.owner.call<Array<{ id: string; title: string }>>('todos.list')).find((entry) => entry.title === 'Let Laptop · Firefox join as Ben?');
  assert.ok(back && back.id !== todo!.id, 'the to-do came back');
  await r.owner.call('tasks.complete', { id: back!.id, answer: { choice: 'Deny' } });
  await settle();
  const waited = await r.server.handleHttp({ id: 3, method: 'people.awaitJoin', params: { ticket } }, { remote: '10.0.0.2' });
  assert.equal((waited.result as { status: string }).status, 'denied');
  assert.equal(r.service.require(ben.id).status, 'invited');
  const actions = r.service.audit(ben.id).map((line) => line.action);
  assert.ok(actions.includes('join_requested') && actions.includes('join_declined'), actions.join());
});

test('revoking ends tokens and live connections at once, leaves chats, returns open work, moves reports up', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Design' });
  const task = r.tasks.create({ conversationId: chat.id, title: 'Draw the logo', assigneeKind: 'human', assigneeId: anna.person.id, createdBy: 'human' });
  r.org.update('ag_research', { managerId: anna.person.id });
  const ben = await r.owner.call<Person>('people.save', { name: 'Ben', managerId: anna.person.id });
  await anna.client.call('events.subscribe', { topics: ['chats'] });
  assert.equal(anna.client.raw.closed, false);
  const revoked = await r.owner.call<Person>('people.revoke', { id: anna.person.id });
  await settle();
  assert.equal(revoked.status, 'revoked');
  assert.equal(anna.client.raw.closed, true, 'the live connection was dropped');
  assert.equal(r.service.authenticate(anna.token), undefined);
  assert.equal(r.service.revoked(anna.token), true, 'the page learns it was removed (4403)');
  assert.ok(!r.chats.members(chat.id).some((member) => member.memberId === anna.person.id), 'left the chat');
  const back = r.tasks.get(task.id)!;
  assert.equal(back.assigneeKind, 'team', 'open work returned to the team');
  assert.equal(r.org.get('ag_research')?.managerId, undefined, 'the agent moved up');
  assert.equal(r.service.require(ben.id).managerId, undefined, 'the person moved up');
  const line = r.service.audit(anna.person.id)[0];
  assert.equal(line.action, 'revoked');
  assert.deepEqual(line.details, { chats: 1, tasks: 1, reports: 2 });
  await assert.rejects(r.owner.call('people.revoke', { id: 'human' }), /owner cannot be removed/);
});

test('changed rights reach the open app at once: only that person\'s connections close, and the next one has the new rights', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const ben = await r.join('Ben Vogt');
  await anna.client.call('events.subscribe', { topics: ['org'] });
  assert.ok((await anna.client.call<{ allowedMethods: string[] }>('session.info')).allowedMethods.includes('chats.create'));
  // A change that is not about her rights (title) and a new device of hers keep the connection.
  await r.owner.call('people.save', { id: anna.person.id, title: 'Lead designer' });
  await settle();
  assert.equal(anna.client.raw.closed, false, 'a title change keeps it open');
  assert.ok(anna.client.events('person.upserted').length > 0, 'her app hears the change as an event');
  // Her rights change: her connection closes now (event-driven, no polling) – Ben's stays.
  await r.owner.call('people.save', { id: anna.person.id, scopes: { spaces: ['sp_company'], startChats: false, assignAgents: true } });
  await settle();
  assert.equal(anna.client.raw.closed, true, 'her open app reconnects at once');
  assert.equal(ben.client.raw.closed, false, 'another person\'s app is untouched');
  const again = new TestClient(r.server, { ...anna.scope, secure: true });
  const info = await again.call<{ allowedMethods: string[]; person: { scopes: Person['scopes'] } }>('session.info');
  assert.equal(info.allowedMethods.includes('chats.create'), false, 'the reconnected app offers no "+ Chat"');
  assert.equal(info.person.scopes.startChats, false);
  // A new manager or the same rights in another order are no rights change: the directory event carries it.
  await again.call('events.subscribe', { topics: ['org'] });
  await r.owner.call('people.save', { id: anna.person.id, managerId: 'ag_manager' });
  await r.owner.call('people.save', { id: anna.person.id, scopes: { assignAgents: true, startChats: false, spaces: ['sp_company'] } });
  await settle();
  assert.equal(again.raw.closed, false, 'still open');
  assert.ok(again.events('person.upserted').some((event) => (event.data as Person).managerId === 'ag_manager'), 'the new manager arrives live');
});

test('a joined person stays in (no phone switch since B-078); closeFor ends their open join requests', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  assert.ok(r.service.authenticate(anna.token));
  assert.equal(r.service.isLive(anna.scope), true);
  const invite = await r.owner.call<{ url: string }>('people.invite', { id: anna.person.id });
  const asked = await r.server.handleHttp({ id: 1, method: 'people.join', params: { ticket: invite.url.split('#join=')[1] } }, { remote: '10.0.0.4' });
  assert.equal(r.service.joins.pending(), 1);
  r.service.joins.closeFor(anna.person.id);
  const waited = await r.server.handleHttp({ id: 2, method: 'people.awaitJoin', params: { ticket: (asked.result as { ticket: string }).ticket } }, { remote: '10.0.0.4' });
  assert.equal((waited.result as { status: string }).status, 'denied');
  assert.equal(r.service.joins.pending(), 0);
});

test('a second device joins with a new invite; removing one device drops only that connection', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const phone = await r.join('Anna Berg');
  const invite = await r.owner.call<{ url: string }>('people.invite', { id: phone.person.id });
  const asked = await r.server.handleHttp({ id: 1, method: 'people.join', params: { ticket: invite.url.split('#join=')[1], name: 'Laptop' } }, { remote: '10.0.0.8' });
  const todo = (await r.owner.call<Array<{ id: string; title: string }>>('todos.list')).find((entry) => entry.title === 'Let Laptop join as Anna Berg?');
  assert.ok(todo);
  await r.owner.call('tasks.complete', { id: todo!.id, answer: { choice: 'Allow' } });
  await settle();
  const waited = await r.server.handleHttp({ id: 2, method: 'people.awaitJoin', params: { ticket: (asked.result as { ticket: string }).ticket } }, { remote: '10.0.0.8' });
  const laptopToken = (waited.result as { token: string }).token;
  const laptopScope = r.service.authenticate(laptopToken) as Extract<ClientScope, { kind: 'person' }>;
  const laptop = new TestClient(r.server, { ...laptopScope, secure: true });
  assert.equal(r.service.require(phone.person.id).devices?.length, 2);
  await r.owner.call('people.removeDevice', { id: phone.person.id, deviceId: phone.scope.deviceId });
  await settle();
  assert.equal(phone.client.raw.closed, true, 'the removed phone is cut off');
  assert.equal(laptop.raw.closed, false, 'the laptop stays');
  assert.equal((await laptop.call<{ kind: string }>('session.info')).kind, 'person');
  assert.equal(r.service.require(phone.person.id).status, 'active');
});
