// One row of the Work list: status circle (spinner only for a running turn), title, chat name, due, progress
// "x/y" and the owner avatar (or "Team"). Click opens the task detail; a right click or long press opens the task
// menu (task-menu.ts). Task center (17:37): first in the meta line the short
// readable progress or blocker (center-model.ts progressLine: what it waits on, the owner's live note, the next step,
// its latest report line). B-078: rows are Work's slim rows (one owner's work, search matches); no verification
// mark – a finished row shows its done glyph and result. Short of room the
// meta line is shortened as a whole – one ellipsis at the end of its text, the due time kept whole after it.
// Owns: row markup. Never: edits the task (TaskDetail and the task menu do).

import type { TaskView } from '../../shared/model/tasks.ts';
import { activity, agentName, conversationMap } from '../lib/store.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { chatTitle } from '../lib/chat-face.tsx';
import { listTime, plainPreview } from '../lib/format.ts';
import { FittedRun } from '../lib/kept-tail.ts';
import type { RunPart } from '../lib/kept-tail.ts';
import { progressShort } from './model.ts';
import { progressLine } from './center-model.ts';
import { canOpenChat } from './jump.ts';
import { DueText, OwnerBadge, StatusGlyph } from './parts.tsx';
import { taskMenu } from './task-menu.ts';

export function TaskRow(props: { task: TaskView; selected: boolean; onSelect: (id: string) => void }) {
  const { task } = props;
  const finished = task.status === 'done' || task.status === 'cancelled';
  const known = task.conversationId && canOpenChat(task.conversationId) ? conversationMap.value.get(task.conversationId) : undefined;
  const chat = known ? chatTitle(known) : ''; // no label for the Inbox / To-do anchor chats
  const progress = progressShort(task.progress);
  const note = task.running ? activity.value.find((entry) => entry.taskId === task.id)?.note : undefined;
  const line = finished ? null : progressLine(task, { note, nameOf: agentName });
  // the meta line's parts run as one line, shortened as a whole with one '…' (lib/kept-tail.ts FittedRun); the due time stays whole after it
  const run: RunPart[] = [
    ...(line ? [{ key: 'line', text: line, class: `task-row-line${task.status === 'blocked' ? ' blocked' : ''}` }] : []),
    ...(chat ? [{ key: 'chat', text: chat, class: 'task-row-chat' }] : []),
    ...(finished && task.result?.summary ? [{ key: 'result', text: plainPreview(task.result.summary, 90) }] : []),
  ];
  const menu = useContextMenu(() => taskMenu(task));
  return (
    <li {...menu}>
      <button type="button" class={`task-row${props.selected ? ' selected' : ''}${finished ? ' finished' : ''}`}
        aria-current={props.selected ? 'true' : undefined} onClick={() => props.onSelect(task.id)}>
        <StatusGlyph status={task.status} running={task.running} size={18} />
        <span class="task-row-text">
          <span class="task-row-title">{task.title}</span>
          {(line || chat || task.dueAt !== undefined || (finished && task.result)) && (
            <span class="task-row-meta">
              {run.length > 0 && <FittedRun class="meta-run" parts={run} />}
              {!finished && <DueText dueAt={task.dueAt} />}
            </span>
          )}
        </span>
        {progress && !finished && <span class="task-row-progress tabular" aria-label={`${task.progress.done} of ${task.progress.total} steps done`}>{progress}</span>}
        {finished
          ? <span class="task-row-time tabular">{listTime(task.completedAt ?? task.updatedAt)}</span>
          : <OwnerBadge task={task} size={22} working={task.running} interactive={false} />}
      </button>
    </li>
  );
}
