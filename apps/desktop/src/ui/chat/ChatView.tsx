// One chat: the chat header (ChatHeader.tsx) as one row over the whole view, under it the chat column
// (the chat's area when open – ChatArea.tsx, its tabs; AF-010: docked right of it by default, else left, below, above or
// floating, appearance.chatDock –, message list, the important-question strip – AskStrip.tsx,
// B-078 –, composer) and the optional details panel –
// content below the header row, so opening either moves no header cell. Loads the newest page on open and
// marks the chat read while visible. Chats the list leaves out (agent-only rooms, the To-do chat) are
// fetched on demand. Before the first markRead it captures the person's read cursor (catch-up.ts), so
// the list can show the "New messages" divider.
// Owns: chat layout, read marking and the catch-up start. Never: message rendering details (MessageList/Item).

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { chatSpace } from '../../shared/api/workspace-browser.ts';
import { conversationMap, ensureConversation, isMobile, loadMessages, messagesFor } from '../lib/store.ts';
import { chatDock } from '../lib/appearance.ts';
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
  // AF-010: a chat view too narrow for the messages beside docked tabs (under 620 px, like the details panel's rule) docks them on top
  const view = useRef<HTMLDivElement>(null);
  const narrow = useSignal(false);
  useLayoutEffect(() => {
    const element = view.current;
    if (!element) return;
    const measure = () => { narrow.value = element.getBoundingClientRect().width < 620; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(chat)]);

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

  // AF-010: where the chat's tabs dock (lib/appearance.ts); full view and the phone keep them above the messages
  const full = area && fullView.value === chatSpace(conversationId);
  const docked = chatDock.value.place;
  const place = full || isMobile.value || (narrow.value && (docked === 'right' || docked === 'left')) ? 'top' : docked;
  return (
    <div ref={view} class={`chat-view${panel ? ' with-panel' : ''}`}>
      <ChatHeader chat={chat} />
      <div class={`chat-body${area ? ` dock-${place}` : ''}`}>
        {area && place === 'left' && <ChatArea chat={chat} place={place} />}
        <section class={`chat-column${full ? ' area-full' : ''}`} aria-label={chatTitle(chat)}>
          {area && place === 'top' && <ChatArea chat={chat} place={place} />}
          <MessageList conversationId={conversationId} loading={loading.value && !list.value.length} start={start.value ?? null} />
          <AskStrip conversationId={conversationId} />
          <Composer chat={chat} />
          {area && place === 'bottom' && <ChatArea chat={chat} place={place} />}
        </section>
        {area && (place === 'right' || place === 'float') && <ChatArea chat={chat} place={place} />}
        {panel && <ChatSidePanel chat={chat} panel={panel} onClose={() => setChatPanel(conversationId, null)} />}
      </div>
    </div>
  );
}
