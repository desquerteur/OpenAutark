// One chat: the chat header (ChatHeader.tsx) as one row over the whole view, under it the chat column
// (the chat's area when open – ChatArea.tsx, its tabs –, message list, the important-question strip – AskStrip.tsx,
// B-078 –, composer) and the optional details panel –
// content below the header row, so opening either moves no header cell. Loads the newest page on open and
// marks the chat read while visible. Chats the list leaves out (agent-only rooms, the To-do chat) are
// fetched on demand. Before the first markRead it captures the person's read cursor (catch-up.ts), so
// the list can show the "New messages" divider.
// Owns: chat layout, read marking and the catch-up start. Never: message rendering details (MessageList/Item).

import { useEffect } from 'preact/hooks';
import { chatSpace } from '../../shared/api/workspace-browser.ts';
import { conversationMap, ensureConversation, loadMessages, messagesFor } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { chatAreaOpen, chatPanel, setChatPanel } from '../lib/shell-state.ts';
import { fullView } from '../workspace/full-view.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { Header } from '../lib/header.tsx';
import { chatTitle } from '../lib/chat-face.tsx';
import { toastError } from '../lib/toasts.ts';
import { ChatHeader, chatLead } from './ChatHeader.tsx';
import { MessageList } from './MessageList.tsx';
import { Composer } from './Composer.tsx';
import { AskStrip } from './AskStrip.tsx';
import { ChatArea } from './ChatArea.tsx';
import { ChatSidePanel } from './ChatSidePanel.tsx';
import { captureStart, type CatchUpStart } from './catch-up.ts';
import { useSignal } from '@preact/signals';

export function ChatView(props: { conversationId: string }) {
  const { conversationId } = props;
  const chat = conversationMap.value.get(conversationId);
  const list = messagesFor(conversationId);
  const loading = useSignal(true);
  /** True once chats.get said this chat does not exist. */
  const gone = useSignal(false);
  /** Catch-up start: undefined until the chat summary is there, null when there is nothing to catch up on. */
  const start = useSignal<CatchUpStart | null | undefined>(undefined);
  const panel = chatPanel.value;
  const area = chatAreaOpen.value;

  useEffect(() => {
    loading.value = true;
    loadMessages(conversationId)
      .catch((error) => toastError(error, 'Messages could not be loaded'))
      .finally(() => { loading.value = false; });
  }, [conversationId]);

  // Not in the store (hidden from chats.list, or dropped by a reconnect reload): fetch it.
  // A failed fetch (connection lost) is tried again once the connection is back.
  const missing = !chat;
  const online = rpc.status.value === 'open';
  useEffect(() => {
    gone.value = false;
    if (!missing || !online) return;
    let alive = true;
    ensureConversation(conversationId).then((found) => { if (alive) gone.value = !found; }, () => undefined);
    return () => { alive = false; };
  }, [conversationId, missing, online]);

  // Capture the read cursor before the read effect below moves it (effects run in this order).
  useEffect(() => {
    if (chat && start.peek() === undefined) start.value = captureStart(chat);
  }, [conversationId, missing]);

  // Mark read when new messages arrive while the chat is visible.
  const lastSeq = list.value.length ? list.value[list.value.length - 1].seq : 0;
  useEffect(() => {
    if (!chat || !lastSeq) return;
    const read = () => { if (chat.unread > 0) void rpc.call('chats.markRead', { id: conversationId, seq: lastSeq }).catch(() => undefined); };
    if (document.visibilityState === 'visible') read();
    const shown = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [conversationId, lastSeq, chat?.unread]);

  if (!chat) {
    return (
      <div class="chat-view">
        <Header zone="main" class="chat-header" lead={chatLead()} title="" />
        <div class="chat-body"><div class="chat-column"><div class="chat-missing">{gone.value ? <EmptyState>This chat is no longer available.</EmptyState> : <Spinner />}</div></div></div>
      </div>
    );
  }

  return (
    <div class={`chat-view${panel ? ' with-panel' : ''}`}>
      <ChatHeader chat={chat} />
      <div class="chat-body">
        <section class={`chat-column${area && fullView.value === chatSpace(conversationId) ? ' area-full' : ''}`} aria-label={chatTitle(chat)}>
          {area && <ChatArea chat={chat} />}
          <MessageList conversationId={conversationId} loading={loading.value && !list.value.length} start={start.value ?? null} />
          <AskStrip conversationId={conversationId} />
          <Composer chat={chat} />
        </section>
        {panel && <ChatSidePanel chat={chat} panel={panel} onClose={() => setChatPanel(conversationId, null)} />}
      </div>
    </div>
  );
}
