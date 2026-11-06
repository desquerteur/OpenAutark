// Honest asks (B-078, live analysis 06.11.): a newer open question of the same agent to the same person at the same
// place (chat and parent task) replaces its older ones – they end quietly as cancelled ("Replaced by a newer question"), with no
// status line and no wake, so the person's list holds only what is still asked. What the same turn asked stays
// (several questions of one message or one run belong together), and so do reminders (timers ring on their own)
// and mini-app to-dos (they hold the person's work).
// Owns: that rule (one indexed query per new agent ask in a chat). Never: touches the host's, the person's or a
// colleague's to-dos, or one of another chat or another parent task.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { toTask } from './repo.ts';
import { dropTimers } from './timers.ts';
import { withFact } from './owners.ts';

export const REPLACED_NOTE = 'Replaced by a newer question';
/** Widgets that are no question of their own: a reminder rings, a mini-app holds the person's work. */
const KEEP_TYPES = ['timer', 'app'];

/** The creating agent's running turn in that chat started at (else now: only asks of earlier turns are replaced). */
function turnStart(t: TaskServiceImpl, agentId: string, conversationId: string, now: number): number {
  try {
    const run = t.s.dispatcher?.activity().find((entry) => entry.agentId === agentId && entry.conversationId === conversationId && !entry.split);
    return run ? Math.min(run.startedAt, now) : now;
  } catch { return now; }
}

/** `task` is a new to-do: the same agent's older open asks at the same place end. Returns how many ended. */
export function supersedeAsks(t: TaskServiceImpl, task: Task): number {
  const by = task.createdBy;
  if (task.assigneeKind !== 'human' || !task.widget || !task.conversationId) return 0;
  if (by === HUMAN_ID || by === SYSTEM_ID || isPersonId(by)) return 0;
  if (KEEP_TYPES.includes(String(task.widget.type))) return 0;
  const now = t.s.clock.now();
  const before = turnStart(t, by, task.conversationId, now);
  const rows = t.s.db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE conversation_id = ? AND created_by = ? AND assignee_kind = 'human' AND id != ?
       AND COALESCE(assignee_id, '') = ? AND status NOT IN ('done', 'cancelled') AND widget IS NOT NULL AND parent_id IS ? AND created_at < ?
       AND (message_id IS NULL OR message_id IS NOT ?) AND COALESCE(json_extract(widget, '$.type'), '') NOT IN ('timer', 'app')
     ORDER BY created_at LIMIT 20`,
    [task.conversationId, by, task.id, task.assigneeId ?? '', task.parentId ?? null, before, task.messageId ?? null],
  );
  let ended = 0;
  for (const old of rows.map(toTask)) {
    try {
      const cancelled = t.mutate(old.id, (draft: Task) => {
        draft.status = 'cancelled';
        draft.completedAt = now;
        delete draft.waitingOn;
        draft.ledger = { ...withFact(draft, REPLACED_NOTE), cancelledBy: by };
      });
      dropTimers(t.s, old.id, true);
      t.s.wakes.cancelTask(old.id);
      t.emit(cancelled);
      ended++;
    } catch (error) {
      t.s.log?.warn('replacing an older ask failed', { taskId: old.id, error: String(error) });
    }
  }
  return ended;
}
