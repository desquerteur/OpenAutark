// B-050 K10 (tools/builtin/people.ts): people.list is the organisation's directory an agent may reach – the owner
// ('human') and every colleague who is not revoked, with name, title, manager and whether they joined; never devices,
// invites or scopes; a read; without the people module only the owner is named.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { peopleTools } from '../../../src/runtime/tools/builtin/people.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, title: '', avatar: { kind: 'initials', value: '' }, status: 'active', owner: false,
  scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: 0, updatedAt: 0, ...extra,
});

function setup(people?: Person[]) {
  const h = harness();
  Object.assign(h.services, {
    settings: { get: () => ({ profile: { name: 'Sam' } }) },
    ...(people ? { people: { list: () => people, nameOf: (id: string) => people.find((entry) => entry.id === id)?.name } } : {}),
  });
  h.org.add(agent('ag_ava', 'Ava'));
  const ctx = {
    agent: h.org.get('ag_ava')!, runId: 'run_people', mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
  return { ...h, list: () => peopleTools[0].run({} as never, ctx) };
}

test('people.list: the owner and colleagues who are not revoked – name, title, manager, joined; nothing private', async () => {
  const h = setup([
    person(HUMAN_ID, '', { owner: true, title: 'CEO' }),
    person('per_anna000000', 'Anna Berg', { title: 'Designer', managerId: HUMAN_ID, devices: [{ id: 'dev_1', name: 'Phone', createdAt: 0 }] }),
    person('per_ben0000000', 'Ben Ott', { status: 'invited', managerId: 'ag_ava', inviteOpenUntil: 99 }),
    person('per_gone000000', 'Gone', { status: 'revoked' }),
  ]);
  const out = await h.list();
  assert.equal(peopleTools[0].category, 'read');
  const rows = JSON.parse((out.content[0] as { text: string }).text) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    { id: HUMAN_ID, name: 'Sam', title: 'CEO', pc: 'this PC', calendar: 'here' },
    { id: 'per_anna000000', name: 'Anna Berg', title: 'Designer', manager: 'Sam (human)' },
    { id: 'per_ben0000000', name: 'Ben Ott', manager: 'Ava (ag_ava)', joined: false },
  ]);
});

test('people.list without the people module names only the owner', async () => {
  const out = await setup().list();
  assert.match((out.content[0] as { text: string }).text, /Only the person I work for \("human"\)/);
});
