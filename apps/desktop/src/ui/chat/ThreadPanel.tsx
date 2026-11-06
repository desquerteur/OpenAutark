// A thread in the chat's side panel (B-078): the message it answers as a quote line on top, then the thread's own
// message list and composer – the same components as the chat column, for the thread's id – centred in the panel
// like the chat column (it is a chat-column container, chat.css). Loads the thread's newest page when it opens, keeps
// the thread's event topic subscribed while it shows and marks it read.
// Owns: the thread panel's content. Never: the panel frame (ChatSidePanel.tsx) or what a thread is (threads.ts).

import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { activeConversationId, conversationMap, ensureConversation, loadMessages, messagesFor } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { toastError } from '../lib/toasts.ts';
import { MessageList } from './MessageList.tsx';
import { Composer } from './Composer.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';

export function ThreadPanel(props: { threadId: string }) {
  const { threadId } = props;
  const thread = conversationMap.value.get(threadId);
  const list = messagesFor(threadId);
  const loading = useSignal(true);
  const gone = useSignal(false);

  useEffect(() => {
    loading.value = true;
    gone.value = false;
    ensureConversation(threadId).then((found) => { gone.value = !found; }, () => undefined);
    loadMessages(threadId).catch((error) => toastError(error, 'Thread could not be loaded')).finally(() => { loading.value = false; });
  }, [threadId]);

  // The thread's own topic while it shows (store-events.ts keeps only the open chat's): new lines, live run rows,
  // edits and deletes arrive here too. The open chat's topic is the store's to keep or drop.
  useEffect(() => {
    const topic = `chat:${threadId}` as const;
    if (activeConversationId.peek() === threadId) return;
    rpc.subscribe([topic]);
    return () => { if (activeConversationId.peek() !== threadId) rpc.unsubscribe([topic]); };
  }, [threadId]);

  const lastSeq = list.value.length ? list.value[list.value.length - 1].seq : 0;
  useEffect(() => {
    if (!thread || !lastSeq || !(thread.unread > 0) || document.visibilityState !== 'visible') return;
    void rpc.call('chats.markRead', { id: threadId, seq: lastSeq }).catch(() => undefined);
  }, [threadId, lastSeq, thread?.unread]);

  if (!thread) return <div class="chat-missing">{gone.value ? <EmptyState>This thread is no longer available.</EmptyState> : <Spinner />}</div>;
  const { parentId, anchorId } = thread.settings;
  return (
    <section class="chat-column thread-column" aria-label="Thread">
      {parentId && anchorId && <div class="thread-anchor"><ReplyQuote conversationId={parentId} messageId={anchorId} /></div>}
      <MessageList conversationId={threadId} loading={loading.value && !list.value.length} />
      <Composer chat={thread} />
    </section>
  );
}
