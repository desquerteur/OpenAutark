// The chat-list row's second line (ChatRow.tsx): a draft first, else the last message – with its
// sender in groups ("You: …", "Mira: …"). A last message without text yet (an agent still writing,
// or only tool steps so far) never shows a bare "Mira:": while agents work the line says who and what
// in the chat header's own words (`live`: live-text.ts liveStatus – "Manager: running a command, Ava:
// running a command +2"; C3 fix: one source for who is working), otherwise it stays empty.
// Owns: the line's text. Never: markup, fetching older messages.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { plainPreview } from '../lib/format.ts';

/** The row's preview line; `nameOf` gives an agent's name (undefined: unknown), `live` the chat header's live line. */
export function rowPreview(chat: ConversationSummary, nameOf: (id: string) => string | undefined, live?: () => string): string {
  const preview = chat.lastPreview;
  if (chat.draft) return `Draft: ${plainPreview(chat.draft, 120)}`;
  if (!preview) return '';
  const text = plainPreview(preview.text, 120);
  const name = preview.authorId === 'human' || preview.authorId === 'system' ? undefined : nameOf(preview.authorId);
  if (!text) return (chat.working.length ? live?.() : '') || (name && chat.working.includes(preview.authorId) ? `${name} is working…` : '');
  if (chat.members.filter((member) => member.leftAt === undefined).length <= 2) return text;
  if (preview.authorId === 'human') return `You: ${text}`;
  return name ? `${name}: ${text}` : text;
}
