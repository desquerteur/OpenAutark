// The quiet actions a My day item offers in its menu besides its widget (F06, B-041):
// - "Can't do this…" for every open to-do the person did not add (an agent's or the host's);
// - "Remove" only for to-dos the person added (todos.remove refuses the others);
// - "Done" for an agent's mini-app to-do: its app may never call wf.complete (broken HTML, its message
//   deleted, a phone that cannot run it), so the person can still finish it; the takes the app registered
//   still go to the agent (X03, tasks/answer-files.ts);
// - "Snooze" for every open to-do (the runtime snoozes any to-do, tasks/human.ts snooze);
// - "Send to team" for the person's own top-level to-do (day.sendToTeam: Inbox → router) – not a timer, which
//   stays with the person (the runtime refuses it, day/handed-off.ts).
// And the row's check (B-041 §4.1): which to-dos a single tick finishes, and with what answer – a plain to-do,
// a confirmation, a reminder (a repeating one then waits for its next ring) and a checklist (all items); a
// question, form, upload, recording, review or mini-app needs its widget, so it has no check.
// Used by tasks/todo-menu.ts, tasks/HumanItem.tsx and the calendar's blocks. Owns: that choice. Never: calls
// rpc or touches the DOM.

import { HUMAN_ID } from '../../shared/ids.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

export interface TodoActions {
  decline: boolean;
  remove: boolean;
  markDone: boolean;
  snooze: boolean;
  sendToTeam: boolean;
}

const FINISHED = new Set<TaskView['status']>(['done', 'cancelled']);

export function todoActions(task: Pick<TaskView, 'assigneeKind' | 'createdBy' | 'widget' | 'status'> & Partial<Pick<TaskView, 'parentId'>>): TodoActions {
  const open = task.assigneeKind === 'human' && !FINISHED.has(task.status);
  const mine = task.createdBy === HUMAN_ID;
  const app = Boolean(appWidgetOf(task.widget));
  return {
    decline: open && !mine,
    remove: task.assigneeKind === 'human' && mine,
    markDone: open && app,
    snooze: open,
    sendToTeam: open && mine && !task.parentId && !app && task.status !== 'waiting' && task.widget?.type !== 'timer',
  };
}

/** What the row's check sends as the answer (tasks.complete); `answer` undefined = a plain "Done". */
export interface CheckAnswer { answer?: unknown }

/** The answer a single tick gives this to-do, or undefined when only its widget can finish it. */
export function checkAnswer(task: Pick<TaskView, 'assigneeKind' | 'createdBy' | 'widget' | 'status'>): CheckAnswer | undefined {
  if (task.assigneeKind !== 'human' || FINISHED.has(task.status) || appWidgetOf(task.widget)) return undefined;
  const widget = task.widget;
  switch (widget?.type) {
    case undefined: return {};
    case 'confirm': return { answer: { done: true } };
    case 'timer': return { answer: { event: 'done' } };
    case 'checklist': {
      const items = Array.isArray(widget.items) ? widget.items : [];
      const texts = items.map((item: unknown) => (typeof item === 'string' ? item : typeof (item as { text?: unknown })?.text === 'string' ? (item as { text: string }).text : '')).filter(Boolean);
      return { answer: { checked: texts, open: [] } };
    }
    default: return undefined;
  }
}
