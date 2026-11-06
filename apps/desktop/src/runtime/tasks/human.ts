// Human to-do flows of the TaskService: agent ask blocks → to-dos (B-078 D9: only important ones, "todo": true and
// timers – catalog.ts becomesTodo; the rest are quick replies answered in the message; idempotent per
// message + block index; a block "id" replaces the earlier open one of the same author – another
// agent's block with that id is a to-do of its own –, and answers or snoozes of
// the newer block find it – tasks/block-todo.ts), answers (store result, complete the to-do quietly,
// post the person's own line – a click on a button is what they picked, in full, shared/blocks/answer-text.ts –
// and wake the authoring agent as for a line they typed; F06: the answer's stored files ride on that line –
// tasks/answer-files.ts, tasks/answer-receipt.ts; the person's decline {declined, reason} cancels the to-do instead –
// tasks/decline.ts, never a mini-app's own data),
// free-text to-dos (addTodo: a plain to-do from tasks/todo-draft.ts, no model), "Give to me" (makeMine: the
// person's own work becomes their to-do), widget switching ("Show as…"; mini-apps keep theirs), snoozing (F03: the to-do waits and rings again – no receipt, nobody
// woken; a snooze answer of older widgets is routed here) and repeating timers
// (Done posts a receipt and waits for the next ring – due then; the author hears only the first
// Done; "Stop repeating" ends it); every widget is armed by tasks/timers.ts (validated when an
// agent wrote it, timer time absolute, one ring schedule). B-054: a to-do needs no chat – one typed into the
// list is chat-free, and an answer to a chat-free to-do is stored on its row (no receipt; the author's wake has
// no chat). The old hidden To-do chat stays an inert row (migration 82 keeps it out of every chat list).
// Mini-app to-dos (F01): every ```app todo=true fence of an agent's message becomes a to-do too
// (ingestApps, run by ingestBlocks; same `blk:<messageId>:<index>` key, so the app's
// wf.complete → blocks.answer finishes it with "Done in mini-app" and the data the app handed back as the
// person's line); fences the person or a bridge wrote are none, and its widget
// (shared/blocks/app-todo.ts) cannot be switched to a catalog one. X03: its answer carries the
// files the app stored with wf.upload, and answering or declining releases the rest (tasks/app-files.ts).
// F-52: in a chat with people an agent's ask goes to the human who wrote last (people/ask-target.ts).
// Owns: those flows. Never: puts agent work on the list.

import { HUMAN_ID } from '../../shared/ids.ts';
import { FINISHED } from './lifecycle.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { APP_TODO_REASON, APP_TODO_TITLE, appTodoWidget, appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { becomesTodo, isImportantAsk, type UiBlock } from '../../shared/blocks/catalog.ts';
import { appTodosOf, uiBlocksOf } from '../../shared/blocks/parse.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices, TaskService } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { answerText, oneLine } from '../../shared/blocks/answer-text.ts';
import { answerFiles, fileNames } from './answer-files.ts';
import { releaseAppFiles } from './app-files.ts';
import { evidenceFor, postAnswer } from './answer-receipt.ts';
import { blockTodo } from './block-todo.ts';
import { declineFrom, declineTodo } from './decline.ts';
import { armTimer, dropTimers, dueAfter, prepareWidget, repeatingTimer, snoozeUntil } from './timers.ts';
import { quickDraft } from './todo-draft.ts';
import { humanReasonFor, isAskBlock, parseDue, titleForBlock, widgetOfType } from './widgets.ts';
import { askTarget } from '../people/ask-target.ts';

export { notesFor, quickDraft, type TodoDraft } from './todo-draft.ts';

const DAY_MS = 86_400_000;

export class HumanTodos {
  private readonly t: TaskServiceImpl;
  constructor(tasks: TaskServiceImpl) { this.t = tasks; }

