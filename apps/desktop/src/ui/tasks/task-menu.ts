// The ONE menu of a task (Work rows, the open task's name dropdown, the task bubble in a chat): Open · Open in
// chat · Give to me · Send to… (any unfinished work: agents, teams, people) · Resume · Done · Reopen · Cancel · Delete. Text only.
// Owns: which items a task offers and what each one sends. Never: draws the menu (lib/context-menu.tsx) or
// settles agent work as verified.

import type { MenuSection } from '../lib/popover.tsx';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import { newId } from '../../shared/ids.ts';
import { confirm } from '../lib/dialog.tsx';
import { rpc } from '../lib/rpc.ts';
import { agents, removeById, tasks, todos } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { recipientGroups } from './center-model.ts';
import { recipientPeople } from './RecipientMenu.tsx';
import { canOpenChat, closeTask, openTaskDetail, openTaskInChat, selectedTaskId } from './jump.ts';
import { hasNoOwner, isFinished, ownerOf } from './model.ts';
import { putTask } from './task-cache.ts';
import { canResume } from './waiting.ts';

async function run(call: () => Promise<TaskView | void>, failTitle: string): Promise<void> {
  try {
    const view = await call();
    if (view) putTask(view);
  } catch (error) {
    toastError(error, failTitle);
  }
}

async function cancelTask(task: TaskView): Promise<void> {
  if (!(await confirm({ title: 'Cancel this task?', body: task.title, confirmLabel: 'Cancel task' }))) return;
  await run(() => rpc.call('tasks.setStatus', { id: task.id, status: 'cancelled' }), 'Could not cancel');
}

async function deleteTask(task: TaskView): Promise<void> {
  if (!(await confirm({ title: 'Delete this task?', body: task.conversationId ? 'The task message and its steps are removed from the chat.' : 'The task and its steps are removed.', confirmLabel: 'Delete', danger: true }))) return;
  await run(async () => {
    await rpc.call('tasks.delete', { id: task.id });
    removeById(tasks, task.id);
    removeById(todos, task.id);
    if (selectedTaskId.peek() === task.id) closeTask();
  }, 'Could not delete');
}

const route = (task: TaskView, target?: QuickTaskTarget) => run(() => rpc.call('tasks.route', { id: task.id, ...(target ? { target } : {}) }), 'Could not find an owner');

/** A person (F-52, the owner's session only) gets the work as their own: the owner field changes, nothing routes. */
const giveToPerson = (task: TaskView, personId: string) => run(() => rpc.call('tasks.update', { id: task.id, patch: { assigneeKind: 'human', assigneeId: personId } }), 'Could not send it');

/**
 * "Send to…" for every unfinished task (B-078: the reassigning the detail's Owner box did): "Find an owner" for work
 * nobody has yet, then the agents, teams and – in the owner's session – the active people; the current owner is left out.
 */
function sendTo(task: TaskView): MenuSection[] {
  if (isFinished(task.status)) return [];
  const owner = ownerOf(task);
  const groups = recipientGroups(agents.value, recipientPeople(true));
  const current = (target: QuickTaskTarget) => 'id' in owner && owner.kind === target.kind && owner.id === target.id;
  const item = (recipient: { label: string; hint?: string; target: QuickTaskTarget }) => ({
    label: recipient.label, hint: recipient.hint,
    onSelect: () => void (recipient.target.kind === 'person' ? giveToPerson(task, recipient.target.id) : route(task, recipient.target)),
  });
  const pick = (list: ReadonlyArray<{ label: string; hint?: string; target: QuickTaskTarget }>) => list.filter((recipient) => !current(recipient.target)).map(item);
  const sections: MenuSection[] = [
    { title: 'Send to…', items: [...(hasNoOwner(task) ? [{ label: 'Find an owner', onSelect: () => void route(task) }] : []), ...pick(groups.agents)] },
    { title: 'Teams', items: pick(groups.teams) },
    { title: 'People', items: pick(groups.people) },
  ];
  return sections.filter((section) => section.items.length > 0);
}

export function taskMenu(task: TaskView): MenuSection[] {
  const finished = isFinished(task.status);
  const mine = ownerOf(task).kind === 'human';
  return [
    { items: [
      { label: 'Open', onSelect: () => openTaskDetail(task.id) },
      ...(canOpenChat(task.conversationId) ? [{ label: 'Open in chat', onSelect: () => openTaskInChat(task) }] : []),
    ] },
    ...(finished ? [] : [{ items: mine ? [] : [{ label: 'Give to me', onSelect: () => void run(() => rpc.call('tasks.makeMine', { id: task.id }), 'Could not give it to you') }] }]),
    ...sendTo(task),
    { items: [
      ...(canResume(task) ? [{ label: 'Resume', onSelect: () => void run(() => rpc.call('tasks.setStatus', { id: task.id, status: 'working' }), 'Could not resume') }] : []),
      ...(!finished && mine && !task.widget ? [{ label: 'Done', onSelect: () => void run(() => rpc.call('tasks.complete', { id: task.id, clientId: newId('up') }), 'Could not complete') }] : []),
      ...(finished ? [{ label: 'Reopen', onSelect: () => void run(() => rpc.call('tasks.setStatus', { id: task.id, status: 'open' }), 'Could not reopen') }] : [{ label: 'Cancel', onSelect: () => void cancelTask(task) }]),
      { label: 'Delete', danger: true, onSelect: () => void deleteTask(task) },
    ] },
  ];
}
