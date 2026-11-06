// B-041 §8 – humans and AI in one org chart (src/ui/team/people-model.ts): people as nodes with the
// agents that report to them (peopleOrg on top of buildOrg), the top's own agents staying in the
// space-grouped tree, cycles in damaged data, report counts and "reports to" for the top; whom an
// agent reports to from this connection's side (managerOf: the AgentProfile bug where a person
// manager read "You"); and which side a chat message is drawn on (messageSide: the MessageItem bug
// where every human's words were the caller's own bubble), plus the source wiring of both fixes.
// Owns: these assertions only. Never: renders, rpc or the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import { buildOrg } from '../../../src/ui/team/model.ts';
import type { OrgEntry } from '../../../src/ui/team/model.ts';
import type { PersonEntry } from '../../../src/ui/team/people-model.ts';
import { countPersonReports, managerOf, messageSide, peopleOrg, topPersonId } from '../../../src/ui/team/people-model.ts';

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, title: '', avatar: { kind: 'initials', value: name[0] }, status: 'active', owner: id === 'human',
  scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: 0, updatedAt: 0, ...extra,
});

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, name: patch.name ?? id.toUpperCase(), role: 'Role', avatar: { kind: 'initials', value: id.slice(0, 2) }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0,
    ...patch,
  };
}

const names = (entries: PersonEntry[]): unknown[] => entries.map((entry) => [entry.person.name, ...(entry.people.length ? [names(entry.people)] : [])]);
const agentIds = (entries: OrgEntry[]): unknown[] => entries.map((entry) => (entry.reports.length ? [entry.agent.id, agentIds(entry.reports)] : entry.agent.id));

test('peopleOrg: the owner on top, people under whom they report to, each with the agent branches under them', () => {
  const people = [person('per_ben', 'Ben', { managerId: 'per_anna' }), person('per_anna', 'Anna', { managerId: 'human' }), person('human', 'Mara', { title: 'CEO' }), person('per_cara', 'Cara', { managerId: 'human' })];
  const agents = [
    agent('ag_mgr', { name: 'Manager' }), // no manager: the top's
    agent('ag_res', { managerId: 'ag_mgr' }),
    agent('ag_design', { managerId: 'per_anna' }), // Anna's agent …
    agent('ag_junior', { managerId: 'ag_design' }), // … with its own report
    agent('ag_mine', { managerId: 'human' }), // explicitly the owner's: stays with the top's agents
  ];
  const chart = peopleOrg(people, buildOrg(agents));
  assert.deepEqual(names(chart.people), [['Mara', [['Anna', [['Ben']]], ['Cara']]]]);
  const anna = chart.people[0].people[0];
  assert.deepEqual(agentIds(anna.agents), [['ag_design', ['ag_junior']]], 'the whole branch moves under the person');
  assert.deepEqual(agentIds(chart.agents).sort(), [['ag_mgr', ['ag_res']], 'ag_mine'].sort(), 'the top\'s agents stay in the agent tree');
  assert.equal(countPersonReports(chart.people[0]), 5, 'the owner: Anna, Ben, her two agents and Cara (the top\'s own agents are the tree below)');
  assert.equal(countPersonReports(anna), 3, 'Anna: Ben and her two agents');
});

test('peopleOrg: on a person\'s device the CEO (\'owner\') is the top; unknown managers and cycles never lose anyone', () => {
  const people = [person('owner', 'Mara', { owner: true }), person('human', 'Anna', { owner: false, managerId: 'owner' })];
  assert.equal(topPersonId(people), 'owner');
  assert.equal(topPersonId([]), 'human', 'no directory: the caller');
  const chart = peopleOrg(people, buildOrg([agent('ag_a'), agent('ag_b', { managerId: 'owner' }), agent('ag_c', { managerId: 'human' }), agent('ag_d', { managerId: 'per_gone' })]));
  assert.deepEqual(names(chart.people), [['Mara', [['Anna']]]]);
  assert.deepEqual(agentIds(chart.people[0].people[0].agents), ['ag_c'], 'her own agent sits under her');
  assert.deepEqual(agentIds(chart.agents).sort(), ['ag_a', 'ag_b', 'ag_d'], 'the CEO\'s, and one whose person is not listed');

  const loop = peopleOrg([person('human', 'Mara'), person('per_a', 'Ann', { managerId: 'per_b' }), person('per_b', 'Bob', { managerId: 'per_a' })], []);
  assert.deepEqual(names(loop.people), [['Mara'], ['Ann'], ['Bob']], 'a cycle becomes roots, the top first');
  const revoked = peopleOrg([person('per_z', 'Zoe', { status: 'revoked' }), person('per_y', 'Yan'), person('human', 'Mara')], []);
  assert.deepEqual(names(revoked.people), [['Mara'], ['Yan'], ['Zoe']], 'removed access last');
});

