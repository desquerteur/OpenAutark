// Who a person may report to (F-52, one org chart): nobody (the top), the owner, another person who
// is still in the organisation, or an active agent – never themselves or one of their own reports
// (the walk up follows people and agents alike – reportsUpTo, also used by the org service when an
// agent's manager changes). The owner stays at the top.
// Owns: that check and the walk. Never: saves anything.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { OrgService } from '../contracts.ts';
import type { PeopleRepo } from './repo.ts';

export function checkPersonManager(repo: Pick<PeopleRepo, 'get'>, org: Pick<OrgService, 'get'> | undefined, id: string, managerId: string | undefined): string | undefined {
  if (managerId === undefined) return undefined;
  if (id === HUMAN_ID) throw new WorkforceError('bad_request', 'The owner is at the top of the organisation.');
  if (managerId === id) throw new WorkforceError('bad_request', 'A person cannot report to themselves.');
  const human = (node: string) => isPersonId(node) || node === HUMAN_ID;
  if (human(managerId)) {
    const manager = repo.get(managerId);
    if (managerId !== HUMAN_ID && (!manager || manager.status === 'revoked')) throw new WorkforceError('not_found', 'This person is no longer in the organisation.');
  } else {
    const agent = org?.get(managerId);
    if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: managerId } });
  }
  if (reportsUpTo((node) => (human(node) ? repo.get(node)?.managerId : org?.get(node)?.managerId), managerId, id)) {
    throw new WorkforceError('bad_request', 'A person cannot report to one of their reports.');
  }
  return managerId;
}

/**
 * The one cycle walk of the org chart (people and agents alike): does the chain of managers from
 * `start` up reach `target`? `managerOf` names the manager of a person or an agent. Bounded, so a
 * stored loop never hangs it.
 */
export function reportsUpTo(managerOf: (node: string) => string | undefined, start: string, target: string): boolean {
  const seen = new Set<string>();
  for (let current: string | undefined = start; current && !seen.has(current) && seen.size < 500; current = managerOf(current)) {
    if (current === target) return true;
    seen.add(current);
  }
  return false;
}
