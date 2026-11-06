// Honest task status (B-078, live analysis 06.11.: "task says 'working' but nobody works on it"): 'working' holds
// only while a run is live on the task – a turn with its task id, or any turn in the chat it was handed over in. When
// the live activity changes (chat/activity.ts, no polling) and no run is left, a 'working' agent task goes back to
// 'open' quietly: no status line, no wake (the owner's follow-up – tasks/ownership.ts – treats open and working work
// alike and continues it).
// Owns: that one transition. Never: touches waiting, blocked or finished work, the person's to-dos or a paused task.

import type { Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { toTask } from './repo.ts';

const PER_CHAT = 20;

/** No run is live on it: not on its id, not in its chat. */
function idle(t: TaskServiceImpl, task: Task): boolean {
  if (t.isRunning(task.id)) return false;
  return !task.conversationId || !t.chatRunning(task.conversationId);
}

/**
 * The tasks (by id) and chats whose live activity just changed: their 'working' agent work without a live run goes
 * back to 'open'. Returns the ids it changed (each emitted once).
 */
export function settleWorking(t: TaskServiceImpl, taskIds: readonly string[], conversationIds: readonly string[]): Set<string> {
  const settled = new Set<string>();
  const settle = (task: Task | undefined) => {
    if (!task || settled.has(task.id) || task.status !== 'working' || task.assigneeKind !== 'agent' || !idle(t, task)) return;
    try {
      t.emit(t.mutate(task.id, (draft) => { draft.status = 'open'; }));
      settled.add(task.id);
    } catch (error) {
      t.s.log?.warn('ending a stale working status failed', { taskId: task.id, error: String(error) });
    }
  };
  for (const id of taskIds) settle(t.repo.get(id));
  for (const chat of conversationIds) {
    if (t.chatRunning(chat)) continue;
    const rows = t.s.db.all<Record<string, unknown>>(
      `SELECT * FROM tasks WHERE conversation_id = ? AND status = 'working' AND assignee_kind = 'agent' LIMIT ${PER_CHAT}`, [chat],
    );
    for (const row of rows) settle(toTask(row));
  }
  return settled;
}
