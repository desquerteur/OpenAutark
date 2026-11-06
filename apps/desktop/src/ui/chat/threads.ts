// Threads in the window (B-078, owner 06.11.: "wie bei Discord … ein Arbeitsding, eine Sache, an der man gerade
// arbeitet"): a thread is a sub-chat on one message (settings.anchorId, runtime/chat/children.ts). Under its message it
// is one quiet line ("3 replies · Mara") that opens or closes it in the chat's side panel; it never shows in the list.
// Owns: finding a message's thread in the store, the line's words and starting one. Never: renders (MessageItem.tsx,
// ThreadPanel.tsx) or decides members (the runtime does).

import { computed } from '@preact/signals';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { agentName, conversations } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toggleThread } from '../lib/shell-state.ts';
import { toastError } from '../lib/toasts.ts';

/** Every thread in the store by the message it answers. */
export const threadsByAnchor = computed(() => {
  const map = new Map<string, ConversationSummary>();
  for (const chat of conversations.value) if (chat.settings.anchorId && !map.has(chat.settings.anchorId)) map.set(chat.settings.anchorId, chat);
  return map;
});

/** A thread (never a chat-list row). */
export const isThread = (chat: Pick<ConversationSummary, 'settings'>): boolean => Boolean(chat.settings.anchorId);

/**
 * The quiet line under the anchor: the thread's real replies (the runtime's count – status lines, edit notices, silent
 * and still streaming rows never count) and who wrote the last one ("3 replies · Mara"); '' while it has none.
 */
export function threadLine(thread: Pick<ConversationSummary, 'replies'>, nameOf: (id: string) => string = agentName): string {
  const count = thread.replies?.count ?? 0;
  if (!count) return '';
  const who = thread.replies?.authorId;
  const name = !who || who === SYSTEM_ID ? '' : who === HUMAN_ID ? 'You' : nameOf(who);
  return `${count} ${count === 1 ? 'reply' : 'replies'}${name ? ` · ${name}` : ''}`;
}

/** "Start thread": finds or opens the thread on `message` and shows it in the side panel of its chat. */
export async function startThread(message: Pick<Message, 'id' | 'conversationId'>): Promise<void> {
  try {
    const thread = await rpc.call('chats.thread', { messageId: message.id });
    toggleThread(message.conversationId, thread.id, true);
  } catch (error) {
    toastError(error, 'Thread not opened');
  }
}
