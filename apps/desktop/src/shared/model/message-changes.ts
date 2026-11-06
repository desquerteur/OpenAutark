// What the person's edit or delete leaves in a chat log (C6), so the runtime and every view read it
// alike. The person changes only their own text messages (personalText). A change in a chat with
// agents (B-050 K10: also an agent's change of its own message) posts a quiet notice line for agents
// (status details `edited` or `deleted` = the message id, `seq`, who changed it as `by`, a deleted
// message's time as `at`) that the person's views – window, phone, wf CLI –
// leave out (isAgentNotice). The person's deleted text message leaves a tombstone line at its seq
// (details.tombstone = the deleted id; tombstoneOf), which tells a quote of it apart from one that is
// only not loaded yet (quotedIn).
// Owns: these markers and predicates. Never: writes rows (runtime/chat/message-edits.ts does) or
// keeps any of a deleted message's text.

import type { Message } from './chat.ts';

type Line = Pick<Message, 'kind' | 'meta'>;

/** The person's own text message: only those may the person edit, and only those leave a tombstone. */
export function personalText(message: Pick<Message, 'authorKind' | 'kind'>): boolean {
  return message.authorKind === 'human' && message.kind === 'text';
}

/** A notice for agents about the person's edit or delete; views for the person leave it out. */
export function isAgentNotice(message: Line): boolean {
  const details = message.kind === 'status' ? message.meta.status?.details : undefined;
  return typeof details?.edited === 'string' || typeof details?.deleted === 'string';
}

/** The id of the deleted message a tombstone line stands for. */
export function tombstoneOf(message: Line): string | undefined {
  const id = message.kind === 'status' ? message.meta.status?.details?.tombstone : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The quoted message among the loaded ones; 'deleted' when it is known to be gone (its tombstone
 * is loaded, or the whole history is and it is not); undefined when it is only not loaded yet.
 */
export function quotedIn(list: readonly Message[], messageId: string, historyComplete: boolean): Message | 'deleted' | undefined {
  const found = list.find((message) => message.id === messageId);
  if (found) return found;
  return historyComplete || list.some((message) => tombstoneOf(message) === messageId) ? 'deleted' : undefined;
}
