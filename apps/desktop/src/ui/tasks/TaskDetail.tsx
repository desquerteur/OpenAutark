// Task detail (Work's main area, a right drawer on wide windows, below Work's header row – not part of the row;
// its toggle is the selected card or row). Top: the chat's name (B-054: without a chat "From: <what started it>",
// the origin's label) as the task's dropdown (task-menu.ts: Open in chat, Give to me, Send to…, Resume, Done,
// Reopen, Cancel, Delete – a right click on the detail opens the same) and Close. Then (B-078 D10, owner 06.11.:
// "diese ganzen Sachen, wo man jetzt aktuell einstellen kann mit den Tasks … alles Blödsinn"): the title, ONE
// sentence of state (waiting.ts stateLine), the notes clamped to four lines (read-only), the question that needs
// the person inline (a to-do's widget, the owner's open human steps – TaskFollowUp.tsx), a short reply to the owner,
// the steps (human steps tickable) and the result (summary, Also handled, follow-ups). Owner, due, priority, the
// done-condition, the goal, the created-by line and verification marks are not shown: the agents own them (tools),
// and the person says "by Friday" in the reply; reassigning is the menu's Give to me / Send to….
// Owns: the detail frame. Never: marks agent work as verified, or acts without the person's click.

import type { Origin } from '../../shared/model/origin.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { agentName, conversationMap } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { askTargetOf, isFinished, ownerOf, progressLabel } from './model.ts';
import { NotesClamp, ProgressBar, StatusGlyph } from './parts.tsx';
import { StepList } from './StepList.tsx';
import { ResultView } from './ResultView.tsx';
import { TitleField } from './TaskFields.tsx';
import { useTask } from './task-cache.ts';
import { canOpenChat, openTaskInChat } from './jump.ts';
import { stateLine } from './waiting.ts';
import { TaskQuestions, TaskReply } from './TaskFollowUp.tsx';
import { taskMenu } from './task-menu.ts';
import { TitleMenu } from '../team/TitleMenu.tsx';

/** The top line's name: the handover chat's, else (B-054) what started the task – "From: To-do area", "From: New mail in …". */
function placeName(chatName: string | undefined, chatFree: boolean, origin: Origin | undefined): string {
  if (chatName) return chatName;
  return chatFree && origin?.label ? `From: ${origin.label}` : 'Task';
}

export function TaskDetail(props: { taskId: string; onClose: () => void }) {
  const task = useTask(props.taskId);
  const close = props.onClose;
  const menu = useContextMenu(() => (task ? taskMenu(task) : []));
  const closeButton = <button type="button" class="text-button task-detail-close" onClick={close}>Close</button>;
  if (!task) {
    return (
      <aside class="tasks-detail" aria-label="Task">
        <div class="task-detail-top"><h3 class="task-detail-heading">Task</h3>{closeButton}</div>
        <div class="task-detail-scroll">{task === null ? <EmptyState>This task was removed.</EmptyState> : <Spinner />}</div>
      </aside>
    );
  }
  const chat = task.conversationId ? conversationMap.value.get(task.conversationId) : undefined;
  const openable = canOpenChat(task.conversationId);
  const place = placeName(chat && chatTitle(chat), !task.conversationId, task.origin);
  return (
    <aside class="tasks-detail" aria-label="Task" onKeyDown={(event) => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) close(); }}>
      <div class="task-detail-top">
        <h3 class="task-detail-heading"><TitleMenu name={place} sections={() => taskMenu(task)} /></h3>
        {closeButton}
      </div>
      <div class="task-detail-scroll">
        <div class="task-detail" {...menu}>
          <TitleField task={task} />
          <div class="task-detail-status">
            <StatusGlyph status={task.status} running={task.running} size={18} />
            <span class="task-detail-status-text">
              {stateLine(task, agentName)}
              {openable && <> · <button type="button" class="text-button inline" onClick={() => openTaskInChat(task)}>Open in chat</button></>}
            </span>
          </div>
          <NotesClamp text={task.notes} />
          {task.widget && ownerOf(task).kind === 'human' && !isFinished(task.status) && (
            <div class="task-detail-widget">
              <AskBlock block={task.widget} target={askTargetOf(task)} bare />
            </div>
          )}
          <TaskQuestions task={task} />
          <TaskReply task={task} />
          {task.progress.total > 0 && (
            <section class="task-detail-steps" aria-label="Steps">
              <div class="task-progress">
                <span class="task-progress-text tabular">{progressLabel(task.progress)} completed</span>
                <ProgressBar done={task.progress.done} total={task.progress.total} />
              </div>
              <StepList task={task} />
            </section>
          )}
          <ResultView task={task} />
        </div>
      </div>
    </aside>
  );
}
