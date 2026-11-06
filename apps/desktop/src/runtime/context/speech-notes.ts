// What the person's spoken message adds to its chat line (context/render.ts content()): a line said in the chat's
// live call names the device it came from and that answers are read aloud (callNote). Also how a quoted phrase
// reads in a chat line (quote).
// Owns: that note and quote. Never: adds a note to an agent's or a typed message.

import type { RuntimeServices } from '../contracts.ts';
import type { Message } from '../../shared/model/chat.ts';

/** The part of context/render.ts RenderContext the notes read. */
export interface SpeechContext {
  services: RuntimeServices;
  agentId: string;
}

/** `"text"` on one line, at most 120 characters, its double quotes as single ones. */
export const quote = (text: string) => `"${text.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 120)}"`;

/** A call line: `(said in the live call of this chat, from Pixel – answer briefly; it is read aloud)`. */
export function callNote(message: Pick<Message, 'meta'>): string | undefined {
  const call = message.meta.call;
  if (!call || typeof call.name !== 'string') return undefined;
  const from = call.name.replace(/[\u0000-\u001f\u007f-\u009f()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `(said in the live call of this chat${from ? `, from ${from}` : ''} – answer briefly; it is read aloud)`;
}

/** The notes under the body of the person's message (the call line); none for others. */
export function speechNotes(_ctx: SpeechContext, message: Pick<Message, 'authorKind' | 'body' | 'conversationId' | 'meta'>): string[] {
  if (message.authorKind !== 'human') return [];
  const call = callNote(message);
  return call ? [call] : [];
}
