// The quote line of a reply (C6): above a reply in the timeline, and – "Replying to …" with a
// cancel button – above the composer field while the person writes one. The quoted author and the
// start of the quoted message (previewText); a click jumps to it (tasks/jump.ts: focusMessage,
// paging older history in). A quoted message that is gone reads "Deleted message" (its tombstone
// is loaded, or all of the history is and it is not); one that is not loaded yet "Earlier message".
// "You" is only the caller's own words; another human is named (B-041, people-model.ts messageSide).
// Owns: that line. Never: loads messages beyond the jump, or quotes a message of another chat.

import type { Message } from '../../shared/model/chat.ts';
import { quotedIn } from '../../shared/model/message-changes.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import { agentName, historyComplete, messagesFor } from '../lib/store.ts';
import { IconButton } from '../lib/ui.tsx';
import { jumpToMessage } from '../tasks/jump.ts';
import { messageSide } from '../team/people-model.ts';

function authorOf(message: Message): string {
  const side = messageSide(message);
  if (side === 'own') return 'You';
  if (side === 'person') return agentName(message.authorId);
  if (message.authorKind === 'external') return message.authorId.split(':').pop() || 'External contact';
  return message.authorKind === 'system' ? 'System' : agentName(message.authorId);
}

export function ReplyQuote(props: { conversationId: string; messageId: string; onCancel?: () => void }) {
  const { conversationId, messageId, onCancel } = props;
  const quoted = quotedIn(messagesFor(conversationId).value, messageId, historyComplete.has(conversationId));
  const message = typeof quoted === 'object' ? quoted : undefined;
  const gone = quoted === 'deleted';
  const text = gone ? 'Deleted message' : message ? previewText(message.body, message.attachments) || 'Message' : 'Earlier message';
  const who = message ? authorOf(message) : undefined;
  const replying = message && messageSide(message) === 'own' ? 'yourself' : who ?? 'a message';
  return (
    <div class={`reply-quote${onCancel ? ' in-composer' : ''}${gone ? ' gone' : ''}`}>
      <button type="button" class="reply-quote-jump" disabled={gone} title={gone ? undefined : 'Show the quoted message'}
        onClick={() => void jumpToMessage(conversationId, messageId)}>
        {(onCancel || who) && <span class="reply-quote-author">{onCancel ? `Replying to ${replying}` : who}</span>}
        <span class="reply-quote-text">{text}</span>
      </button>
      {onCancel && <IconButton icon="x" label="Cancel reply" size="small" iconSize={14} onClick={onCancel} />}
    </div>
  );
}
