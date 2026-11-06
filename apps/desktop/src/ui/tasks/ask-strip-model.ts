// The strip above the chat composer (B-078 D9, ui/chat/AskStrip.tsx), pure: which important question it shows and
// which quick answers it offers. The question: the newest open important to-do (priority ≥ 1 or an "important" ask
// block) that is anchored to a message in a chat – this chat's first, else the newest of any chat. The answers: a
// choice's options, a confirm's label, an older approve card's Yes / No (at most STRIP_ANSWERS); every other widget
// only offers the reply.
// Owns: these rules (unit-tested in test/unit/task-center/ask-strip.test.ts). Never: imports the store, rpc or the DOM.

import type { TaskView } from '../../shared/model/tasks.ts';
import { YES_NO, isImportantAsk } from '../../shared/blocks/catalog.ts';

/** At most this many answer buttons (the strip keeps one fixed line). */
export const STRIP_ANSWERS = 3;

type StripTodo = Pick<TaskView, 'id' | 'status' | 'priority' | 'widget' | 'messageId' | 'conversationId' | 'createdAt' | 'assigneeKind'>;

/** Open, important and anchored to a chat message. */
export function isStripAsk(todo: StripTodo): boolean {
  if (todo.assigneeKind !== 'human' || todo.status === 'done' || todo.status === 'cancelled') return false;
  if (!todo.messageId || !todo.conversationId || String(todo.widget?.type) === 'app') return false;
  return todo.priority >= 1 || isImportantAsk(todo.widget ?? {});
}

/** The to-do the strip shows in `conversationId`: this chat's newest important ask, else the newest of any chat. */
export function stripAsk<T extends StripTodo>(todos: readonly T[], conversationId: string): T | undefined {
  const open = todos.filter(isStripAsk).sort((a, b) => b.createdAt - a.createdAt);
  return open.find((todo) => todo.conversationId === conversationId) ?? open[0];
}

/** The quick answers the strip offers for a widget (each fills the composer as a reply; the person sends). */
export function stripAnswers(widget: TaskView['widget']): string[] {
  if (!widget) return [];
  switch (widget.type) {
    case 'choice': {
      const options = Array.isArray(widget.options) ? widget.options : [];
      return options.map((option) => (typeof option === 'string' ? option : String((option as { label?: unknown })?.label ?? '')))
        .map((label) => label.trim()).filter(Boolean).slice(0, STRIP_ANSWERS);
    }
    case 'confirm': return [typeof widget.confirmLabel === 'string' && widget.confirmLabel.trim() ? widget.confirmLabel.trim() : 'Done'];
    case 'approve': return [...YES_NO];
    default: return [];
  }
}
