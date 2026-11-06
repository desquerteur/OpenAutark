// F-52 what a person sees beyond their chats' messages: the agents of their spaces (none by default,
// never the private space unless the owner picks it), the agents of their chats, their manager and
// reports; tasks of their chats only from their join on (unless the chat shares its history); image
// avatars. Plus the org chart's one cycle walk across people and agents, the handler table's merged
// cache and the global limit on wrong invite codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from './rig.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';
import { PeopleRepo } from '../../../src/runtime/people/repo.ts';
import { mayReadFile } from '../../../src/runtime/people/access.ts';
import { CODE_WINDOW_MS, JoinRequests, MAX_WRONG_CODES } from '../../../src/runtime/people/join.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { DEFAULT_PERSON_SCOPES, type Person } from '../../../src/shared/model/people.ts';
import type { Agent, Space } from '../../../src/shared/model/org.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import path from 'node:path';

test('a new person works with no space\'s agents until the owner picks spaces', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  assert.deepEqual(DEFAULT_PERSON_SCOPES.spaces, []);
  const dana = await r.owner.call<Person>('people.save', { name: 'Dana' });
  assert.deepEqual(dana.scopes.spaces, [], 'never every space (with the private one) by default');
});

test('a space-limited person sees only the agents of their spaces, chats and reporting lines', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const cara = await r.join('Cara', { scopes: { spaces: ['sp_company'], startChats: true, assignAgents: true } });
  await cara.client.call('events.subscribe', { topics: ['org'] });
  const ids = async () => (await cara.client.call<Agent[]>('agents.list')).map((agent) => agent.id).sort();
  assert.deepEqual(await ids(), ['ag_research']);
  r.bus.emit('agent.upserted', r.org.get('ag_secret')!);
  r.bus.emit('space.upserted', { id: 'sp_private', name: 'Private', kind: 'private', sort: 1, createdAt: 0 } satisfies Space);
  r.bus.emit('space.upserted', { id: 'sp_company', name: 'Company', kind: 'company', sort: 0, createdAt: 0 } satisfies Space);
  r.bus.emit('agent.activity', { active: [{ agentId: 'ag_secret', runId: 'run_1', note: 'private errand', startedAt: 1 }, { agentId: 'ag_research', runId: 'run_2', note: 'x', startedAt: 1 }] });
  await settle();
  assert.equal(cara.client.events('agent.upserted').length, 0, 'not the private space\'s agent');
  assert.deepEqual(cara.client.events('space.upserted').map((event) => (event.data as Space).id), ['sp_company']);
  const active = (cara.client.events('agent.activity').at(-1)!.data as { active: Array<{ agentId: string }> }).active;
  assert.deepEqual(active.map((entry) => entry.agentId), ['ag_research']);
  // The owner shares a chat with the secretary: Cara meets it there (but may not give it work).
  const chat = r.chats.create({ agentIds: ['ag_secret'], people: [cara.person.id], createdBy: 'human', title: 'With the secretary' });
  assert.deepEqual(await ids(), ['ag_research', 'ag_secret']);
  await assert.rejects(cara.client.call('tasks.create', { conversationId: chat.id, title: 'Book it', assigneeKind: 'agent', assigneeId: 'ag_secret' }), /may not work with this agent/);
  // Her manager is visible too.
  r.org.update('ag_manager', {});
  await r.owner.call('people.save', { id: cara.person.id, managerId: 'ag_manager' });
  assert.deepEqual(await ids(), ['ag_manager', 'ag_research', 'ag_secret']);
});

test('with history "join", tasks of a chat made before the person joined stay hidden', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const cara = await r.join('Cara');
  const chat = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Owner chat' });
  const before = r.tasks.create({ conversationId: chat.id, title: 'Private task before join', notes: 'secret notes', createdBy: 'human' });
  r.clock.advance(1000);
  r.chats.setMembers(chat.id, { add: [cara.person.id] }, 'human');
  r.clock.advance(1000);
  const after = r.tasks.create({ conversationId: chat.id, title: 'After join', createdBy: 'human' });
  await cara.client.call('events.subscribe', { topics: ['tasks'] });
  const titles = async () => (await cara.client.call<TaskView[]>('tasks.list', { conversationId: chat.id })).map((task) => task.title);
  assert.deepEqual(await titles(), ['After join']);
  await assert.rejects(cara.client.call('tasks.get', { id: before.id }), /not found/i);
  r.tasks.update(before.id, { notes: 'more secret notes' }, 'human');
  await settle();
  assert.ok(!cara.client.events('task.upserted').some((event) => (event.data as TaskView).id === before.id), 'no event of it');
  r.chats.update(chat.id, { settings: { history: 'full' } }, 'human');
  assert.deepEqual((await titles()).sort(), ['After join', 'Private task before join']);
  assert.ok(after.id);
});

