// Who may read a task: every agent reads every task, except one the person marked "Only me" (Task.private, also on
// a step of one) – that one only its own parties (owner, creator, assigner) read. readableSql is the same rule in SQL
// for agents' list queries (tasks/repo.ts).
// Owns: that rule. Never: grants anything beyond reading.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';

type AccessDeps = Partial<Pick<RuntimeServices, 'tasks'>>;

const MAX_DEPTH = 4;

/** May agent `agentId` read `task`? The person and the system read everything. */
export function canReadTask(s: AccessDeps, agentId: string, task: Task): boolean {
  if (agentId === HUMAN_ID || agentId === SYSTEM_ID) return true;
  if (task.assigneeId === agentId || task.createdBy === agentId || task.assignedBy === agentId) return true;
  return !onlyMe(s, task);
}

/** The task, or a task above it, is marked "Only me". */
export function onlyMe(s: AccessDeps, task: Task): boolean {
  let current: Task | undefined = task;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth++) {
    if (current.private) return true;
    current = current.parentId ? s.tasks?.get(current.parentId) : undefined;
  }
  return false;
}

/** SQL over `tasks t` for agent `agentId`'s list queries: not "Only me", or its own. */
export function readableSql(agentId: string): { sql: string; params: string[] } {
  return { sql: '(t.private = 0 OR t.assignee_id = ? OR t.created_by = ? OR t.assigned_by = ?)', params: [agentId, agentId, agentId] };
}
