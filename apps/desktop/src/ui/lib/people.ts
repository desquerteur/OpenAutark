// People of the organisation in the client (F-52): the list the owner manages (Team › People) or,
// on a person's device, the directory (ids from the person's side: 'human' = them, 'owner' = the
// CEO). Loaded on every (re)connect when this connection may read it, kept fresh by
// `person.upserted`. Views name and draw a chat member, a message author or a task owner that is
// not an agent from here (store.agentName, avatar.tsx).
// Owns: the people signal, its loader and name lookups. Never: changes people (the Team view calls
// people.* itself) or polls.

import { computed, signal } from '@preact/signals';
import type { Person } from '../../shared/model/people.ts';
import { rpc } from './rpc.ts';
import { can, session } from './session.ts';

export const people = signal<Person[]>([]);
export const peopleMap = computed(() => new Map(people.value.map((person) => [person.id, person])));

/** True on a person's device (not the owner's window or the owner's phones). */
export function isPersonSession(): boolean {
  return session.value?.kind === 'person';
}

/** A person's display name by id (the owner's view: 'per_…' and 'human'; a person's view: 'owner' and colleagues). */
export function personName(id: string): string | undefined {
  return peopleMap.value.get(id)?.name;
}

/** People other than the caller who are still in the organisation, by name. */
export function colleagues(): Person[] {
  return people.value.filter((person) => person.status !== 'revoked' && person.id !== 'human').sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadPeople(): Promise<void> {
  if (!can('people.list')) { people.value = []; return; }
  try { people.value = await rpc.call('people.list'); } catch { /* keep what is shown; the next connect loads again */ }
}

export function upsertPerson(person: Person): void {
  const index = people.value.findIndex((entry) => entry.id === person.id);
  if (index === -1) people.value = [...people.value, person];
  else { const next = people.value.slice(); next[index] = person; people.value = next; }
}

/** Called once from store-events.ts: loads after each connect (once session.info is known) and applies changes. */
export function wirePeople(): void {
  rpc.on('person.upserted', upsertPerson);
}
