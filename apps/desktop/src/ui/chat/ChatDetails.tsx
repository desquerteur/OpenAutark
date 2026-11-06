// Chat details (inside the chat side panel; its name and X sit in the chat header row): a search over this
// chat's messages, the members, the notes row (opens the chat's notes in the side pane), what is scheduled and the
// Telegram link. What can be done
// with the chat itself – pin, mute, rename, image, export, archive, leave, delete – is its right-click menu
// (chat-actions.ts) on the chat row and the header's title; anything else the person tells an agent.
// Owns: the panel content. Never: chat-wide actions (chat-actions.ts).

import { useState } from 'preact/hooks';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { can } from '../lib/session.ts';
import { Icon } from '../lib/ui.tsx';
import { Bridges } from './details/Bridges.tsx';
import { Members } from './details/Members.tsx';
import { MessageSearch } from './details/MessageSearch.tsx';
import { Notes } from './details/Notes.tsx';
import { Schedules } from './details/Schedules.tsx';

export function ChatDetails(props: { chat: ConversationSummary }) {
  const { chat } = props;
  const [query, setQuery] = useState('');
  return (
    <div class="chat-details">
      <label class="details-search">
        <Icon name="magnifying-glass" size={16} />
        <input type="search" placeholder="Search messages" aria-label="Search this chat's messages" value={query}
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
      </label>
      <MessageSearch conversationId={chat.id} query={query} />
      {!query.trim() && (
        <>
          <Members chat={chat} />
          <Notes chat={chat} />
          <Schedules conversationId={chat.id} />
          {can('bridges.list') && <Bridges conversationId={chat.id} />}
        </>
      )}
    </div>
  );
}
