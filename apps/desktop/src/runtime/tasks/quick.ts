// Quick tasks (the person's task composer, tasks.quickCreate) and "Send to…" (tasks.route): what the person typed
// becomes ONE plain task – no router, no route records. Title = first line, notes = only the rest (B-078: no copy of
// the first line, todo-draft.ts restNotes); files are kept with the task (kv QUICK_POST_NS – a chat-free task has no anchor message to carry them).
// Who does it: the target – an agent, a manager's branch (that manager), a team (an agent of that team, the one
// highest in the org first), a person of the organisation (handed over in the owner's 1:1 chat with her as hers) or
// 'me' (the person's own to-do). Without a target it is team work: the decision model picks its owner, else the
// responsible manager is woken and decides (tasks/route-pick.ts, lifecycle.ts wakeLead). A retried post (same clientId) returns the first task.
// Owns: these two entry points. Never: calls a model or keeps a second task type.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { foldText } from '../../shared/text/normalize.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import type { CreateTaskInput, TaskView } from '../../shared/model/tasks.ts';
import type { QuickTaskParams, QuickTaskResult, QuickTaskTarget } from '../../shared/model/task-center.ts';
import type { RuntimeServices } from '../contracts.ts';
import { directChat } from '../people/direct-chat.ts';
import { KvRepo } from '../store/kv.ts';
import type { CreateOptions } from './create.ts';
import { quickDraft, restNotes } from './todo-draft.ts';

export const MAX_QUICK_TEXT = 8000;
/** kv namespace of a chat-free quick task's files (key: task id). */
export const QUICK_POST_NS = 'task_quick_post';

type Deps = Pick<RuntimeServices, 'db' | 'clock' | 'chats' | 'tasks' | 'org'>;
type CreatingTasks = { create(input: CreateTaskInput & { createdBy: string }, options?: CreateOptions): TaskView };

/** The quick task as the service gets it: the files already resolved to stored attachments. */
export type QuickInput = Omit<QuickTaskParams, 'attachments'> & { attachments?: Attachment[] };

/** The files a quick task was posted with (empty for any other task). */
export function quickFiles(db: Deps['db'], taskId: string): Attachment[] {
  try {
    const post = new KvRepo(db).get<{ attachments?: Attachment[] }>(QUICK_POST_NS, taskId);
    return Array.isArray(post?.attachments) ? post.attachments : [];
  } catch { return []; }
}

/** The agent a target names (undefined: no target, or the person). */
export function ownerOf(s: Pick<RuntimeServices, 'org'>, target: QuickTaskTarget | undefined): string | undefined {
  if (!target || target.kind === 'person' || target.kind === 'me') return undefined;
  if (target.kind === 'team') {
    const name = foldText(target.id.trim());
    const team = s.org.list().filter((agent) => agent.team && foldText(agent.team.trim()) === name);
    const first = team.sort((a, b) => s.org.managers(a.id).length - s.org.managers(b.id).length)[0];
    if (!first) throw new WorkforceError('not_found', 'No active agent is in that team.', { details: { team: target.id } });
    return first.id;
  }
  const agent = s.org.get(target.id);
  if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: target.id } });
  return agent.id;
}

/** tasks.quickCreate: one task from what the person (or an agent) typed. */
export function quickCreate(s: Deps, input: QuickInput, createdBy: string): QuickTaskResult {
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  if (!text && !attachments.length) throw new WorkforceError('bad_request', 'Type what should be done.');
  if (text.length > MAX_QUICK_TEXT) throw new WorkforceError('bad_request', 'That is too long for one task.');
  if (input.spaceId && !s.org.spaces().some((space) => space.id === input.spaceId)) {
    throw new WorkforceError('not_found', 'Space not found.', { details: { spaceId: input.spaceId } });
  }
  const tasks = s.tasks as unknown as CreatingTasks;
  const clientId = input.clientId ? `qt:${createdBy}:${input.clientId}` : undefined;
  const title = excerpt(text.split(/\r?\n/)[0].trim() || attachments[0]?.name || 'Files', 120);
  const fields = {
    title, notes: text ? restNotes(text, title) : '', createdBy,
    ...(input.priority !== undefined ? { priority: input.priority } : {}), ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
  };
  const target = input.target;
  if (target?.kind === 'person') {
    const task = tasks.create({ ...fields, conversationId: directChat(s, HUMAN_ID, target.id.trim()), assigneeKind: 'human', assigneeId: target.id.trim() }, {
      ...(clientId ? { clientId } : {}), anchorWith: { authorId: HUMAN_ID, attachments },
    });
    return { task };
  }
  const owner = ownerOf(s, target);
  const mine = target?.kind === 'me' ? quickDraft(s, text || title) : undefined;
  const task = tasks.create({
    ...fields, origin: ORIGINS.intake, ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(mine ? { assigneeKind: 'human', widget: mine.widget, humanReason: mine.humanReason } : owner ? { assigneeKind: 'agent', assigneeId: owner } : { assigneeKind: 'team' }),
  }, clientId ? { clientId } : {});
  if (attachments.length) new KvRepo(s.db).set(QUICK_POST_NS, task.id, { attachments }, s.clock.now());
  return { task };
}

/** tasks.route: unowned work goes to `target`, or (none) the responsible manager is woken again to decide. */
export function routeTask(s: Pick<RuntimeServices, 'tasks' | 'org'>, id: string, target: QuickTaskTarget | undefined, by: string): TaskView {
  const task = s.tasks.get(id);
  if (!task) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId: id } });
  if (task.status === 'done' || task.status === 'cancelled') throw new WorkforceError('conflict', 'This task is already finished.', { details: { taskId: id } });
  const owner = ownerOf(s, target);
  return owner ? s.tasks.assign(id, { kind: 'agent', id: owner }, by) : s.tasks.assign(id, { kind: 'team' }, by);
}
