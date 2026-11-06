// Small navigation actions shared by rail, palette and mobile tabs.
// Owns: "open chats" (last chat or the list) and remembering the last opened chat.
// Never: renders.

import { effect } from '@preact/signals';
import { navigate } from '../lib/router.ts';
import { activeConversationId, conversationMap, isMobile } from '../lib/store.ts';

const LAST_KEY = 'wf.lastChat';

export function rememberLastChat(): void {
  effect(() => {
    const id = activeConversationId.value;
    if (id) { try { localStorage.setItem(LAST_KEY, id); } catch { /* ignore */ } }
  });
}

export function lastChatId(): string | null {
  try {
    const id = localStorage.getItem(LAST_KEY);
    return id && conversationMap.value.has(id) ? id : null;
  } catch { return null; }
}

/** Desktop: reopen the last chat. Phone: show the chat list. */
export function openChats(): void {
  const last = isMobile.value ? null : lastChatId();
  navigate(last ? { view: 'chat', id: last } : { view: 'chats' });
}
