// Leaving a chat from a person's own app (F-52). The runtime lets every member leave
// (people/rpc-chats.ts: chats.members removing only themselves – in a person's session 'human' is the
// caller); the chat's menu (chat-actions.ts) offers "Leave" there. After a confirm the chat leaves her lists at once
// (the runtime's conversation.removed for her device follows), and the other members – the owner and
// the agents – see the usual member line.
// Owns: when "Leave chat" shows, its confirmation and the leave step (environment injected, so it is
// unit-tested without the DOM). Never: removes anyone else, or shows on the owner's window or phones
// (the owner changes members under Members).

import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';

/** "Leave chat": on a person's device that may change memberships, in a chat she is still in (never a system chat). */
export function leaveShown(chat: Pick<ConversationSummary, 'members' | 'settings'>, personSession: boolean, allowed: boolean): boolean {
  if (!personSession || !allowed || chat.settings.system) return false;
  return chat.members.some((member) => member.memberId === HUMAN_ID && member.leftAt === undefined);
}

export const LEAVE_CONFIRM = {
  title: 'Leave chat?',
  body: 'You no longer see this chat or its messages. Your earlier messages stay in it.',
  confirmLabel: 'Leave',
  danger: true,
} as const;

/** What leaving needs from the app (the store, rpc and dialogs in chat-actions.ts; fakes in tests). */
export interface LeaveEnv {
  confirm(options: typeof LEAVE_CONFIRM): Promise<boolean>;
  leave(params: { id: string; remove: string[] }): Promise<unknown>;
  /** The chat is gone for her: out of her lists, and the view goes home. */
  left(conversationId: string): void;
  failed(error: unknown): void;
}

/** Asks first, then leaves (only herself); true once she left. */
export async function leaveChat(conversationId: string, env: LeaveEnv): Promise<boolean> {
  if (!(await env.confirm(LEAVE_CONFIRM))) return false;
  try {
    await env.leave({ id: conversationId, remove: [HUMAN_ID] });
  } catch (error) {
    env.failed(error);
    return false;
  }
  env.left(conversationId);
  return true;
}
