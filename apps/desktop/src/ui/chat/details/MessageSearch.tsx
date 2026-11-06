// Chat details › message hits for the panel's search text (chats.search, this chat only,
// debounced). Clicking a hit scrolls the chat to that message and flashes it.
// Owns: the hit list. Never: searches other chats or loads whole histories.

import { useEffect, useState } from 'preact/hooks';
import type { Message } from '../../../shared/model/chat.ts';
import { listTime } from '../../lib/format.ts';
import { errorText, rpc } from '../../lib/rpc.ts';
import { focusMessage } from '../../lib/shell-state.ts';
import { agentName } from '../../lib/store.ts';
import { Spinner } from '../../lib/ui.tsx';

type Hit = { message: Message; snippet: string };

export function MessageSearch(props: { conversationId: string; query: string }) {
  const text = props.query.trim();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setHits(null);
    setError(null);
    if (text.length < 2) return;
    let alive = true;
    const timer = setTimeout(() => {
      rpc.call('chats.search', { text, conversationId: props.conversationId, limit: 20 })
        .then((list) => { if (alive) setHits(list.map(({ message, snippet }) => ({ message, snippet }))); })
        .catch((err) => { if (alive) setError(errorText(err)); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, props.conversationId]);
  if (text.length < 2) return null;
  return (
    <section class="details-section" aria-label="Messages">
      <h3 class="details-heading">Messages</h3>
      {error && <p class="details-note">{error}</p>}
      {!error && hits === null && <Spinner size={14} />}
      {hits !== null && !hits.length && <p class="details-note">No messages found.</p>}
      {hits !== null && hits.length > 0 && (
        <ul class="details-hits">
          {hits.map(({ message, snippet }) => (
            <li key={message.id}>
              <button type="button" class="details-hit" onClick={() => { focusMessage.value = { conversationId: props.conversationId, messageId: message.id }; }}>
                <span class="details-hit-head">
                  <span>{message.authorKind === 'human' ? 'You' : agentName(message.authorId)}</span>
                  <time class="tabular">{listTime(message.createdAt)}</time>
                </span>
                <span class="details-hit-text">{snippet || message.body.slice(0, 140)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