  ingestBlocks(message: Message, blocks: UiBlock[], indexes?: number[]): TaskView[] {
    const out: TaskView[] = [];
    blocks.forEach((block, position) => {
      if (!isAskBlock(block) || block.todo === false) return;
      const index = indexes?.[position] ?? position; // parse index = the chat's blockIndex
      const clientId = `blk:${message.id}:${index}`;
      const existing = this.t.repo.byClientId(clientId);
      if (existing) { out.push(this.t.views([existing])[0]); return; }
      const title = titleForBlock(block);
      // A later block with the same "id" in the same chat replaces the open one – only the same author's.
      const previous = typeof block.id === 'string' && block.id ? this.t.repo.openByBlockId(message.conversationId, block.id, message.authorId) : undefined;
      // B-078 D9: an ordinary quick reply stays in the message (blocks.answer answers it there); only an important
      // one, "todo": true or a timer becomes a to-do – and a block that updates an open to-do keeps it current.
      if (!previous && !becomesTodo(block)) return;
      if (previous) {
        const armed = prepareWidget(block, message.createdAt, message.authorId);
        const updated = this.t.mutate(previous.id, draft => {
          const due = dueAfter(draft, armed); // a due time the old timer set follows the new one
          draft.widget = armed.widget; draft.title = title; draft.messageId = message.id; draft.humanReason = humanReasonFor(block);
          if (due !== undefined) draft.dueAt = due;
        });
        armTimer(this.t.s, updated);
        out.push(this.t.emit(updated));
        return;
      }
      const asked = askTarget(this.t.s.db, message.conversationId, message.seq, humanReasonFor(block)); // F-52: the person who wrote last, else the owner
      const view = this.t.create({
        conversationId: message.conversationId, title, assigneeKind: 'human', ...(asked ? { assigneeId: asked } : {}), widget: block, humanReason: humanReasonFor(block),
        createdBy: message.authorId, priority: isImportantAsk(block) ? 1 : 0, dueAt: parseDue(block.due, message.createdAt),
        parentId: this.openParent(message),
      }, { anchor: message, clientId });
      out.push(view);
    });
    out.push(...this.ingestApps(message));
    return out;
  }

  /**
   * ```app todo=true fences of an agent's message → mini-app to-dos, idempotent per message +
   * parse index (create keeps the first to-do of a client id). Title from title= ('Mini-app'),
   * reason from reason= ('taste'); the widget is the runtime's own (not validated as a block).
   * A fence that cannot become one is logged and skipped (own savepoint): it never fails the turn.
   */
  ingestApps(message: Message): TaskView[] {
    if (message.authorKind !== 'agent' || message.meta?.via === 'bridge') return [];
    const out: TaskView[] = [];
    for (const { index, attrs } of appTodosOf(message.body)) {
      try {
        const asked = askTarget(this.t.s.db, message.conversationId, message.seq, attrs.reason ?? APP_TODO_REASON); // F-52
        out.push(this.t.s.db.tx(() => this.t.create({
          conversationId: message.conversationId, title: attrs.title?.trim() || APP_TODO_TITLE, assigneeKind: 'human', ...(asked ? { assigneeId: asked } : {}),
          // Task.widget is still typed UiBlock; the stored value is an AppTodoWidget (shared/model/tasks.ts).
          widget: appTodoWidget(message.id, index, attrs) as unknown as UiBlock,
          humanReason: attrs.reason ?? APP_TODO_REASON, createdBy: message.authorId, parentId: this.openParent(message),
        }, { anchor: message, clientId: `blk:${message.id}:${index}`, runtimeWidget: true })));
      } catch (error) {
        this.t.s.log?.warn('mini-app to-do failed', { messageId: message.id, index, error: String(error) });
      }
    }
    return out;
  }

  /** The message's open top-level task: a to-do from its blocks becomes a step of it. */
  private openParent(message: Message): string | undefined {
    const parent = message.taskId ? this.t.repo.get(message.taskId) : undefined;
    return parent && parent.status !== 'done' && parent.status !== 'cancelled' && !parent.parentId ? parent.id : undefined;
  }

