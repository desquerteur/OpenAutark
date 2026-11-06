// What follows the person's answer to a to-do or an ask block (tasks/human.ts answer, and a
// decline – tasks/decline.ts). Owner 05.11.2026: "das ist nicht eine Entscheidung, das ist einfach
// nur der Button-Klick" – a click is the person's own line:
// - in a chat: ONE message of the person (kind 'answer', idempotent per client id or block key) whose body is
//   their line (shared/blocks/answer-text.ts: the picked option's text in full, "Label: value" lines, "I can't do
//   this: …"), a reply to the asking message, with the answer's stored files attached (tasks/answer-files.ts);
//   meta.answer keeps the block key, the to-do and the one-line summary for the block's receipt and the to-do
//   list. For the first answer the author agent is woken as for a line the person typed – reason 'message', no
//   note, on the chat (or on the open task the to-do is a step of, merging with that task's own wake), and a turn
//   it runs in that chat takes the line in at its next step (dispatcher.steer). It reads the line once, in the chat.
// - B-054: a chat-free to-do has no chat – no message is posted (the answer stays on the to-do's row) and the
//   author is woken with reason 'answer' on its task, the line and the files' paths as the note.
// Only a real, active agent is woken: the person's own to-dos and host-made ones (approvals) have no author agent.
// Also the evidence a completed to-do keeps (its files, else the summary).
// Owns: the line, the wake and the evidence. Never: changes the task (the caller does).

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Task, TaskResult } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import { chatWakeKey } from '../chat/delivery-route.ts';
import { answerLines, type AnswerFile } from './answer-files.ts';

export type ReceiptDeps = Pick<RuntimeServices, 'chats' | 'wakes'> & Partial<Pick<RuntimeServices, 'org' | 'dispatcher' | 'log'>>;

export interface AnswerPost {
  /** The to-do's (or the asking message's) chat; absent for a chat-free to-do. */
  conversationId?: string;
  /** The person's line (shared/blocks/answer-text.ts): the message body, and the note of a chat-free wake. */
  text: string;
  /** Its one-line form: meta.answer.summary (the block's receipt). */
  summary: string;
  /** What the block asked (its question or title): the agent reads its line as the answer to that (two asks in one message). */
  question?: string;
  /** HUMAN_ID, or the agent that answered on the person's behalf. */
  by: string;
  /** The message that asked (the ask block's or the to-do's anchor). */
  message?: Message;
  task?: Task;
  blockKey: string;
  /** Receipt key: the block key, or `<key>@<n>` for the n-th Done of a repeating to-do. */
  receiptKey: string;
  clientId?: string;
  files?: readonly AnswerFile[];
  /** Wake the author (false: a repeating to-do's later Done). */
  wake: boolean;
}

/** The agent that asked: the asking message's author, else the to-do's creator (never the person or the host). */
export function authorOf(message: Message | undefined, task: Task | undefined): string | undefined {
  if (message?.authorKind === 'agent') return message.authorId;
  return task && task.createdBy !== HUMAN_ID && task.createdBy !== SYSTEM_ID ? task.createdBy : undefined;
}

/** Posts the person's line and wakes the author (see the header). */
export function postAnswer(s: ReceiptDeps, post: AnswerPost): void {
  const human = isHumanActor(post.by); // F-52: a person's answer is theirs (never the owner's)
  let chat = post.conversationId;
  // Review fix: a line that cannot be posted (the person left that chat, the chat is gone) still reaches the asking agent
  // – as a chat-free answer with the line as its note, not as silence.
  if (chat) try { s.chats.send({
    conversationId: chat, body: post.text, kind: 'answer', authorId: post.by, authorKind: human ? 'human' : 'agent',
    replyTo: post.message?.id, taskId: post.task?.id,
    clientId: post.clientId ? `ans:${post.clientId}` : `ans:${post.receiptKey}`,
    meta: { answer: { blockKey: post.receiptKey, taskId: post.task?.id, summary: post.summary, ...(post.question ? { question: excerpt(post.question, 160) } : {}) } },
    ...(post.files?.length ? { attachments: post.files.map((file) => file.attachment) } : {}),
  }); } catch { chat = undefined; }
  const author = authorOf(post.message, post.task);
  if (!post.wake || !author) return;
  const agent = s.org ? s.org.get(author) : undefined;
  if (s.org && (agent === undefined || agent.archivedAt !== undefined)) return;
  const parent = post.task?.parentId;
  if (!chat) {
    const about = post.task?.title ?? post.question;
    const title = about ? ` "${excerpt(about, 120)}"` : '';
    s.wakes.wake({
      agentId: author, reason: 'answer', taskId: parent ?? post.task?.id,
      note: `Reply to my to-do${title}:\n${answerLines(post.text, post.files)}`, coalesceKey: `answer:${post.blockKey}`,
    });
    return;
  }
  // As for a line the person typed: the chat's wake, or the open task the to-do is a step of (its own wake merges in).
  s.wakes.wake({ agentId: author, reason: 'message', conversationId: chat, ...(parent ? { taskId: parent } : {}), coalesceKey: parent ? `task:${parent}` : chatWakeKey(chat) });
  if (human && typeof s.dispatcher?.steer === 'function') {
    s.dispatcher.steer(author, chat).catch((error: unknown) => s.log?.warn('answer fold failed', { agentId: author, error: String(error) }));
  }
}

const FILE_ID = /^[a-f0-9]{64}$/;

/**
 * Evidence of an answered to-do: its stored files (by name); else file names or paths the answer
 * gives as text (never an unknown file id); else a note with the summary.
 */
export function evidenceFor(summary: string, files: readonly AnswerFile[], answer?: unknown): TaskResult['evidence'] {
  if (files.length) return files.map((file) => ({ kind: 'file' as const, label: file.attachment.name, ref: file.attachment.fileId }));
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  const refs = [a.file, ...(Array.isArray(a.files) ? a.files : [])]
    .filter((ref): ref is string => typeof ref === 'string' && Boolean(ref.trim()) && !FILE_ID.test(ref));
  if (refs.length) return refs.map((ref) => ({ kind: 'file' as const, label: ref.split(/[\\/]/).pop() || ref, ref }));
  return [{ kind: 'note', label: summary }];
}
