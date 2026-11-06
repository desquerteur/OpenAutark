// TaskService ("simplified Asana"): one task model – work is a task, steps are child tasks, the person's work is a
// task owned by 'human'. Tasks are rows of their own (B-054: a chat is only where one was handed over – its anchoring
// 'task' message; chat-free tasks have none). Atomic claim, assignment (assignedBy = who assigned), status, completion
// with result, optimistic concurrency (rev), TaskView, the "For you" list. Side effects (wakes, notifications, status
// lines, the one verification step) live in tasks/lifecycle.ts; human widget flows in tasks/human.ts (arming:
// tasks/timers.ts); owner transitions (joining the chat, archived agents hand over, pause/resume after the person's
// Stop) in tasks/owners.ts; waits that end (a person's step, a delegated child) in tasks/transitions.ts. Building a
// new task lives in tasks/create.ts, completing it in tasks/complete.ts, views in tasks/views.ts. B-078: 'working' ends
// with the last live run on it (tasks/working.ts); a person's typed reply to an ask answers it (tasks/reply-answer.ts).
// Owns: every write to `tasks`/`tasks_fts` and the task events.
// Never: shows unverified work as verified or keeps a second copy of the task text outside its row.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { Message, StatusLine } from '../../shared/model/chat.ts';
import type { CreateTaskInput, Task, TaskFilter, TaskResult, TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices, TaskService } from '../contracts.ts';
import { ActivityTracker } from '../chat/activity.ts';
import { chatTitleFor } from '../chat/titles.ts';
import { TaskRepo } from './repo.ts';
import { HumanTodos } from './human.ts';
import {
  RESUMED_NOTE, changeOwner, claimedTeamWork, handOver, isPaused, pauseTask, resumeOnHumanMessage, resumeTask, routeOwner,
} from './owners.ts';
import { TaskLifecycle } from './lifecycle.ts';
import { markCancel, mergeWait, reopenFact } from './transitions.ts';
import { armTimer, dueAfter, prepareWidget } from './timers.ts';
import { checkPersonWorkFor, createTask, type CreateOptions } from './create.ts';
import { taskViews } from './views.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import { DAY_PATCH_FIELDS } from './patch-fields.ts'; // B-041 My day: estimate, focus timer, window, prep, private
import { completeTask } from './complete.ts';
import { applyDepends, checkDepends, dependsReleased } from './depends.ts';
import { answerByReply } from './reply-answer.ts';
import { settleWorking } from './working.ts';
import '../contracts/people.ts';

export type TaskDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'chats' | 'wakes'>
  & Partial<Pick<RuntimeServices, 'org' | 'subconscious' | 'scheduler' | 'notifications' | 'log' | 'dispatcher' | 'catalog' | 'people' | 'settings' | 'decisions'>>; // decisions: B-078 route-pick.ts // people (F-52): names of colleagues; settings: the owner's name in chat titles // catalog: the RT3 rating hooks (models/feedback.ts)

const PATCHABLE = new Set<keyof Task>([
  'title', 'notes', 'dueAt', 'priority', 'doneWhen', 'mode', 'sort', 'goal', 'widget', 'humanReason', 'waitingOn', 'ledger', 'attempts', ...DAY_PATCH_FIELDS,
]);

export class TaskServiceImpl implements TaskService {
  readonly s: TaskDeps;
  readonly repo: TaskRepo;
  private readonly activity: ActivityTracker;
  private readonly human: HumanTodos;
  readonly life: TaskLifecycle; // read by tasks/create.ts
  private readonly offs: Array<() => void>;

