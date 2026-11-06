// Task dependencies (Task.dependsOn): a task that comes after other tasks. While one of them is unfinished it is 'waiting' on
// them (waitingOn kind 'task') and nobody is woken for it; when the last one is done, cancelled or removed it opens again
// with a quiet "Ready: …" line and its owner is woken with how it ended. It orders work and holds nothing back: anyone may
// set such a task to working at any time, and then it only hears when the last one ends.
// Owns: the checks of a list, the wait it causes and its release. Never: replaces another wait (the person, a schedule,
// something external) or a pause, or wakes anyone for a task that was finished meanwhile.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { isPaused } from '../../shared/model/task-pause.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Task, TaskStatus } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';
import { waitedIds, wakeOwner } from './transitions.ts';

export const MAX_DEPENDS = 20;
const MAX_WALK = 1000;
const FINISHED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);

type Repo = Pick<TaskServiceImpl['repo'], 'get'>;

/** The list to store for task `id` (undefined: not created yet) under `parentId`: known tasks, none it is part of, no loop. */
export function checkDepends(repo: Repo, id: string | undefined, parentId: string | undefined, ids: readonly string[]): string[] {
  const list = [...new Set(ids)];
  if (list.length > MAX_DEPENDS) throw new WorkforceError('bad_request', `A task can come after at most ${MAX_DEPENDS} tasks.`);
  for (const given of list) if (!repo.get(given)) throw new WorkforceError('not_found', `Task ${given} not found.`, { details: { taskId: given } });
  const seen = new Set<string>();
  const queue = [...list];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > MAX_WALK) throw new WorkforceError('bad_request', 'This chain of tasks is too long to check.');
    if (next === id || next === parentId) throw new WorkforceError('bad_request', 'A task cannot come after itself or after a task it is part of.');
    queue.push(...(repo.get(next)?.dependsOn ?? []));
  }
  return list;
}

/** What is still unfinished of `ids`. */
function unfinished(repo: Repo, ids: readonly string[]): Task[] {
  return ids.flatMap((id) => { const task = repo.get(id); return task && !FINISHED.has(task.status) ? [task] : []; });
}

const waitingOnTasks = (task: Task): boolean => task.status === 'waiting' && task.waitingOn?.kind === 'task';

const ending = (draft: Task): void => { delete draft.waitingOn; draft.status = draft.startedAt === undefined ? 'open' : 'working'; };

/** Sets the list on a task about to be written: an open one waits while one is unfinished; a list with nothing left ends that wait. True when it ended. */
export function applyDepends(repo: Repo, draft: Task, ids: readonly string[], now: number): boolean {
  const delegated = waitingOnTasks(draft) ? waitedIds(draft.waitingOn).filter((id) => !draft.dependsOn?.includes(id)) : []; // children waited on stay waited on
  if (ids.length) draft.dependsOn = [...ids]; else delete draft.dependsOn;
  const left = unfinished(repo, [...new Set([...ids, ...delegated])]);
  if (left.length) {
    if (draft.status !== 'open' && !waitingOnTasks(draft)) return false;
    draft.status = 'waiting';
    draft.waitingOn = { kind: 'task', id: left.at(-1)!.id, ids: left.map((task) => task.id), reason: `After: ${left.map((task) => excerpt(task.title, 60)).join(', ')}`, since: now };
    return false;
  }
  if (!waitingOnTasks(draft)) return false;
  ending(draft);
  return true;
}

/** A task's wait just ended: the line, the event and whoever works on it next. */
export function dependsReleased(t: TaskServiceImpl, task: Task, note?: string): void {
  t.line(task, { type: 'note', text: `Ready: ${excerpt(task.title, 60)}`, details: { taskId: task.id } }, SYSTEM_ID);
  t.emit(task);
  if (task.assigneeKind === 'agent') wakeOwner(t, task, note ? { note } : {});
  else t.life.created(task);
}

/** One task coming after `ended`: it waits for one less, or goes on. */
function stepOn(t: TaskServiceImpl, task: Task, ended: Task, how: 'done' | 'cancelled' | 'removed'): void {
  const waited = waitingOnTasks(task);
  const left = unfinished(t.repo, [...new Set([...(task.dependsOn ?? []), ...(waited ? waitedIds(task.waitingOn) : [])])]); // delegated children may be waited on beside them
  if (left.length) {
    if (waited) t.emit(t.mutate(task.id, (draft) => { draft.waitingOn = { ...draft.waitingOn!, id: left.at(-1)!.id, ids: left.map((item) => item.id) }; }));
    return;
  }
  const word = how === 'done' ? `done${ended.result?.summary ? `: ${excerpt(ended.result.summary, 400)}` : ''}` : how;
  const note = `"${excerpt(ended.title, 80)}", which this task comes after, is ${word}. Nothing else is ahead of it.`;
  if (waited) dependsReleased(t, t.mutate(task.id, ending), note);
  else wakeOwner(t, task, { note });
}

/** `ended` finished or went: everything that comes after it hears. */
export function dependencyEnded(t: TaskServiceImpl, ended: Task, how: 'done' | 'cancelled' | 'removed'): void {
  for (const task of t.repo.dependents(ended.id)) {
    if (isPaused(task)) continue; // the end of the pause wakes the owner
    try { stepOn(t, task, ended, how); } catch (error) {
      t.s.log?.warn('a task coming after another was not released', { taskId: task.id, after: ended.id, error: String(error) });
    }
  }
}