  answer(input: Parameters<TaskService['answer']>[0]): TaskView | undefined {
    const s = this.t.s;
    let task: Task | undefined = input.taskId ? this.t.repo.get(input.taskId) : undefined;
    if (!task && input.messageId && input.blockIndex !== undefined) task = blockTodo(s, input.messageId, input.blockIndex);
    if (input.taskId && !task) throw new WorkforceError('not_found', 'To-do not found.', { details: { taskId: input.taskId } });
    if (!task && !input.messageId) throw new WorkforceError('bad_request', 'An answer needs a taskId or a messageId.');
    if (task?.status === 'done' && task.result?.answer !== undefined) return this.t.views([task])[0]; // double answer
    // A snooze answer (older widgets) snoozes the to-do instead of finishing it.
    const snooze = task?.widget?.type === 'timer' ? snoozeUntil(input.answer, s.clock.now()) : undefined;
    if (task && snooze !== undefined) return this.snooze(task.id, snooze);
    const messageId = input.messageId ?? task?.messageId;
    const message = messageId ? s.chats.message(messageId) : undefined;
    const conversationId = task?.conversationId ?? message?.conversationId; // B-054: none for a chat-free to-do
    if (!task && !message) throw new WorkforceError('not_found', 'Message not found.');
    const block = task?.widget;
    const blockKey = typeof block?.id === 'string' && block.id ? block.id
      : messageId && input.blockIndex !== undefined ? `${messageId}:${input.blockIndex}` : task?.id ?? messageId!;
    // "Can't do this…" (F06): the to-do is cancelled and its author hears why (tasks/decline.ts);
    // the entry point decides – a mini-app's own data never declines (declineFrom).
    const declined = declineFrom(input, task);
    if (declined) {
      const cancelled = declineTodo(this.t, { task, message, conversationId, blockKey, by: input.by, clientId: input.clientId }, declined);
      releaseAppFiles(s, block, []); // a mini-app's stored takes go to the clean-up
      return cancelled;
    }
    // A block without a to-do ("todo": false) is read from its message, so its line says what was picked too.
    const asked = block ?? (message && input.blockIndex !== undefined ? uiBlocksOf(message.body).find((item) => item.index === input.blockIndex)?.block : undefined);
    const files = answerFiles(s, input.answer, asked); // stored files only: attached to the person's line
    const text = answerText(asked, input.answer, fileNames(files)); // the person's line: what they picked, in full
    const summary = oneLine(text);

    let view: TaskView | undefined;
    let receiptKey = blockKey;
    let first = true;
    const repeating = task?.widget?.type === 'timer' ? repeatingTimer(s, task.id) : undefined;
    if (task && repeating) {
      // A repeating timer is done for now: it waits for its next ring (each Done has its own receipt).
      const count = (task.ledger.doneCount ?? 0) + 1;
      first = count === 1;
      receiptKey = `${blockKey}@${count}`;
      dropTimers(s, task.id); // a pending snooze
      const now = s.clock.now();
      const next = repeating.nextAt; // the scheduler moved it on before the ring ran
      view = this.t.emit(this.t.mutate(task.id, draft => {
        draft.status = 'waiting';
        draft.waitingOn = { kind: 'schedule', id: repeating.id, reason: 'Repeats', since: now };
        draft.ledger = { ...draft.ledger, doneCount: count };
        if (next === undefined || draft.widget?.type !== 'timer') return;
        // Due at its next ring, not "overdue · yesterday" when it rings again (a due time given
        // explicitly stays); the same clock time keeps the ring as it is.
        draft.dueAt = dueAfter(draft, { dueAt: next });
        draft.widget = { ...draft.widget, at: new Date(next).toISOString() };
      }));
    } else if (task) {
      view = this.t.complete(task.id, { summary, evidence: evidenceFor(summary, files, input.answer), verification: 'reported_by_human', answer: input.answer }, input.by);
    }
    // The person's line (with the answer's files; only in a chat) and, for the first answer, the author's wake.
    const question = asked ? titleForBlock(asked) : task?.title; // review fix: which ask this line answers
    postAnswer(s, { conversationId, text, summary, question, by: input.by, message, task, blockKey, receiptKey, clientId: input.clientId, files, wake: first });
    releaseAppFiles(s, block, files.map((file) => file.attachment.fileId)); // the takes it did not hand back go
    return view;
  }