  constructor(deps: TaskDeps) {
    this.s = deps;
    this.repo = new TaskRepo(deps.db);
    this.activity = new ActivityTracker(deps.bus, ({ tasks, conversations }) => {
      const settled = settleWorking(this, tasks, conversations); // B-078: 'working' only while a run is live
      for (const id of tasks) { const task = this.repo.get(id); if (task && !settled.has(id)) this.emit(task); }
    });
    this.human = new HumanTodos(this);
    this.life = new TaskLifecycle(this);
    // An archived agent's open work moves to its successor; a human message in a chat ends the pause of the work there.
    this.offs = [
      deps.bus.on('agent.removed', ({ id }) => handOver(this, id)),
      deps.bus.on('message.created', message => resumeOnHumanMessage(this, message)),
      deps.bus.on('message.created', message => answerByReply(this, message)), // B-078: a typed reply answers the ask it replies to
    ];
  }

  // ------------------------------------------------------------- queries

  list(filter: TaskFilter = {}): TaskView[] { return this.views(this.repo.list(filter)); }
  todos(limit = 50, personId?: string): TaskView[] { return this.views(this.repo.todos(limit, personId)); }
  openFor(agentId: string): TaskView[] { return this.views(this.repo.openFor(agentId)); }

  get(id: string): TaskView | undefined {
    const task = this.repo.get(id);
    return task ? this.views([task])[0] : undefined;
  }

  // ------------------------------------------------------------- writes

  create(input: CreateTaskInput & { createdBy: string }, options: CreateOptions = {}): TaskView {
    return createTask(this, input, options);
  }

  update(id: string, patch: Partial<Task>, by: string, rev?: number): TaskView {
    const current = this.require(id);
    if (patch.widget && current.assigneeKind === 'human') {
      const armed = prepareWidget(patch.widget, this.s.clock.now(), by);
      const due = patch.dueAt === undefined ? dueAfter(current, armed) : undefined; // the old timer's due time moves with the new one
      patch = { ...patch, widget: armed.widget, ...(due !== undefined && due !== current.dueAt ? { dueAt: due } : {}) };
    }
    if (patch.assigneeKind !== undefined || patch.assigneeId !== undefined) {
      this.assign(id, { kind: patch.assigneeKind ?? current.assigneeKind, id: patch.assigneeId }, by);
    }
    if (patch.status !== undefined && (patch.status !== current.status || isPaused(current))) this.setStatus(id, patch.status, by);
    const after = patch.dependsOn ? checkDepends(this.repo, id, current.parentId, patch.dependsOn) : undefined;
    let released = false;
    const task = this.mutate(id, draft => {
      for (const key of Object.keys(patch) as Array<keyof Task>) {
        if (!PATCHABLE.has(key)) continue;
        // A second child to wait on keeps the first one (waitingOn.ids) while it is still open.
        (draft as unknown as Record<string, unknown>)[key] = key === 'waitingOn' ? mergeWait(this, draft.waitingOn, patch.waitingOn) : patch[key];
      }
      if (after) released = applyDepends(this.repo, draft, after, this.s.clock.now());
    }, rev);
    if (patch.widget) armTimer(this.s, task);
    if (released) { dependsReleased(this, task); return this.views([task])[0]; }
    return this.emit(task);
  }

  setStatus(id: string, status: TaskStatus, by: string, note?: string): TaskView {
    const before = this.require(id);
    // The human moving paused work on ends the pause; the owner continues.
    if (by === HUMAN_ID && isPaused(before) && (status === 'open' || status === 'working')) return this.resume(id, by, RESUMED_NOTE);
    if (before.status === status) return this.views([before])[0];
    if (status === 'done') {
      if (!isHumanActor(by)) throw new WorkforceError('bad_request', 'Use complete() with a result to finish a task.'); // F-52: people report like the owner
      return this.complete(id, { summary: note ?? 'Done', evidence: [], verification: 'reported_by_human' }, by);
    }
    const now = this.s.clock.now();
    const task = this.mutate(id, draft => {
      draft.status = status;
      if (status === 'working') draft.startedAt ??= now;
      if (status === 'cancelled') draft.completedAt = now;
      else delete draft.completedAt; // reopened: no longer counts as recently finished
      if (status === 'blocked' || status === 'waiting' || status === 'needs_you') {
        draft.waitingOn = draft.waitingOn ?? { kind: status === 'needs_you' ? 'human' : 'external', reason: note ?? status, since: now };
      } else if (status === 'working' || status === 'open') {
        delete draft.waitingOn;
      }
      reopenFact(draft, before.status, by, note); // the person reopening agent work is a ledger fact
      markCancel(draft, status, by);
    });
    this.life.statusChanged(task, before.status, by, note);
    const view = this.emit(task);
    this.life.humanProgress(task, by);
    return view;
  }

