// Sending the composer's draft (split from Composer.tsx): Send, and /important or /silent with text
// (composer/slash.ts) and the Plus menu's levels send the whole draft – the text (or the command's text), its
// files, secret handles, how it was dictated (SM8) and the message it replies to – at one level, with Ultra
// when the person suggested it for this message.
// The field empties at once and the draft is fresh for the next message (level back to normal, Ultra off); a failed
// send gives everything back, the text as it was typed.
// The composer sends `silent: true` only for a silent message, never `silent: false`.
// Owns: that one send path. Never: parses commands (slash.ts), or renders.

import { newId } from '../../../shared/ids.ts';
import type { MessageLevel } from '../../../shared/model/chat.ts';
import '../../../shared/model/splits.ts'; // B-057: SendMessageInput.ultra (module augmentation)
import { rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';
import { clearDraft, draftFor, updateDraft } from './draft.ts';
import { takeDraftSpeech } from './draft-speech.ts';

export interface DraftSend {
  conversationId: string;
  /** The text to send: the draft's, or a level command's text. */
  body: string;
  level: MessageLevel;
  /** The agents the sent text @mentions (composer/target.ts mentionsIn). */
  mentions: (body: string) => string[];
  /** B-057: the chat offers the Ultra cell now (UltraCell ultraOffered) – a draft's hidden Ultra is not sent. */
  ultraOffered?: boolean;
}

/** Sends the chat's draft as `body` at `level`; false when it failed (a notice says why, the draft is back). */
export async function sendDraft(send: DraftSend): Promise<boolean> {
  const { conversationId, level } = send;
  const saved = draftFor(conversationId).peek();
  const spoken = takeDraftSpeech(conversationId);
  clearDraft(conversationId); // optimistic: the field empties at once, restored on error (with its speech)
  const body = send.body.trim();
  const attachments = saved.attachments;
  try {
    await rpc.call('messages.send', {
      conversationId, body,
      attachments: attachments.length ? attachments : undefined,
      secrets: saved.secrets?.length ? saved.secrets : undefined,
      mentions: send.mentions(body),
      priority: level === 'important' ? 'important' : 'normal', ...(level === 'silent' ? { silent: true } : {}),
      clientId: newId('req'), replyTo: saved.replyTo,
      ...(spoken.speech ? { speech: spoken.speech } : {}),
      ...(saved.ultra && send.ultraOffered ? { ultra: true } : {}), // B-057: a hint for this message, the agent decides
    });
    return true;
  } catch (error) {
    toastError(error, 'Message not sent');
    updateDraft(conversationId, saved); // saved again (clearDraft persisted the empty draft)
    spoken.restore();
    return false;
  }
}
