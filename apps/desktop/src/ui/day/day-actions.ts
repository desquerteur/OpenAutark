// My day's calls (B-041 contract §3), each with its calm failure toast: tick a to-do off, snooze it, hand it to the
// team, add text through the My day input (day.add) or into a calendar slot (calendar.add) and move or unplan a
// block. A fresh view goes into the store and the task cache at once; the events follow anyway.
// Owns: these calls. Never: decides groups, renders, or retries a refused call.

import type { CalendarEvent } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { onForYouList } from '../../shared/model/todo-later.ts';
import { calendarWindow, withEvent, withoutEvent } from '../lib/day-store.ts';
import { rpc } from '../lib/rpc.ts';
import { removeById, todos, upsertById } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { putTask } from '../tasks/task-cache.ts';
import { checkAnswer } from '../tasks/todo-actions.ts';
import { whenText } from '../tasks/todo-time.ts';

/** A fresh view from a call: kept on the list while it belongs there, else it leaves at once. */
export function applyTodo(view: TaskView): void {
  putTask(view);
  if (onForYouList(view)) upsertById(todos, view);
  else removeById(todos, view.id);
}

/** The row's (or a block's) check: finishes the to-do with the answer its widget takes. False when it failed or has no check. */
export async function checkTodo(task: TaskView): Promise<boolean> {
  const check = checkAnswer(task);
  if (!check) return false;
  try {
    applyTodo(await rpc.call('tasks.complete', { id: task.id, clientId: newId('up'), ...(check.answer === undefined ? {} : { answer: check.answer }) }));
    return true;
  } catch (error) {
    toastError(error, 'Could not complete');
    return false;
  }
}

export async function snoozeTodo(task: TaskView, until: number): Promise<void> {
  try {
    applyTodo(await rpc.call('todos.snooze', { id: task.id, until }));
    pushToast({ title: `Snoozed until ${whenText(until, Date.now())}` }, 3000);
  } catch (error) {
    toastError(error, "Couldn't snooze");
  }
}

/** "Remove" on a to-do the person added: gone at once. True when it went. */
export async function removeTodo(task: TaskView): Promise<boolean> {
  try {
    await rpc.call('todos.remove', { id: task.id });
    removeById(todos, task.id);
    return true;
  } catch (error) {
    toastError(error, 'Could not remove it');
    return false;
  }
}

export async function sendToTeam(task: TaskView): Promise<void> {
  try {
    applyTodo(await rpc.call('day.sendToTeam', { id: task.id }));
    pushToast({ title: 'Sent to the team' }, 3000);
  } catch (error) {
    toastError(error, 'Could not send it to the team');
  }
}

/** The My day input: everything stays the person's. Undefined when it failed (the text stays). */
export async function addToDay(text: string, date?: string): Promise<TaskView[] | undefined> {
  try {
    const { tasks } = await rpc.call('day.add', { text, clientId: newId('up'), ...(date ? { date } : {}) });
    for (const task of tasks) applyTodo(task);
    return tasks;
  } catch (error) {
    toastError(error, 'Could not add it');
    return undefined;
  }
}

/** Puts a changed block into the window at once (its event follows). */
function showEvent(event: CalendarEvent): void {
  const window = calendarWindow.peek();
  if (window) calendarWindow.value = withEvent(window, event);
}

/** Typed or dictated text into a free slot: the text decides event or to-do ('auto'). */
export async function addToSlot(text: string, startAt: number, endAt: number): Promise<boolean> {
  try {
    const result = await rpc.call('calendar.add', { text, startAt, endAt, kind: 'auto', clientId: newId('up') });
    showEvent(result.event);
    if (result.task) applyTodo(result.task);
    return true;
  } catch (error) {
    toastError(error, 'Could not add it');
    return false;
  }
}

/** Moves a block (it becomes the person's: the planner leaves it there). */
export async function moveBlock(event: CalendarEvent, startAt: number, endAt: number): Promise<boolean> {
  showEvent({ ...event, startAt, endAt }); // where it was dropped, until the answer
  try {
    showEvent(await rpc.call('calendar.move', { id: event.id, startAt, endAt, rev: event.rev }));
    return true;
  } catch (error) {
    showEvent(event); // back where it was
    toastError(error, 'Could not move it');
    return false;
  }
}

/** Takes a to-do's block out of the calendar (the to-do stays). */
export async function unplanBlock(event: CalendarEvent): Promise<void> {
  try {
    await rpc.call('calendar.remove', { id: event.id });
    const window = calendarWindow.peek();
    if (window) calendarWindow.value = withoutEvent(window, event.id);
  } catch (error) {
    toastError(error, 'Could not take it out of the calendar');
  }
}
