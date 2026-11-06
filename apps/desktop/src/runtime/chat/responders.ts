// The responder decision of chat/delivery.ts (split out of it in C8 to keep it below 300 lines):
// the cheapest decision call that picks which member(s) of a group answer an un-addressed message –
// since B-050 round 4 of any author (chat/delivery-route.ts), the author never among the options.
// Owns: the question, the options (agent names, roles as context, and NOBODY – no reply needed, for
// every author) and reading the choice – one or two names, confidence at least 0.4, at most `max` (B-078 D8: 1 for a
// person's line, and the question then asks for one);
// NOBODY only from SURE_NOBODY on (below it the caller's fallback applies). C4-live (31.10.2026): the question names
// what NOBODY is for – the person's bare task line "Spülmaschine ausräumen" in a group got "nobody" and no answer.
// Never: wakes anyone (delivery does).

import { previewText } from '../../shared/text/chat-names.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isExternalAgent } from '../../shared/model/external-agents.ts';
import type { RuntimeServices } from '../contracts.ts';

/** The option that says no agent needs to reply (a statement, thanks, a closing note, a line to someone else). */
export const NOBODY = 'Nobody needs to reply';
/**
 * C4-live: the wake note of a picked responder (delivery-route.ts). Without it a picked colleague read the person's
 * un-addressed group line as not meant for it (rules: in groups speak when addressed or leading) and stayed silent.
 * The dispatcher treats such a wake like a plain line wake (dispatch-groups.ts plainMessage).
 */
export const PICKED_NOTE = 'The app picked me to answer the newest line in this chat that names no one: it is mine to act on.';
/** "Nobody" counts from this confidence on (the decision hub's sure answer); below it the pick is unsure. */
const SURE_NOBODY = 0.55;

/** Agent ids the decision model picked for `message` among `agents`; 'nobody' when no reply is needed; [] when it is unsure. */
export async function pickResponders(s: Partial<Pick<RuntimeServices, 'decisions' | 'org'>>, message: Message, agents: string[], max: number): Promise<string[] | 'nobody'> {
  if (!s.decisions) return [];
  const names = new Map(agents.map(id => [s.org?.get(id)?.name ?? id, id]));
  const author = s.org?.get(message.authorId)?.name ?? (message.authorKind === 'agent' || isExternalAgent(message.authorId) ? 'an agent' : 'a person');
  const result = await s.decisions.decide({
    purpose: 'responder',
    type: 'choice',
    question: `Which chat member should answer this message? ${max > 1 ? 'I pick one, or two separated by a comma if both are clearly needed' : 'I pick the one whose work it is'} – "${NOBODY}" fits a statement, thanks, a closing note or a line to someone else. A request or a task, even a bare one-liner such as "book the flight", needs a member.`,
    options: [...names.keys(), ...(names.has(NOBODY) ? [] : [NOBODY])],
    context: `From ${author}: ${previewText(message.body, message.attachments, 400)}\nMembers: ${[...names.keys()].map(name => {
      const agent = s.org?.get(names.get(name)!);
      return agent?.role ? `${name} (${agent.role})` : name;
    }).join(', ')}`,
  });
  if (result.choice === NOBODY && !names.has(NOBODY)) return result.confidence >= SURE_NOBODY ? 'nobody' : [];
  if (!result.choice || result.confidence < 0.4) return [];
  const picked: string[] = [];
  for (const part of result.choice.split(/[,;+&]| and /)) {
    const id = names.get(part.trim());
    if (id && !picked.includes(id)) picked.push(id);
  }
  return picked.slice(0, max);
}