test('managerOf: an agent\'s manager from this connection\'s side', () => {
  const isAgent = (id: string) => id.startsWith('ag_');
  assert.deepEqual(managerOf(undefined, { isAgent, personSession: false }), { kind: 'self' }, 'no manager on the owner\'s PC: You');
  assert.deepEqual(managerOf(undefined, { isAgent, personSession: true }), { kind: 'person', id: 'owner' }, 'on a person\'s device: the CEO, not "You"');
  assert.deepEqual(managerOf('human', { isAgent, personSession: true }), { kind: 'self' }, '\'human\' is always the caller');
  assert.deepEqual(managerOf('per_01jbx3k9q2abcdefgh', { isAgent, personSession: false }), { kind: 'person', id: 'per_01jbx3k9q2abcdefgh' }, 'a person manager is named, not "You"');
  assert.deepEqual(managerOf('per_anna', { isAgent, isPerson: (id) => id === 'per_anna', personSession: false }), { kind: 'person', id: 'per_anna' }, 'a listed person');
  assert.deepEqual(managerOf('owner', { isAgent, personSession: true }), { kind: 'person', id: 'owner' });
  assert.deepEqual(managerOf('ag_mgr', { isAgent, personSession: false }), { kind: 'agent', id: 'ag_mgr' });
  assert.deepEqual(managerOf('xyz_gone', { isAgent, personSession: false }), { kind: 'self' }, 'a removed manager falls back to the top');
});

test('messageSide: only the caller\'s own words are the right-hand bubble', () => {
  assert.equal(messageSide({ authorKind: 'human', authorId: 'human' }), 'own', 'the caller (also from a linked messenger or a call)');
  assert.equal(messageSide({ authorKind: 'human', authorId: 'per_anna' }), 'person', 'a colleague on the owner\'s PC');
  assert.equal(messageSide({ authorKind: 'human', authorId: 'owner' }), 'person', 'the CEO on a person\'s device');
  assert.equal(messageSide({ authorKind: 'agent', authorId: 'ag_mara' }), 'other');
  assert.equal(messageSide({ authorKind: 'external', authorId: 'tg:Ben' }), 'other');
  assert.equal(messageSide({ authorKind: 'system', authorId: 'system' }), 'other');
});

test('source: MessageItem and ReplyQuote use the side rule; AgentProfile resolves person managers; avatars by shape', () => {
  const read = (file: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui', file), 'utf8');
  const item = read('chat/MessageItem.tsx');
  assert.match(item, /const human = side === 'own'/, 'the bubble only for the caller');
  assert.match(item, /go\.person\(message\.authorId\)/, 'a colleague\'s name opens their page');
  assert.doesNotMatch(item, /const human = message\.authorKind === 'human'/);
  const quote = read('chat/ReplyQuote.tsx');
  assert.match(quote, /messageSide\(message\)/);
  assert.doesNotMatch(quote, /authorKind === 'human'\) return 'You'/, '"You" only for one\'s own words');
  const profile = read('team/AgentProfile.tsx');
  assert.match(profile, /managerOf\(agent\.managerId/);
  assert.match(profile, /go\.person\(manager\.id\)/);
  const avatar = read('lib/avatar.tsx');
  assert.match(avatar, /working=\{props\.working\} onClick=\{props\.onClick\} agent \/>/, 'AgentAvatar draws agents as rounded squares');
  assert.match(read('styles/base.css'), /\.avatar\.agent, \.avatar\.agent img \{ border-radius: 30%; \}/, 'images too');
});
