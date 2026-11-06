// The task center parts of the task detail (17:37): the owner's open questions to the person – its human steps
// with a widget, answered right here (the same AskBlock as in the chat and My day); and a short reply to the
// owner, posted into the chat where the work happens as a reply to the task card (messages.send with replyTo – the
// agent gets it like any chat message). Longer work on the task belongs to that chat ("Open in chat"). B-054: a
// task without a chat shows "Discuss with <owner>" in the same slot – it posts a live reference of the task into
// the person's 1:1 with the owner (chats.direct, tasks.share) and opens it there; a task becomes a conversation
// only by the person's choice. Placing unowned work is the task menu's "Send to…" (task-menu.ts).
// Owns: these sections. Never: answers for the person, writes the reply anywhere but the task's own chat, or
// puts a task into a chat by itself.

import { useState } from 'preact/hooks';
import type { TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { Button } from '../lib/ui.tsx';
import { agentMembers } from '../lib/avatar.tsx';
import { rpc } from '../lib/rpc.ts';
import { agentName, conversationMap, conversations, upsertById } from '../lib/store.ts';
import { personName } from '../lib/people.ts';
import { toastError } from '../lib/toasts.ts';
import { askTargetOf, isFinished } from './model.ts';
import { openQuestions } from './center-model.ts';
import { canOpenChat, jumpToMessage, openTaskInChat } from './jump.ts';

/** The owner's open questions to the person, answered in place. */
export function TaskQuestions(props: { task: TaskView }) {
  const questions = openQuestions(props.task.steps);
  if (!questions.length || isFinished(props.task.status)) return null;
  return (
    <section class="task-questions" aria-label="Questions for you">
      {questions.map((step) => (
        <div key={step.id} class="task-detail-widget">
          <AskBlock block={step.widget!} target={askTargetOf(step)} bare />
        </div>
      ))}
    </section>
  );
}

/** The owner a reply or a discussion goes to: an agent, or (B-054) a colleague of a chat-free task. */
function ownerOfTask(task: TaskView): string | undefined {
  if (task.assigneeKind === 'agent') return task.assigneeId;
  return task.assigneeKind === 'human' && task.assigneeId?.startsWith('per_') ? task.assigneeId : undefined;
}

/** B-054: "Discuss with <owner>" for a task without a chat – a live reference in the 1:1 with the owner, opened there. */
function TaskDiscuss(props: { task: TaskView; owner: string }) {
  const { task, owner } = props;
  const [busy, setBusy] = useState(false);
  const name = task.assigneeKind === 'agent' ? agentName(owner) : personName(owner) ?? 'them';
  const discuss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const chat = await rpc.call('chats.direct', { memberId: owner });
      upsertById(conversations, chat); // the row exists at once; conversation.upserted keeps it fresh
      const message = await rpc.call('tasks.share', { id: task.id, conversationId: chat.id, clientId: newId('req') });
      void jumpToMessage(chat.id, message.id);
    } catch (error) {
      toastError(error, 'Could not open the chat');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="task-reply">
      <Button variant="secondary" busy={busy} onClick={() => void discuss()}>Discuss with {name}</Button>
    </div>
  );
}

/** A short reply to the owner in the task's chat (deep work: Open in chat); without a chat: Discuss with <owner>. */
export function TaskReply(props: { task: TaskView }) {
  const { task } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const owner = ownerOfTask(task);
  if (!owner || isFinished(task.status)) return null;
  if (!task.conversationId) {
    return !task.private ? <TaskDiscuss task={task} owner={owner} /> : null;
  }
  const chatId = task.conversationId;
  if (task.assigneeKind !== 'agent' || !canOpenChat(chatId)) return null;
  const chat = conversationMap.value.get(chatId);
  const group = chat ? agentMembers(chat).length > 1 : false;
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await rpc.call('messages.send', {
        conversationId: chatId, body, clientId: newId('req'),
        ...(task.messageId ? { replyTo: task.messageId } : {}), ...(group ? { mentions: [owner] } : {}),
      });
      setText('');
      setSent(true);
    } catch (error) {
      toastError(error, 'Message not sent');
    } finally {
      setBusy(false);
    }
  };
  const name = agentName(owner);
  return (
    <form class="task-reply" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input class="input task-reply-input" type="text" value={text} maxLength={2000} placeholder={`Reply to ${name}`} aria-label={`Reply to ${name} about this task`}
        disabled={busy} onInput={(event) => { setText((event.currentTarget as HTMLInputElement).value); setSent(false); }} />
      <Button variant="secondary" type="submit" busy={busy} disabled={!text.trim()}>Send</Button>
      {sent && <span class="task-reply-sent muted" role="status">Sent · <button type="button" class="text-button inline" onClick={() => openTaskInChat(task)}>Open in chat</button></span>}
    </form>
  );
}
