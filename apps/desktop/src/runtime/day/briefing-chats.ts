// Chats that matter in the morning briefing (B-041 track A2, the My day concept §6.4): the one
// deterministic ranking Home uses too (shared/model/chat-rank.ts) – an agent waits on the person there (an open
// to-do someone else raised in it that needs them now) > important unread messages > unread messages (not
// muted) > an agent working there > the person wrote there in the last 24 h; newer activity first within a
// rank; at most BRIEFING_LIMITS.chats, each with a short reason. App chats (To-do, Inbox), hidden, agent-only
// and archived chats and people's own chats never count. Reads only counts, ids and authors – never a message
// body (lastPreview's text stays unread).
// Owns: that ranking. Never: message text, or a chat the owner may not open.

import { HUMAN_ID } from '../../shared/ids.ts';
import { BRIEFING_LIMITS } from '../../shared/model/calendar.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { chatSignal, compareRanked, rankable, type ChatSignal } from '../../shared/model/chat-rank.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

export interface ChatSignals {
  /** Open to-dos others raised that wait on the person now, per chat (shared/model/chat-rank.ts waitingByChat). */
  waits: ReadonlyMap<string, number>;
  /** An agent's display name. */
  nameOf: (agentId: string) => string;
  now: number;
}

export type RankedChat = { conversationId: string; reason: string };

/** The chats worth a look this morning, best first (see the header). */
export function rankChats(chats: readonly ConversationSummary[], signals: ChatSignals): RankedChat[] {
  const scored: Array<{ chat: ConversationSummary; signal: ChatSignal; reason: string }> = [];
  for (const chat of chats) {
    if (!rankable(chat)) continue;
    const waits = signals.waits.get(chat.id) ?? 0;
    const signal = chatSignal(chat, waits, signals.now);
    if (!signal) continue;
    const reason = signal === 'waits' ? (waits === 1 ? 'Waits for your answer' : `${waits} things wait for you`)
      : signal === 'important' ? `${chat.importantUnread} important unread`
        : signal === 'unread' ? `${chat.unread} unread`
          : signal === 'working' ? `${signals.nameOf(chat.working.find((id) => id !== HUMAN_ID)!)} is working`
            : 'You wrote here today';
    scored.push({ chat, signal, reason: excerpt(reason, BRIEFING_LIMITS.reason) });
  }
  return scored.sort(compareRanked).slice(0, BRIEFING_LIMITS.chats).map(({ chat, reason }) => ({ conversationId: chat.id, reason }));
}

/** The ranking in the order a helper model proposed (1-based positions of `ranked`); unknown or repeated positions are skipped, the rest keep their place after. */
export function reorder(ranked: readonly RankedChat[], order: unknown): RankedChat[] {
  if (!Array.isArray(order)) return [...ranked];
  const picked: RankedChat[] = [];
  for (const position of order) {
    const chat = Number.isInteger(position) ? ranked[(position as number) - 1] : undefined;
    if (chat && !picked.includes(chat)) picked.push(chat);
  }
  return [...picked, ...ranked.filter((chat) => !picked.includes(chat))];
}
