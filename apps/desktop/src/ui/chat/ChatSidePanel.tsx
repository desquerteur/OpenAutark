// The chat's details panel beside the messages (a bottom sheet on the phone). It is content below the chat header row:
// on the desktop its name and X sit in that row above it (ChatHeader.tsx), so its body starts right under the row; the
// phone's sheet keeps its own top line and lies over a scrim (a tap there closes it like the X). Open or not is
// remembered per chat. The chat's tabs are its area above the messages (ChatArea.tsx), not here. B-078: the panel shows
// either the details or one thread of the chat (ThreadPanel.tsx; which one: shell-state.ts chatThread).
// Owns: the panel frame. Never: the details' contents.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { IconButton } from '../lib/ui.tsx';
import { chatThread, type ChatPanel } from '../lib/shell-state.ts';
import { isMobile } from '../lib/store.ts';
import { ChatDetails } from './ChatDetails.tsx';
import { PANEL_TITLES } from './ChatHeader.tsx';
import { ThreadPanel } from './ThreadPanel.tsx';

export function ChatSidePanel(props: { chat: ConversationSummary; panel: ChatPanel; onClose: () => void }) {
  const { chat, panel } = props;
  const sheet = isMobile.value;
  const thread = panel === 'thread' ? chatThread.value : null;
  if (panel === 'thread' && !thread) return null;
  return (
    <>
      {sheet && <div class="chat-panel-scrim" aria-hidden="true" onClick={props.onClose} />}
      <aside class={`chat-panel${sheet ? ' sheet' : ''}`} aria-label={PANEL_TITLES[panel]}>
        {sheet && (
          <div class="chat-panel-top">
            <h3 class="chat-panel-title">{PANEL_TITLES[panel]}</h3>
            <IconButton icon="x" label="Close" size="small" class="chat-panel-close" onClick={props.onClose} />
          </div>
        )}
        {thread ? <ThreadPanel threadId={thread} /> : (
          <div class="chat-panel-body">
            <ChatDetails chat={chat} />
          </div>
        )}
      </aside>
    </>
  );
}
