// Declining and removing to-dos (F06).
// "Can't do this…": the person declines a to-do, with an optional one-line reason. It is an answer
// {declined: true, reason} (shared/model/tasks.ts DeclineAnswer) through TaskService.answer.
// Its entry point decides whether an answer declines (declineFrom): todos.decline says so
// (decline: true); without that flag only a catalog widget's to-do takes the exact shape (catalog
// widgets never answer in it) – a mini-app's data never declines:
// the app is the agent's code, its wf.complete({declined: true}) stays an ordinary answer.
// The to-do is cancelled with the result {summary 'Declined: …', answer {declined,
// reason}}; the person's line "I can't do this: <reason>" follows as a reply to the ask (only in a chat – B-054: a
// chat-free to-do keeps it on its row and its author's wake carries it) and the author is woken as for any line of
// theirs (tasks/answer-receipt.ts). A declined step of
// agent work adds a ledger fact to that task ("find a way without them"); the task itself continues at once (tasks/transitions.ts: its last human step settled). A repeated
// decline returns the same to-do. Binding approvals of the host keep their own Allow / Deny.
// Remove: only a to-do the person added (createdBy human) is deleted (TaskService.remove).
// Owns: these two flows. Never: declines a host approval, wakes an archived or unknown agent,
// or deletes a to-do an agent or the host created.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { DeclineAnswer, Task, TaskResult, TaskView } from '../../shared/model/tasks.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import type { TaskService } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { withFact } from './owners.ts';
import { declineText, oneLine } from '../../shared/blocks/answer-text.ts';
import { postAnswer } from './answer-receipt.ts';

export const DECLINED = 'Declined';
/** A reason is one line; longer text is cut. */
export const MAX_DECLINE_REASON = 500;
const FINISHED = new Set<Task['status']>(['done', 'cancelled']);
const DECLINE_FACT = 'The person declined "';

/** The decline answer – exactly {declined: true} plus an optional text reason; anything else is a normal answer. */
export function declineOf(answer: unknown): DeclineAnswer | undefined {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
  const a = answer as Record<string, unknown>;
  if (a.declined !== true || Object.keys(a).some((key) => key !== 'declined' && key !== 'reason')) return undefined;
  if (a.reason !== undefined && a.reason !== null && typeof a.reason !== 'string') return undefined;
  const reason = typeof a.reason === 'string' ? a.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_DECLINE_REASON) : '';
  return reason ? { declined: true, reason } : { declined: true };
}

/**
 * The decline an answer carries, by its entry point (see the header): `decline` (todos.decline)
 * always declines; without it a mini-app to-do's answer never does, any other to-do's only in
 * the exact decline shape.
 */
export function declineFrom(input: { answer: unknown; decline?: boolean }, task?: Task): DeclineAnswer | undefined {
  if (input.decline === true) return declineOf(input.answer) ?? { declined: true };
  return appWidgetOf(task?.widget) ? undefined : declineOf(input.answer);
}

/** The answer todos.decline sends. */
export function declineAnswer(reason?: string): DeclineAnswer {
  return declineOf({ declined: true, reason: reason ?? '' })!;
}

export interface DeclineContext {
  task?: Task;
  /** The message that asked (ask block or anchor). */
  message?: Message;
  conversationId?: string;
  blockKey: string;
  by: string;
  clientId?: string;
}

/** The person declines the to-do (see the header). */
export function declineTodo(t: TaskServiceImpl, at: DeclineContext, decline: DeclineAnswer): TaskView {
  const task = at.task;
  if (!task) throw new WorkforceError('bad_request', 'Only a to-do can be declined.');
  if (task.status === 'cancelled' && declineOf(task.result?.answer)) return t.views([task])[0]; // a repeated decline
  if (task.assigneeKind !== 'human') throw new WorkforceError('bad_request', 'Only to-dos can be declined.');
  if (FINISHED.has(task.status)) throw new WorkforceError('conflict', 'This to-do is already finished.');
  const summary = decline.reason ? `${DECLINED}: ${excerpt(decline.reason, 200)}` : DECLINED;
  const result: TaskResult = { summary, evidence: [{ kind: 'note', label: summary }], verification: 'reported_by_human', answer: decline };
  const s = t.s;
  s.db.tx(() => {
    t.mutate(task.id, (draft) => { draft.result = result; });
    markParent(t, task, decline);
    t.setStatus(task.id, 'cancelled', at.by, DECLINED); // timers, wakes and the waiting parent follow (lifecycle.ts)
  });
  // After the status change: cancelling drops the to-do's queued wakes, the author's wake is new.
  const text = declineText(decline.reason); // the person's words: "I can't do this: <reason>"
  postAnswer(s, {
    conversationId: at.conversationId ?? task.conversationId, text, summary: oneLine(text), question: task.title, by: at.by, message: at.message, task,
    blockKey: at.blockKey, receiptKey: at.blockKey, clientId: at.clientId, wake: true,
  });
  return t.get(task.id)!;
}

/** The declined to-do is a step of agent work: that task keeps a fact the owner sees in its task text. */
function markParent(t: TaskServiceImpl, todo: Task, decline: DeclineAnswer): void {
  const parent = todo.parentId ? t.repo.get(todo.parentId) : undefined;
  if (!parent || parent.assigneeKind === 'human' || FINISHED.has(parent.status)) return;
  const fact = `${DECLINE_FACT}${excerpt(todo.title, 80)}"${decline.reason ? `: ${excerpt(decline.reason, 200)}` : ''}. I find a way without them.`;
  t.mutate(parent.id, (draft) => { draft.ledger = withFact(draft, fact); });
}

/** Remove: only a to-do the person added; agents' and the host's to-dos are declined instead. */
export function removeTodo(tasks: Pick<TaskService, 'get' | 'remove'>, id: string): void {
  const task = tasks.get(id);
  if (!task) throw new WorkforceError('not_found', 'To-do not found.', { details: { taskId: id } });
  if (task.assigneeKind !== 'human' || task.createdBy !== HUMAN_ID) {
    throw new WorkforceError('forbidden', "Only to-dos you added can be removed. Use \"Can't do this…\" for the others.", { details: { taskId: id } });
  }
  tasks.remove(id, HUMAN_ID);
}