  claim(id: string, agentId: string): boolean {
    const now = this.s.clock.now();
    const before = this.repo.get(id);
    if (!this.repo.claim(id, agentId, now)) return false;
    const task = before?.assigneeKind === 'team' ? claimedTeamWork(this, id, agentId) : this.require(id);
    // No joinChat: claiming is self-assignment, and an agent outside the chat must not join it so.
    if (!task.parentId) this.line(task, { type: 'task_claimed', text: `${this.nameOf(agentId)} took: ${excerpt(task.title, 60)}`, details: { taskId: id, agentId } }, agentId);
    this.emit(task);
    return true;
  }

  assign(id: string, assignee: { kind: Task['assigneeKind']; id?: string }, by: string): TaskView {
    const before = this.require(id);
    if (assignee.kind === 'agent' && !assignee.id) throw new WorkforceError('bad_request', 'Assigning to an agent needs its id.');
    if (assignee.kind === 'agent' && this.s.org && !this.s.org.get(assignee.id!)) throw new WorkforceError('not_found', 'Agent not found.');
    const toPerson = assignee.kind === 'human' && isPersonId(assignee.id); // F-52: a colleague, not the owner's To-do list
    if (toPerson) checkPersonWorkFor(this, assignee.id!, before.conversationId, by); // chat-free: only from the owner (P3)
    // D7: into the task's chat, or – out of a 1:1 the agent is not in – the task moves into by's 1:1 with it, so the wake lands there.
    if (assignee.kind === 'agent') routeOwner(this, before, assignee.id!, by);
    const moved = this.mutate(id, draft => {
      draft.assigneeKind = assignee.kind;
      if (assignee.kind === 'team' || (assignee.kind === 'human' && !toPerson)) delete draft.assigneeId; else if (assignee.id) draft.assigneeId = assignee.id;
      draft.assignedBy = by; // the assigner hears once when it is done (lifecycle.completed)
      if (draft.assigneeKind !== before.assigneeKind || draft.assigneeId !== before.assigneeId) changeOwner(this, draft, before);
    });
    // The person giving paused work an owner moves it on (an agent's reassignment keeps the pause).
    const task = (by === HUMAN_ID && assignee.kind !== 'human' ? resumeTask(this, id, by) : undefined) ?? moved;
    // The previous owner's wakes for this task are stale; so are the lead's follow-ups.
    if (before.assigneeKind === 'agent' && before.assigneeId && before.assigneeId !== task.assigneeId) this.s.wakes.cancel(before.assigneeId, { taskId: id });
    if (before.assigneeKind === 'team' && task.assigneeKind !== 'team') this.s.wakes.cancelTask(id, ['review']);
    this.life.assigning(task, assignee, by);
    const view = this.emit(task);
    this.life.assigned(task, assignee, by);
    return view;
  }

  complete(id: string, result: TaskResult, by: string): TaskView { return completeTask(this, id, result, by); }

  pause(id: string, by: string): TaskView {
    const task = pauseTask(this, id, by);
    return task ? this.emit(task) : this.views([this.require(id)])[0];
  }

  resume(id: string, by: string, wakeNote?: string): TaskView {
    const task = resumeTask(this, id, by);
    if (!task) return this.views([this.require(id)])[0];
    const view = this.emit(task);
    if (wakeNote !== undefined) this.life.resumed(task, by, wakeNote);
    return view;
  }

