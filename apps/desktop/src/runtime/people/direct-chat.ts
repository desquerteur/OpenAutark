// The 1:1 chat between two humans of the organisation (F-52, people.directChat): the owner and a
// person, or two people. Also the 1:1 chat of an agent and a person (agentDirectChat), made by the system
// when none exists.
// B-050 K1: both are the pair's default 1:1 (chat/direct.ts findOrCreateDirect – found, archived too, adopted
// from an older chat of exactly the two that names no topic, else created untitled); these stay as thin wrappers.
// Owns: who may have such a chat here (directChat: humans only). Never: adds a third member, or a person who is not active.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { OrgService, RuntimeServices } from '../contracts.ts';
import { findOrCreateDirect } from '../chat/direct.ts';
import { activePerson } from './repo.ts';

type Deps = Pick<RuntimeServices, 'db' | 'chats'> & Partial<Pick<RuntimeServices, 'people' | 'clock'>> & { org?: Pick<OrgService, 'get'> };

/** The default 1:1 of two humans (the owner, active people); `from` starts it when new. */
export function directChat(s: Deps, from: string, to: string): string {
  if (from === to) throw new WorkforceError('bad_request', 'Choose someone else.');
  for (const id of [from, to]) {
    if (id !== HUMAN_ID && (!isPersonId(id) || !activePerson(s.db, id))) throw new WorkforceError('not_found', 'This person is not in the organisation.', { details: { personId: id } });
  }
  return findOrCreateDirect(s, from, to, { createdBy: from });
}

/** The default 1:1 of a person and an agent (checked against the org); the system starts it when new. */
export function agentDirectChat(s: Deps, personId: string, agentId: string): string {
  return findOrCreateDirect(s, personId, agentId, { createdBy: SYSTEM_ID });
}
