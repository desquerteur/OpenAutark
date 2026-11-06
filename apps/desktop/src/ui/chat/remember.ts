// "Remember why…", pure: which messages offer it and the references.remember call for the typed reason.
// Owns: those two rules. Never: RPC or DOM (RememberWhy.tsx does).

import type { Message } from '../../shared/model/chat.ts';

/** Whether `message` offers "Remember why…": the caller's own finished text message with words in it. */
export function offersRemember(message: Pick<Message, 'authorKind' | 'authorId' | 'kind' | 'state' | 'body'>, callerId: string): boolean {
  return message.authorKind === 'human' && message.authorId === callerId && message.kind === 'text' && message.state === 'final' && message.body.trim().length > 0;
}

/** The references.remember params for the typed reason: the message as an example plus the reason (the runtime picks the area). */
export function rememberParams(messageId: string, why: string): { messageId: string; why: string; whyKind: 'reason'; keepExample: true } {
  return { messageId, why: why.trim(), whyKind: 'reason', keepExample: true };
}
