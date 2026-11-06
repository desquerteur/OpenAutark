// Test rig for people of the organisation (F-52): the RPC fixture (real chats, tasks, settings,
// journal, blobs; fake dispatcher) with the people module, session.info and a real PeopleService
// on fake timers, an org with two spaces and agents, and helpers that invite a person, let their
// device join (the owner allows it on the decision to-do) and connect it as a person client.
// Owns: fixtures only. Never imported by src/.

import { agent, FakeOrg, FakeTimers } from '../chat/harness.ts';
import { rpcFixture, s1Table, settle, TestClient, OWNER } from '../rpc/s1-helpers.ts';
import { PeopleService } from '../../../src/runtime/people/service.ts';
import { register as people } from '../../../src/runtime/rpc/handlers/people.ts';
import { register as session } from '../../../src/runtime/rpc/handlers/session.ts';
import { register as references } from '../../../src/runtime/rpc/handlers/references.ts'; // F-52: the owner's side of references (people's in people.ts)
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { HandlerModule } from '../../../src/runtime/rpc/table.ts';
import type { Agent, Space } from '../../../src/shared/model/org.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import '../../../src/runtime/contracts/people.ts';

class Org extends FakeOrg {
  spaceList: Space[] = [
    { id: 'sp_company', name: 'Company', kind: 'company', sort: 0, createdAt: 0 },
    { id: 'sp_private', name: 'Private', kind: 'private', sort: 1, createdAt: 0 },
  ];
  spaces(): Space[] { return this.spaceList; }
  update(id: string, patch: Partial<Agent>): Agent {
    const next = { ...this.require(id), ...patch };
    if (Object.hasOwn(patch, 'managerId') && patch.managerId === undefined) delete next.managerId;
    this.agents.set(id, next);
    return next;
  }
}

/** The scopes the rig gives a person unless a test names others: the company space's agents. */
export const COMPANY: Person['scopes'] = { spaces: ['sp_company'], startChats: true, assignAgents: true };

/** `modules`: more handler modules a test needs (e.g. calls). */
export function peopleRig(options: { modules?: HandlerModule[] } = {}) {
  const table = s1Table();
  people(table);
  session(table);
  references(table);
  for (const register of options.modules ?? []) register(table);
  const f = rpcFixture({ table });
  const org = new Org();
  org.add(agent('ag_manager', 'Manager', { mode: 'manager' }));
  org.add(agent('ag_research', 'Research', { spaceId: 'sp_company', managerId: 'ag_manager' }));
  org.add(agent('ag_secret', 'Secretary', { spaceId: 'sp_private' }));
  const services = f.services as RuntimeServices;
  services.org = org as unknown as RuntimeServices['org'];
  const timers = new FakeTimers();
  const service = new PeopleService({
    db: f.db, clock: f.clock, bus: f.bus, log: services.log, settings: services.settings,
    services: () => services, timers,
    address: () => ({ url: 'https://pc.tailnet.ts.net', reachable: true }),
    qr: async (text) => `data:image/png;base64,${Buffer.from(text).toString('base64').slice(0, 8)}`,
  });
  service.ensureOwner();
  services.people = service;
  f.bus.on('message.created', (message) => service.recordChatChange(message)); // as compose/people.ts wires it
  const owner = new TestClient(f.server, OWNER);

  /** Creates a person (owner) and lets one device of theirs join; returns the person, scope and client. */
  async function join(name: string, input: { title?: string; scopes?: Person['scopes'] } = {}) {
    // A new person works with no space's agents by default; the tests give the company space unless they name scopes.
    const person = await owner.call<Person>('people.save', { name, scopes: COMPANY, ...input });
    const invite = await owner.call<{ url: string; code: string }>('people.invite', { id: person.id });
    const ticket = invite.url.split('#join=')[1];
    const request = await f.server.handleHttp({ id: 1, method: 'people.join', params: { ticket, name: `${name}'s phone` } }, { remote: '10.0.0.9' });
    if (request.error) throw new Error(request.error.message);
    const asked = request.result as { ticket: string; id: string };
    const todo = (await owner.call<Array<{ id: string; title: string }>>('todos.list')).find((entry) => entry.title.includes(name));
    if (!todo) throw new Error('no decision to-do');
    await owner.call('tasks.complete', { id: todo.id, answer: { choice: 'Allow' } });
    await settle();
    const waited = await f.server.handleHttp({ id: 2, method: 'people.awaitJoin', params: { ticket: asked.ticket } }, { remote: '10.0.0.9' });
    const result = waited.result as { status: string; token: string };
    if (result.status !== 'accepted') throw new Error(`join not accepted: ${JSON.stringify(waited)}`);
    const scope = service.authenticate(result.token) as Extract<ClientScope, { kind: 'person' }>;
    const client = new TestClient(f.server, { ...scope, secure: true });
    return { person: service.require(person.id), scope, client, token: result.token };
  }

  return { ...f, org, timers, service, owner, join };
}

export { settle };
