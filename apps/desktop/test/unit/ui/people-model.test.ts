// F-52 in the client: Team › People's pure parts, task owners that are people (select values
// 'person:<id>' ↔ assignee kind 'human' + id), the For-you rule (only the caller's own to-dos), and the
// caller's own identity (lib/self-identity.ts: the profile button's name and avatar, never "CEO"/"C").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCode, managerOptions, statusLabel } from '../../../src/ui/team/people-model.ts';
import { ownerOf } from '../../../src/ui/tasks/model.ts';
import { onForYouList } from '../../../src/shared/model/todo-later.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, title: '', avatar: { kind: 'initials', value: name[0] }, status: 'active', owner: id === 'human',
  scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: 0, updatedAt: 0, ...extra,
});
const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, role: 'Researcher', ...extra }) as Agent;

test('People: labels, manager choices, scopes and reports', () => {
  assert.equal(statusLabel({ owner: true, status: 'active' }), 'Owner');
  assert.equal(statusLabel({ owner: false, status: 'invited' }), 'Invited');
  assert.equal(statusLabel({ owner: false, status: 'revoked' }), 'Access removed');
  const people = [person('human', 'Mara', { title: 'CEO' }), person('per_a', 'Anna'), person('per_b', 'Ben', { status: 'revoked' })];
  const agents = [agent('ag_1', 'Research'), agent('ag_2', 'Old', { archivedAt: 1 })];
  assert.deepEqual(managerOptions('per_a', people, agents).map((option) => option.value), ['', 'human', 'ag_1']);
  assert.equal(groupCode('482913'), '482 913');
});

test('a task owner can be a person; For you holds only your own to-dos', () => {
  assert.deepEqual(ownerOf({ assigneeKind: 'human', assigneeId: 'per_a' }), { kind: 'person', id: 'per_a' });
  assert.deepEqual(ownerOf({ assigneeKind: 'human' }), { kind: 'human' });
  assert.equal(onForYouList({ assigneeKind: 'human', status: 'open' }), true);
  assert.equal(onForYouList({ assigneeKind: 'human', assigneeId: 'per_a', status: 'open' }), false, 'a colleague\'s to-do');
  assert.equal(onForYouList({ assigneeKind: 'human', assigneeId: 'owner', status: 'open' }), false, 'the CEO\'s, seen on a person\'s device');
});

test('an invite address (#join=<ticket>) is recognised; other fragments are not', async () => {
  const { joinTicket } = await import('../../../src/ui/pwa/join.ts');
  const ticket = 'A'.repeat(43);
  assert.equal(joinTicket(`#join=${ticket}`), ticket);
  assert.equal(joinTicket(`#connect=${ticket}`), undefined);
  assert.equal(joinTicket('#join=short'), undefined);
});

test('the caller\'s own identity is the profile button\'s everywhere: Team › People, "Reports to" choices, names', async () => {
  const { selfIdentity, withSelf } = await import('../../../src/ui/lib/self-identity.ts');
  // The owner's row as the runtime sends it without a profile name: "CEO", empty initials.
  const ownerRow = person('human', 'CEO', { title: 'CEO', avatar: { kind: 'initials', value: '' } });
  assert.deepEqual(selfIdentity({ name: '' }, ownerRow), { name: 'You' }, 'no "CEO"/"C": "You", initials Y – as the profile button');
  assert.deepEqual(selfIdentity({ name: ' Gerd ', avatarFileId: 'f'.repeat(64) }, ownerRow), { name: 'Gerd', avatar: { kind: 'image', value: 'f'.repeat(64) } });
  assert.deepEqual(selfIdentity(undefined), { name: 'You' }, 'settings not loaded yet');
  // On a person's device 'human' is them: their directory avatar when the profile has no photo.
  assert.deepEqual(selfIdentity({ name: 'Anna' }, person('human', 'Anna', { avatar: { kind: 'emoji', value: '🦊' } })), { name: 'Anna', avatar: { kind: 'emoji', value: '🦊' } });
  const directory = withSelf([ownerRow, person('per_a', 'Anna')], { name: '' });
  assert.deepEqual(directory.map((entry) => entry.name), ['You', 'Anna']);
  assert.deepEqual(managerOptions('per_a', directory, []).map((option) => option.label).slice(1), ['You · CEO'], 'the "Reports to" choice names the owner the same way');
});