  remove(id: string, by: string): void {
    const task = this.require(id);
    const parts = this.partsOf(id); // its steps and delegated work go with it (ON DELETE CASCADE)
    this.repo.delete(id);
    this.life.removed(task, by, parts);
    this.s.bus.emit('task.removed', { id, ...(task.conversationId ? { conversationId: task.conversationId } : {}) });
    if (task.parentId) { const parent = this.repo.get(task.parentId); if (parent) this.emit(parent); }
  }

  // ------------------------------------------------------------- human flows (tasks/human.ts)

  ingestBlocks(message: Message, blocks: UiBlock[], indexes?: number[]): TaskView[] { return this.human.ingestBlocks(message, blocks, indexes); }
  answer(input: Parameters<TaskService['answer']>[0]): TaskView | undefined { return this.human.answer(input); }
  addTodo(text: string, conversationId?: string): Promise<TaskView> { return this.human.addTodo(text, conversationId); }
  changeWidget(id: string, type: string): TaskView { return this.human.changeWidget(id, type); }
  snooze(ref: string | { messageId: string; blockIndex: number }, until: number): TaskView { return this.human.snooze(ref, until); }
  stopRepeating(id: string, by: string): TaskView { return this.human.stopRepeating(id, by); }

  // ------------------------------------------------------------- shared internals (used by human.ts / ownership.ts)

  require(id: string): Task {
    const task = this.repo.get(id);
    if (!task) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId: id } });
    return task;
  }

  /** Load → change → save with rev check. Throws `conflict` when someone else wrote first. */
  mutate(id: string, change: (draft: Task) => void, expectedRev?: number): Task {
    const current = this.require(id);
    if (expectedRev !== undefined && expectedRev !== current.rev) {
      throw new WorkforceError('conflict', 'The task changed meanwhile. Reload and try again.', { details: { taskId: id, rev: current.rev } });
    }
    const draft: Task = structuredClone(current);
    change(draft);
    draft.rev = current.rev + 1;
    draft.updatedAt = this.s.clock.now();
    if (!this.repo.save(draft, current.rev)) {
      throw new WorkforceError('conflict', 'The task changed meanwhile. Reload and try again.', { details: { taskId: id } });
    }
    return draft;
  }

  emit(task: Task): TaskView {
    const view = this.views([task])[0];
    this.s.bus.emit('task.upserted', view);
    return view;
  }

  /** True while a turn runs on this task (the live activity). */
  isRunning(id: string): boolean { return this.activity.running(id); }

  /** True while any agent runs a turn in this chat. */
  chatRunning(conversationId: string): boolean { return this.activity.working(conversationId).length > 0; }

  /** Steps, progress, chat title, running and its worktree (tasks/views.ts). */
  views(tasks: Task[]): TaskView[] {
    return taskViews(this.repo, (conversationId?: string) => conversationId ? chatTitleFor(this.s, conversationId, HUMAN_ID) : '', id => this.activity.running(id), tasks);
  }

  /** Every task under `id` (steps, delegated work, their parts), breadth first, at most 500. */
  private partsOf(id: string): Task[] {
    const out: Task[] = [];
    const seen = new Set([id]);
    for (const queue = [id]; queue.length && out.length < 500;) {
      for (const part of this.repo.children(queue.shift()!)) {
        if (!seen.has(part.id)) { seen.add(part.id); out.push(part); queue.push(part.id); }
      }
    }
    return out;
  }

  /** Quiet status line about a task in its handover chat (P12: a chat-free task writes none – its ledger and runs are its history). */
  line(task: Task, line: StatusLine, by: string): void {
    if (!task.conversationId) return;
    try {
      this.s.chats.status(task.conversationId, line, { authorId: by, taskId: task.parentId ?? task.id });
    } catch (error) {
      this.s.log?.warn('task status line failed', { taskId: task.id, error: String(error) });
    }
  }

  nameOf(id: string): string {
    if (isPersonId(id)) return this.s.people?.nameOf(id) ?? 'Former colleague'; // F-52
    return id === HUMAN_ID ? 'You' : this.s.org?.get(id)?.name ?? id;
  }

  dispose(): void {
    this.activity.dispose();
    for (const off of this.offs) off();
  }
}
