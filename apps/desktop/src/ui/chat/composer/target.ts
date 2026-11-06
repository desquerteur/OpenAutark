// Whom the composer's message addresses (split from Composer.tsx): the agents its text @mentions
// (sent as `mentions`) and the agent the model chip applies to – the first mention, else the agent
// replied to (C6, as the runtime addresses a reply without @mention), else the lead, else the first agent.
// Owns: these two lookups. Never: sends, or changes the draft.

import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { agentMembers } from '../../lib/avatar.tsx';
import { agentMap, messagesFor } from '../../lib/store.ts';

/** Agent ids addressed with "@Name" in the text (members only). */
export function mentionsIn(text: string, chat: ConversationSummary): string[] {
  return agentMembers(chat).filter((id) => {
    const name = agentMap.value.get(id)?.name;
    return !!name && text.includes(`@${name}`);
  });
}

/** Agent the model chip applies to: first mention, else the agent replied to, else the lead, else the first agent. */
export function targetAgent(text: string, chat: ConversationSummary, replyTo?: string): string | null {
  const mentioned = mentionsIn(text, chat)[0];
  if (mentioned) return mentioned;
  const quoted = replyTo ? messagesFor(chat.id).peek().find((message) => message.id === replyTo) : undefined;
  if (quoted?.authorKind === 'agent' && agentMembers(chat).includes(quoted.authorId)) return quoted.authorId;
  const lead = chat.members.find((member) => member.kind === 'agent' && member.role === 'lead' && !member.leftAt);
  return lead?.memberId ?? agentMembers(chat)[0] ?? null;
}
