// Which task messages in a chat shrink to one compact line (D5): a finished task an agent created – made
// during a run (meta.fromRun) or by an agent at all. Open cards (work still running) and people's own tasks
// (the owner's, a colleague's) stay full cards. Plus the line's short state word.
// Owns: these rules (unit-tested in test/unit/ui/compact-task.test.ts). Never: imports the store, rpc or the DOM.

import type { Message } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { OWNER_ALIAS, isHumanActor } from '../../shared/model/people.ts';

/** True when this task message is one compact line (a finished task an agent made), false for a full card. */
export function isCompact(task: Pick<TaskView, 'status' | 'createdBy'>, message: Pick<Message, 'meta'>): boolean {
  if (task.status !== 'done' && task.status !== 'cancelled') return false;
  const fromRun = message.meta.fromRun;
  if (typeof fromRun === 'string' && fromRun) return true;
  // An agent made it: not the owner, not another person (per_…, their own work stays a card), not the app.
  const by = task.createdBy;
  return by !== HUMAN_ID && by !== OWNER_ALIAS && by !== SYSTEM_ID && !isHumanActor(by);
}

/** The line's state: Done or Cancelled. */
export function compactState(task: Pick<TaskView, 'status'>): string {
  return task.status === 'done' ? 'Done' : 'Cancelled';
}
