// The task bubble inside a chat (T2, ChatGPT-photo style): title, round status glyph (spinner only while a turn
// really runs for it), owner avatar, "x of y" + thin bar when it has steps, a static "waiting on … since" line
// (tasks/waiting.ts; "Paused by you since …" for work the person stopped), and on click an inline expansion with
// the notes (clamped, B-078), the step checklist and the result (documentation). An open human to-do shows
// its widget right in the bubble (choice, record, confirm …), so the person answers in place without expanding it.
// While its owner's turn runs, the bubble shows the owner's live note (the real state of the work in this chat). A task
// message that is not the task's anchor – the Inbox's intake record of work that moved to its owner's chat – is a
// compact reference (title, owner, live status, Open), never a second copy.
// D5: a finished task an agent made (compact-task.ts) is one compact line (glyph, title, "Done", time) that opens
// the same body; open "Needs you" cards and the person's own tasks stay full bubbles. A right click or long
// press on any of them opens the task menu (task-menu.ts).
// Reads the live TaskView from the task cache.
// Owns: the bubble. Never: makes ordinary messages look like tasks, or shows a spinner for waiting work.

import { useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { activity, agentName } from '../lib/store.ts';
import { time, fullDate, plainPreview } from '../lib/format.ts';
import { STATUS_LABELS, askTargetOf, isFinished, progressLabel, todoLabel } from './model.ts';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { NotesClamp, OwnerBadge, ProgressBar, StatusGlyph } from './parts.tsx';
import { StepList } from './StepList.tsx';
import { ResultView } from './ResultView.tsx';
import { useTask } from './task-cache.ts';
import { canOpenChat, openTask, openTaskDetail } from './jump.ts';
import { waitingLine } from './waiting.ts';
import { isReference } from './center-model.ts';
import { compactState, isCompact } from './compact-task.ts';
import { taskMenu } from './task-menu.ts';

function Bubble(props: { task: TaskView; message: Message }) {
  const { task, message } = props;
  const [open, setOpen] = useState(false);
  const done = task.status === 'done';
  const hasSteps = task.progress.total > 0;
  const waiting = waitingLine(task, agentName);
  const answerHere = task.assigneeKind === 'human' && task.widget !== undefined && !isFinished(task.status);
  const live = task.running && !waiting ? activity.value.find((entry) => entry.taskId === task.id)?.note : undefined;
  const menu = useContextMenu(() => taskMenu(task));
  return (
    <div class={`task-bubble status-${task.status}${open ? ' open' : ''}`} aria-busy={task.running || undefined} {...menu}>
      <div class="task-bubble-head">
        <button type="button" class="task-bubble-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <StatusGlyph status={task.status} running={task.running} size={20} />
          <span class="task-bubble-title">{todoLabel(task)}</span>
          <span class="sr-only">{STATUS_LABELS[task.status]}</span>
        </button>
        <OwnerBadge task={task} size={24} working={task.running} />
      </div>
      {hasSteps && (
        <div class="task-progress">
          <span class="task-progress-text tabular">{progressLabel(task.progress)} completed</span>
          <ProgressBar done={task.progress.done} total={task.progress.total} label={`${task.title} progress`} />
        </div>
      )}
      {waiting && !done && !answerHere && <div class={`task-waiting${task.status === 'blocked' ? ' blocked' : ''}`}>{waiting}</div>}
      {live && <div class="task-live" aria-live="polite">{plainPreview(live, 120)}</div>}
      {answerHere && (
        <div class="task-bubble-ask">
          <AskBlock block={task.widget!} target={askTargetOf(task)} bare />
        </div>
      )}
      {!open && done && task.result && <div class="task-bubble-summary">{plainPreview(task.result.summary, 140)}</div>}
      {open && <BubbleBody task={task} message={message} />}
    </div>
  );
}

/** The opened bubble: notes, facts, steps, result and the foot. */
function BubbleBody(props: { task: TaskView; message: Message }) {
  const { task, message } = props;
  const author = message.authorKind === 'human' ? 'You' : message.authorKind === 'agent' ? agentName(message.authorId) : '';
  return (
    <div class="task-bubble-body">
      <NotesClamp text={task.notes} />
      <StepList task={task} />
      <ResultView task={task} />
      <div class="task-bubble-foot">
        <span class="muted" title={fullDate(message.createdAt)}>{author ? `${author} · ` : ''}{time(message.createdAt)}</span>
        <button type="button" class="text-button" onClick={() => openTaskDetail(task.id)}>Open in Work</button>
      </div>
    </div>
  );
}

/**
 * D5: a finished task an agent made – one 24 px line (glyph, title, state, time) that opens the same body
 * below it; the line itself never moves.
 */
function CompactRow(props: { task: TaskView; message: Message }) {
  const { task, message } = props;
  const [open, setOpen] = useState(false);
  const menu = useContextMenu(() => taskMenu(task));
  const at = task.completedAt ?? task.updatedAt ?? message.createdAt;
  return (
    <div class={`task-bubble compact status-${task.status}${open ? ' open' : ''}`} {...menu}>
      <button type="button" class="task-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusGlyph status={task.status} size={16} />
        <span class="task-line-title">{todoLabel(task)}</span>
        <span class="task-line-state">{compactState(task)}</span>
        <time class="tabular" dateTime={new Date(at).toISOString()} title={fullDate(at)}>{time(at)}</time>
      </button>
      {open && <BubbleBody task={task} message={message} />}
    </div>
  );
}

/** A task that lives in another chat (its owner's): one line with its live state and a way there. */
function Reference(props: { task: TaskView }) {
  const { task } = props;
  const where = canOpenChat(task.conversationId) ? task.conversationTitle : '';
  const menu = useContextMenu(() => taskMenu(task));
  return (
    <div class={`task-bubble task-reference status-${task.status}`} aria-busy={task.running || undefined} {...menu}>
      <div class="task-bubble-head">
        <button type="button" class="task-bubble-toggle" onClick={() => openTask(task)} title={where ? `Open in ${where}` : 'Open task'}>
          <StatusGlyph status={task.status} running={task.running} size={18} />
          <span class="task-bubble-title">{todoLabel(task)}</span>
          <span class="task-reference-state muted">{STATUS_LABELS[task.status]}{where ? ` · ${where}` : ''}</span>
        </button>
        <OwnerBadge task={task} size={22} working={task.running} />
      </div>
    </div>
  );
}

export function TaskMessage(props: { message: Message }) {
  const { message } = props;
  const task = useTask(message.taskId);
  if (task && isReference(message, task)) return <Reference task={task} />;
  if (task && isCompact(task, message)) return <CompactRow task={task} message={message} />;
  if (task) return <Bubble task={task} message={message} />;
  // Not loaded yet (or removed): the anchor text is the title; no fake status.
  return (
    <div class={`task-bubble placeholder${task === null ? ' removed' : ''}`}>
      <div class="task-bubble-head">
        <span class="task-glyph" data-status={task === null ? 'cancelled' : 'open'} aria-hidden="true" />
        <span class="task-bubble-title">{plainPreview(message.body, 160) || 'Task'}</span>
      </div>
      {task === null && <div class="task-waiting">Task removed</div>}
    </div>
  );
}
