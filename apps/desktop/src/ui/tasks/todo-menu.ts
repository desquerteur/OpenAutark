// The ONE menu of a to-do (My day rows): Snooze · Show as… (the widget) · Open in chat · Stop repeating · Send to
// team (the person's own to-do) · Done · Can't do this… · Remove. Text only; the calendar's blocks open the same
// menu for their to-do. HumanItem owns what Done, Can't do this and Remove send (the callbacks).
// Owns: the items and what Snooze, Show as, Stop repeating and Send to team call. Never: settles a to-do itself.

import type { MenuItem, MenuSection } from '../lib/popover.tsx';
import type { TaskView } from '../../shared/model/tasks.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import { settings, todos, upsertById } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { sendToTeam, snoozeTodo } from '../day/day-actions.ts';
import { showAsOptions } from './todo-model.ts';
import { snoozeChoices } from './todo-time.ts';
import { canOpenChat, openTaskInChat } from './jump.ts';
import { putTask } from './task-cache.ts';
import { todoActions } from './todo-actions.ts';

export interface TodoMenuHandlers {
  onMarkDone: () => void;
  onDecline: () => void;
  onRemove: () => void;
}

async function changeWidget(task: TaskView, type: string): Promise<void> {
  try {
    const view = await rpc.call('todos.changeWidget', { id: task.id, type });
    upsertById(todos, view);
    putTask(view);
  } catch (error) { toastError(error, 'Could not switch the widget'); }
}

async function stopRepeating(task: TaskView): Promise<void> {
  try { putTask(await rpc.call('todos.stopRepeating', { id: task.id })); } catch (error) { toastError(error, 'Could not stop the reminder'); }
}

export function todoMenu(task: TaskView, handlers: TodoMenuHandlers): MenuSection[] {
  const actions = todoActions(task);
  const sections: MenuSection[] = [];
  if (actions.snooze) {
    const workStart = daySettingsOf(settings.value ?? undefined).workStart;
    sections.push({ title: 'Snooze', items: snoozeChoices(Date.now(), workStart).map((choice) => ({ label: choice.label, onSelect: () => void snoozeTodo(task, choice.until) })) });
  }
  const options = showAsOptions(task);
  if (options.length) {
    sections.push({
      title: 'Show as',
      items: options.map((option) => ({ label: option.label, checked: task.widget?.type === option.type, onSelect: () => { if (task.widget?.type !== option.type) void changeWidget(task, option.type); } })),
    });
  }
  const more: MenuItem[] = [];
  if (canOpenChat(task.conversationId)) more.push({ label: 'Open in chat', onSelect: () => openTaskInChat(task) });
  if (task.widget?.type === 'timer' && task.widget.repeat) more.push({ label: 'Stop repeating', onSelect: () => void stopRepeating(task) });
  if (actions.sendToTeam) more.push({ label: 'Send to team', onSelect: () => void sendToTeam(task) });
  sections.push({ items: more });
  sections.push({ items: [
    ...(actions.markDone ? [{ label: 'Done', onSelect: handlers.onMarkDone }] : []),
    ...(actions.decline ? [{ label: "Can't do this…", onSelect: handlers.onDecline }] : []),
    ...(actions.remove ? [{ label: 'Remove', danger: true, onSelect: handlers.onRemove }] : []),
  ] });
  return sections;
}
