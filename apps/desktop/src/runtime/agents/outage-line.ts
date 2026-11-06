// The quiet line a task's work leaves when it pauses for an outage (T06): "Paused: … – continues
// by itself", once per outage – not again while it lasts (the task's previous turn met it
// already) – instead of a failed agent bubble on every retry. The one implementation, for turns
// that fail before the engine (agents/turn.ts) and engine outages (agents/turn-finish.ts).
// B-054: a chat-free task writes no status line (its history is its ledger and its runs).
// B-059 #86: the line carries meta.fromRun – the run that met the outage – so the chat can fold it under that run.
// Owns: that line and its dedupe. Never: decides what an outage is (agents/outages.ts isOutage),
// plans a retry, posts an agent message or writes into a chat the task does not have.

import type { RuntimeServices } from '../contracts.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isOutage } from './outages.ts';

/** `task` is the snapshot before this turn (its ledger's last outcome decides the dedupe); `runId`: the run that met the outage (meta.fromRun). */
export function outageLine(services: Pick<RuntimeServices, 'chats'>, task: Pick<TaskView, 'id' | 'conversationId' | 'ledger'>, reason: string | undefined, runId?: string): void {
  if (!task.conversationId) return; // B-054: no chat, no status line
  const last = task.ledger.tried?.at(-1)?.outcome;
  if (last && isOutage(last)) return; // the previous turn already met this outage
  try {
    services.chats.status(task.conversationId, {
      type: 'note', text: `Paused: ${excerpt(reason ?? 'no model could be reached', 90)} – continues by itself`, details: { taskId: task.id, outage: true },
    }, { authorId: SYSTEM_ID, taskId: task.id, ...(runId ? { fromRun: runId } : {}) });
  } catch { /* cosmetic */ }
}