  /**
   * Snoozes a to-do (by id, or the to-do of a chat block) until `until`: it waits ('Snoozed', its
   * end on waitingOn.until) and rings again then – no receipt, nobody woken.
   */
  snooze(ref: string | { messageId: string; blockIndex: number }, until: number): TaskView {
    const s = this.t.s;
    const found = typeof ref === 'string' ? this.t.repo.get(ref) : blockTodo(s, ref.messageId, ref.blockIndex);
    if (!found) throw new WorkforceError('not_found', 'To-do not found.');
    const task = found;
    const id = task.id;
    if (task.assigneeKind !== 'human') throw new WorkforceError('bad_request', 'Only to-dos can be snoozed.');
    if (task.status === 'done' || task.status === 'cancelled') throw new WorkforceError('conflict', 'This to-do is already finished.');
    const now = s.clock.now();
    if (!Number.isFinite(until) || until < now + 60_000 || until > now + 30 * DAY_MS) throw new WorkforceError('bad_request', 'Snooze for at least a minute and at most 30 days.');
    if (!s.scheduler) throw new WorkforceError('unavailable', 'Reminders are not available.');
    dropTimers(s, id); // the one-shot ring it had; a repeating one keeps its rhythm
    const note = typeof task.widget?.label === 'string' ? task.widget.label : task.title;
    s.scheduler.create({ ownerId: HUMAN_ID, conversationId: task.conversationId, taskId: id, kind: 'timer', title: task.title, spec: { at: until }, payload: { note } });
    return this.t.emit(this.t.mutate(id, draft => {
      draft.status = 'waiting';
      draft.waitingOn = { kind: 'schedule', reason: 'Snoozed', since: now, until };
    }));
  }

  /** "Stop repeating": the repeating timer ends and the to-do is done. */
  stopRepeating(id: string, by: string): TaskView {
    const task = this.t.require(id);
    if (task.assigneeKind !== 'human' || !repeatingTimer(this.t.s, id)) throw new WorkforceError('bad_request', 'This to-do does not repeat.');
    dropTimers(this.t.s, id, true);
    return this.t.complete(id, { summary: 'Stopped repeating', evidence: [{ kind: 'note', label: 'Stopped repeating' }], verification: 'reported_by_human' }, by);
  }

  /** A typed to-do: a plain to-do at once (chat-free unless a chat is given). */
  async addTodo(text: string, conversationId?: string): Promise<TaskView> {
    const draft = quickDraft(this.t.s, text);
    return this.t.create({ ...(conversationId ? { conversationId } : {}), ...draft, assigneeKind: 'human', createdBy: HUMAN_ID });
  }

  changeWidget(id: string, type: string): TaskView {
    const task = this.t.require(id);
    if (task.assigneeKind !== 'human') throw new WorkforceError('bad_request', 'Only human to-dos have a widget.');
    if (appWidgetOf(task.widget)) throw new WorkforceError('bad_request', 'A mini-app to-do keeps its mini-app.');
    let block: UiBlock;
    try { block = widgetOfType(type, task.title, task.widget); } catch {
      throw new WorkforceError('bad_request', 'Unknown widget type.', { details: { type } });
    }
    const now = this.t.s.clock.now();
    const armed = prepareWidget(block, now, HUMAN_ID);
    const updated = this.t.mutate(id, draft => {
      const due = dueAfter(draft, armed); // a due time the old timer set follows the new one
      draft.widget = armed.widget;
      if (due !== undefined) draft.dueAt = due;
    });
    armTimer(this.t.s, updated);
    return this.t.emit(updated);
  }
}

/**
 * "Give to me": the person's own unfinished top-level work becomes their plain to-do (already theirs: as it is). The
 * agents' queued turns for it end, its splits stop and a turn still running on it stops.
 */
export function makeMine(s: Pick<RuntimeServices, 'tasks' | 'wakes' | 'clock'> & Partial<Pick<RuntimeServices, 'dispatcher' | 'log'>>, id: string): TaskView {
  const task = s.tasks.get(id);
  if (!task) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId: id } });
  if (task.assigneeKind === 'human') return task;
  if (FINISHED.has(task.status)) throw new WorkforceError('conflict', 'This task is already finished.');
  const draft = quickDraft(s, task.title); // the title names it; the notes stay on the row
  s.wakes.cancelTask(id);
  s.tasks.assign(id, { kind: 'human' }, HUMAN_ID);
  if (s.tasks.get(id)?.status !== 'open') s.tasks.setStatus(id, 'open', HUMAN_ID);
  const mine = s.tasks.update(id, { widget: draft.widget, humanReason: 'taste' }, HUMAN_ID);
  try { (s as Partial<Pick<RuntimeServices, 'splits'>>).splits?.stop({ taskId: id }, HUMAN_ID); } catch (error) { s.log?.warn('stopping the splits on work the person took failed', { taskId: id, error: String(error) }); }
  for (const run of s.dispatcher?.activity().filter((entry) => entry.taskId === id) ?? []) {
    s.dispatcher!.interrupt(run.agentId, run.conversationId).catch((error: unknown) => s.log?.warn('stopping the turn on work the person took failed', { taskId: id, error: String(error) }));
  }
  return mine;
}

