// Ending a person's access (people.revoke): after the tokens are cut, the person leaves every chat (their
// messages stay), their open work goes back – a to-do an agent asked of them is cancelled, other tasks return to
// the team of their chat – and the agents and people who reported to them move up to the person's own manager.
// Each part runs on its own; a failure is logged and the rest still runs.
// Owns: those steps. Never: deletes messages, tasks or people, or touches the tokens (people/tokens.ts).

import { HUMAN_ID } from '../../shared/ids.ts';
import type { TaskStatus } from '../../shared/model/tasks.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import type { PeopleRepo } from './repo.ts';
import { chatIdsOf } from './access.ts';

const OPEN: TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface OffboardResult { chats: number; tasks: number; reports: number }

export function offboard(s: Pick<RuntimeServices, 'db' | 'chats' | 'tasks' | 'org'>, repo: PeopleRepo, log: Logger, personId: string, now: number): OffboardResult {
  const out: OffboardResult = { chats: 0, tasks: 0, reports: 0 };
  const step = (what: string, fn: () => void) => { try { fn(); } catch (error) { log.warn(`offboarding: ${what} failed`, { personId, error: errorText(error) }); } };
  for (const conversationId of chatIdsOf(s.db, personId)) {
    step('leaving a chat', () => { s.chats.setMembers(conversationId, { remove: [personId] }, HUMAN_ID); out.chats++; });
  }
  for (const task of s.tasks.list({ assigneeKind: 'human', assigneeId: personId, status: OPEN, includeSteps: true, limit: 1000 })) {
    step('returning a task', () => {
      if (task.widget) s.tasks.setStatus(task.id, 'cancelled', HUMAN_ID, 'Access removed');
      else s.tasks.assign(task.id, { kind: 'team' }, HUMAN_ID);
      out.tasks++;
    });
  }
  const person = repo.get(personId);
  const up = person?.managerId && person.managerId !== personId ? person.managerId : undefined;
  for (const agent of s.org.list().filter((entry) => entry.managerId === personId)) {
    step('moving an agent up', () => { s.org.update(agent.id, { managerId: up }); out.reports++; });
  }
  for (const report of repo.reports(personId)) {
    step('moving a person up', () => { repo.save({ ...report, managerId: up, updatedAt: now }); out.reports++; });
  }
  return out;
}