test('a person fetches the image avatars of active agents and people', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const cara = await r.join('Cara');
  const agentImage = 'a'.repeat(64);
  const personImage = 'b'.repeat(64);
  r.db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_pic', 'Pic', ?, 'human', 0, 0)`, [JSON.stringify({ kind: 'image', value: agentImage })]);
  await r.owner.call('people.save', { id: cara.person.id, avatar: { kind: 'image', value: personImage } });
  assert.equal(mayReadFile(r.db, cara.person.id, agentImage), true);
  assert.equal(mayReadFile(r.db, cara.person.id, personImage), true);
  assert.equal(mayReadFile(r.db, cara.person.id, 'c'.repeat(64)), false, 'any other file stays closed');
});

test('the org chart refuses cycles across people and agents', () => {
  const db = memoryDb();
  const org = new Org({ db, bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  const a = org.create({ name: 'Alpha', createdBy: 'human' });
  const b = org.create({ name: 'Beta', createdBy: 'human' });
  const people = new PeopleRepo(db);
  const person = (id: string, managerId?: string): Person => ({
    id, name: id, title: '', avatar: { kind: 'initials', value: 'P' }, status: 'active', owner: false, scopes: DEFAULT_PERSON_SCOPES, createdAt: 0, updatedAt: 0, ...(managerId ? { managerId } : {}),
  });
  people.save(person('per_aaaaaaaaaa', a.id)); // P reports to Alpha
  assert.throws(() => org.update(a.id, { managerId: 'per_aaaaaaaaaa' }), /cannot report to itself or to one of its reports/, 'Alpha → P → Alpha');
  people.save(person('per_bbbbbbbbbb', b.id)); // Q reports to Beta
  org.update(b.id, { managerId: a.id }); // Beta reports to Alpha
  assert.throws(() => org.update(a.id, { managerId: 'per_bbbbbbbbbb' }), /cannot report/, 'Alpha → Q → Beta → Alpha');
  org.update(b.id, { managerId: 'per_aaaaaaaaaa' }); // no cycle: Beta → P → Alpha
  assert.equal(org.get(b.id)!.managerId, 'per_aaaaaaaaaa');
});

test('a method registered after its person variant was read keeps its owner handler', async () => {
  const table = new HandlerTable();
  table.addPerson('session.info', () => 'person' as never);
  assert.ok(table.get('session.info'), 'read once (cached)');
  table.add('session.info', () => 'owner' as never);
  const entry = table.get('session.info')!;
  assert.equal(await entry.handler(undefined, { scope: { kind: 'owner' } } as never), 'owner');
});

test('wrong invite codes pause entering codes for a while but never end anyone\'s code', () => {
  let now = 1_000_000;
  const joins = new JoinRequests({
    now: () => now, bus: { on: () => () => {} } as never, log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    services: () => undefined, describe: () => 'Anna', issue: () => ({ token: 't', deviceId: 'd' }), changed: () => {},
    timers: { set: () => 0, clear: () => {} },
  });
  const { code } = joins.newCode('per_aaaaaaaaaa');
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < MAX_WRONG_CODES; i++) assert.equal(joins.redeemCode(wrong), undefined);
  assert.throws(() => joins.redeemCode(code), /Too many wrong codes/, 'paused for everyone, the right code too');
  now += CODE_WINDOW_MS / 2 + 1000;
  assert.throws(() => joins.redeemCode(code), /Too many wrong codes/);
  now += CODE_WINDOW_MS / 2;
  assert.equal(joins.redeemCode(code), 'per_aaaaaaaaaa', 'the code still works once the pause ends (it was not ended)');
});
