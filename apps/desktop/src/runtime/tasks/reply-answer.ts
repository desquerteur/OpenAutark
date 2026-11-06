// A typed reply answers the ask (B-078 D9): when the person writes a text line as a reply (replyTo) to an agent's
// message that open to-dos of theirs are anchored to – its important ask blocks, a human.ask card – the one to-do the
// line answers (answeredTodo: one ask per reply, never two with the same text) is done with their text ({text}). Their line is the answer: no receipt is posted and nobody is woken
// here (the line itself reaches the agent through the chat like any line). The AskStrip's buttons put an option
// into the composer as such a reply, so a sent strip answer lands here too.
// Wired through the bus in tasks/service.ts (message.created), not in the chat service.
// Owns: that rule. Never: answers on a side remark (only a direct reply to that very message), a reminder (timer), a
// mini-app's to-do (its app hands back its data), the host's bound to-dos or another person's to-do.

import { HUMAN_ID } from '../../shared/ids.ts';
import { oneLine } from '../../shared/blocks/answer-text.ts';
import { YES_NO, isHostBoundTodo, isImportantAsk } from '../../shared/blocks/catalog.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { toTask } from './repo.ts';

/** Widgets a typed line does not answer: a reminder rings, a mini-app hands back its own data. */
const NOT_BY_TEXT = new Set(['timer', 'app']);

/** The open to-dos anchored to `messageId` that `personId` answers (the owner's, or that colleague's own). */
export function repliedTodos(t: TaskServiceImpl, conversationId: string, messageId: string, personId: string): Task[] {
  const rows = t.s.db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE conversation_id = ? AND message_id = ? AND assignee_kind = 'human'
       AND status NOT IN ('done', 'cancelled') AND widget IS NOT NULL ORDER BY created_at LIMIT 10`,
    [conversationId, messageId],
  );
  return rows.map(toTask).filter((task) => {
    if (NOT_BY_TEXT.has(String(task.widget?.type)) || isHostBoundTodo(task)) return false;
    const owner = task.assigneeId && task.assigneeId !== HUMAN_ID ? task.assigneeId : HUMAN_ID;
    return owner === personId;
  });
}

/** The quick answers a widget offers as plain labels (a choice's options, a confirm's label, an approve's Yes / No). */
function answerLabels(widget: Task['widget']): string[] {
  if (!widget) return [];
  if (widget.type === 'choice' && Array.isArray(widget.options)) {
    return widget.options.map((option) => (typeof option === 'string' ? option : String((option as { label?: unknown })?.label ?? '')));
  }
  if (widget.type === 'confirm') return [typeof widget.confirmLabel === 'string' && widget.confirmLabel.trim() ? widget.confirmLabel : 'Done'];
  if (widget.type === 'approve') return [...YES_NO];
  return [];
}

/**
 * The one to-do a reply answers: the only one anchored there; with several, the one whose quick answer the line is
 * (a tie goes to the newest important one – the one the AskStrip shows). Free text to a message with several asks
 * answers none: the line reaches the asking agent, who sorts it out.
 */
export function answeredTodo(todos: readonly Task[], text: string): Task | undefined {
  if (todos.length <= 1) return todos[0];
  const said = text.trim().toLowerCase();
  const matching = todos.filter((todo) => answerLabels(todo.widget).some((label) => label.trim().toLowerCase() === said));
  if (matching.length <= 1) return matching[0];
  const important = matching.filter((todo) => todo.priority >= 1 || isImportantAsk(todo.widget ?? {}));
  return (important.length ? important : matching).at(-1);
}

/** message.created: the person's text reply to a message with an open ask completes that one with the text. */
export function answerByReply(t: TaskServiceImpl, message: Message): void {
  if (message.kind !== 'text' || !message.replyTo || !isHumanActor(message.authorId)) return;
  const text = message.body.trim();
  if (!text) return;
  let todos: Task[];
  try { todos = repliedTodos(t, message.conversationId, message.replyTo, message.authorId); } catch { return; }
  const todo = answeredTodo(todos, text);
  if (todo) {
    try {
      t.complete(todo.id, { summary: oneLine(text), evidence: [], verification: 'reported_by_human', answer: { text } }, message.authorId);
    } catch (error) {
      t.s.log?.warn('answering an ask by reply failed', { taskId: todo.id, error: String(error) });
    }
  }
}
