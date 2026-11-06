// A chat's area: the first part of the chat column, right under the chat header row – the chat's own tabs (websites with
// the logins made in them, its notes, media, video, files, the screen …) in one workspace surface (workspace/
// WorkspacePane.tsx on chatSpace(id)), shared by everyone in the chat. Part of the chat, not of the frame: the chat's
// colour, rounded tabs, one line to the messages (chat-area.css), while the person's own pane at the frame's right keeps
// its Chrome look. Open it has one fixed height (the header cells and the composer never move; the message list keeps
// its newest line in view); the header's Chat tabs cell opens and closes it (ChatHeader.tsx), per chat.
// Owns: that section. Never: tab logic (workspace/pages.ts) or whether it is open (lib/shell-state.ts).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { chatSpace } from '../../shared/api/workspace-browser.ts';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';

export function ChatArea(props: { chat: ConversationSummary }) {
  return (
    <section class="chat-area" aria-label="Chat tabs">
      <WorkspacePane key={props.chat.id} space={chatSpace(props.chat.id)} />
    </section>
  );
}
