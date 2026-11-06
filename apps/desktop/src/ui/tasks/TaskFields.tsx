// The one editable field of the task detail: the title (B-078 D10 – owner, due, priority, done-when and notes
// editing are gone from the UI; the agents set them with their tools and the person says it in the reply). A change
// is one tasks.update with the task's rev, so a concurrent change by an agent is never silently overwritten.
// Owns: the title editor and the update call. Never: changes status (the task menu does) or task results.

import { useEffect, useState } from 'preact/hooks';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { putTask } from './task-cache.ts';

type Patch = Partial<Pick<Task, 'title' | 'notes' | 'dueAt' | 'priority' | 'doneWhen' | 'assigneeKind' | 'assigneeId'>>;

export async function updateTask(task: TaskView, patch: Patch, guardRev = false): Promise<boolean> {
  try {
    putTask(await rpc.call('tasks.update', { id: task.id, ...(guardRev ? { rev: task.rev } : {}), patch }));
    return true;
  } catch (error) {
    toastError(error, 'Could not save');
    return false;
  }
}

/** Title: edit in place, commits on Enter/blur, Escape restores. */
export function TitleField(props: { task: TaskView }) {
  const { task } = props;
  const [draft, setDraft] = useState(task.title);
  useEffect(() => setDraft(task.title), [task.title]);
  const commit = () => {
    const value = draft.trim();
    if (!value) { setDraft(task.title); return; }
    if (value !== task.title) void updateTask(task, { title: value }, true);
  };
  return (
    <input class="task-title-input" type="text" value={draft} maxLength={300} aria-label="Title"
      onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
        if (event.key === 'Escape') { setDraft(task.title); (event.currentTarget as HTMLInputElement).blur(); }
      }} />
  );
}
