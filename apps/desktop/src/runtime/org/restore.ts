// Restoring an archived agent (O6): where it goes back to and what it keeps.
// Owns: the pure placement rule – under its old manager while that one is active, else under the
// person; in its space while that one is active, else in none; its own name, or the unique
// variant the service picked because another active agent took the name meanwhile (generated
// initials follow the name, the color stays); idle without a status note.
// Never: database access or events (org/service.ts saves and emits), and never moves its former
// reports back – archiving moved them up and the person may have placed them since.

import type { Agent, Space } from '../../shared/model/org.ts';
import { initials } from './avatar.ts';

export interface RestoreFacts {
  /** The agent stored as its manager (archived or missing ones count as none). */
  manager?: Agent;
  /** The space stored on the agent (archived or missing ones count as none). */
  space?: Space;
  /** Its name, or a unique variant when another active agent has it now. */
  name: string;
  now: number;
}

/** The agent as it is saved when restored. Returns a copy; `agent` stays untouched. */
export function restoredAgent(agent: Agent, facts: RestoreFacts): Agent {
  const next: Agent = { ...agent, name: facts.name, status: 'idle', updatedAt: facts.now };
  delete next.archivedAt;
  delete next.statusNote;
  const manager = facts.manager;
  if (manager && !manager.archivedAt && manager.id !== agent.id) next.managerId = manager.id;
  else delete next.managerId;
  const space = facts.space;
  if (space && !space.archivedAt) next.spaceId = space.id;
  else delete next.spaceId;
  if (facts.name !== agent.name && agent.avatar.kind === 'initials') next.avatar = { ...agent.avatar, value: initials(facts.name) };
  return next;
}
