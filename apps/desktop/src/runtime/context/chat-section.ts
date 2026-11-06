// "## This chat" of the volatile prompt (context/prompt-volatile.ts), B-050 K2/K3/K5: the title as this agent sees it
// (shared/text/chat-names.ts displayTitle – a room of two is named after the other member) and what the room is.
// Every member is named alike: a room of two is "1:1 chat with <name>" whoever the other is (the CEO, a colleague, an
// agent, an external member); a larger room is "group with A, B, C" – a discussion among peers. The CEO is only
// labelled as such; the owner-only facts (an agent work chat not in the CEO's list, F-52: the CEO not in a colleagues'
// chat) stay notes, as do the lead, the chat's mode and shared notes (wave 3).
// Round 3 re-check (live run A: the manager opened a work group from its 1:1, was told to end its turn after its line,
// and in the group's turns never knew that the person had asked "then tell me the result here"): when the agent's
// newest line here was sent (chat.send) from a turn in another chat, a line names that chat and the person's
// request the turn served there – until the agent writes there again from another turn (sentFrom).
// B-075 (owner 04.11.2026): the section speaks as the agent itself ("only me", "I am the lead", "I wrote #…").
// B-078 (owner 06.11.: "Für was soll ich das eigentlich benutzen?"): each kind says what it is for – a 1:1 stays us two
// and the CEO's 1:1 is where what they need from me goes; a room without any person is an internal room of us agents
// the CEO gets nothing from; a sub-chat names its parent, a thread the message it answers.
// Owns: that section's wording. Never: a bare 'ext:' id (C8), the shared notes' text or version.

import type { RuntimeServices } from '../contracts.ts';
import type { ConversationSettings, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { externalMemberLabel, isExternalAgent } from '../../shared/model/external-agents.ts';
import { displayTitle, excerpt } from '../../shared/text/chat-names.ts';
import { notesVersion } from '../notes/store.ts';
import { personLabel } from './render.ts';

function personName(services: RuntimeServices, id: string): string | undefined {
  try { return services.people?.get(id)?.name; } catch { return undefined; }
}

export function chatSection(services: RuntimeServices, agent: Agent, conversationId: string): string {
  const conversation = services.chats.get(conversationId);
  if (!conversation) return '';
  const active = services.chats.members(conversationId).filter((member) => !member.leftAt);
  const members = active.filter((member) => member.memberId !== agent.id);
  const profileName = (() => { try { return services.settings.get().profile.name?.trim() || ''; } catch { return ''; } })();
  const human = profileName || 'the CEO';
  /** A member's plain name (the title); C8: an 'ext:' member reads "<label> (external agent)" / "(external contact)". */
  const nameOf = (id: string): string | undefined => id === HUMAN_ID ? human
    : isPersonId(id) ? personName(services, id)
      : externalMemberLabel(id) ?? services.org.get(id)?.name;
  /** A member as the chat line names it: the CEO marked, a colleague with role and id (F-52: tasks.assign takes it). */
  const label = (id: string): string => id === HUMAN_ID ? (profileName ? `${profileName} (CEO)` : 'the CEO')
    : isPersonId(id) ? `${personLabel({ services, humanName: human }, id)} [${id}]` : nameOf(id) ?? id;
  const title = displayTitle(conversation, active, agent.id, nameOf) || 'Untitled chat';
  const ceoIn = members.some((member) => member.memberId === HUMAN_ID);
  let kind: string;
  if (members.length === 1) kind = `1:1 chat with ${label(members[0].memberId)}`;
  else if (!members.length) kind = 'only me';
  else kind = `group with ${members.map((member) => label(member.memberId)).sort().join(', ')} · a discussion among peers${ceoIn ? ` ${human} takes part in` : ''}`;
  const extras: string[] = [];
  if (conversation.settings.direct && members.length === 1) extras.push(ceoIn ? `it stays us two; what ${human} needs from me goes here` : 'it stays us two');
  if (!members.some((member) => member.kind !== 'agent')) extras.push(`internal room of us agents – ${human} gets nothing from here; what ${human} should know goes to my 1:1 with ${human}`);
  const place = placeOf(services, conversation.settings, agent.id, nameOf);
  if (place) extras.push(place);
  if (services.chats.lead(conversationId) === agent.id && members.length > 1) extras.push('I am the lead (I answer un-addressed messages)');
  if (conversation.settings.hiddenFromList) extras.push(`agent work chat, not in ${human}'s chat list`);
  // F-52: a chat of colleagues without the CEO – the CEO neither reads it nor answers here.
  if (members.some((member) => isPersonId(member.memberId)) && !members.some((member) => member.memberId === HUMAN_ID)) extras.push(`${human} is not in this chat`);
  if (conversation.settings.mode) extras.push(`mode: ${conversation.settings.mode}`);
  // wave 3: the chat has shared notes – neither their text nor their version (a change names the version the agent read)
  if (notesVersion(services.db, conversationId) > 0) extras.push('has shared notes (chat.notes.read)');
  const origin = sentFrom(services, agent.id, conversationId, nameOf);
  return [`## This chat`, `${title} (${conversation.id}) · ${kind}${extras.length ? ` · ${extras.join(' · ')}` : ''}`, ...(origin ? [origin] : [])].join('\n');
}

/** B-078: where a sub-chat or a thread sits – its parent as this agent sees it (and the anchor's #seq). */
function placeOf(services: RuntimeServices, settings: ConversationSettings, agentId: string, nameOf: (id: string) => string | undefined): string | undefined {
  if (!settings.parentId) return undefined;
  const parent = services.chats.get(settings.parentId);
  if (!parent) return undefined;
  const title = displayTitle(parent, services.chats.members(parent.id).filter((member) => !member.leftAt), agentId, nameOf) || 'Untitled chat';
  if (!settings.anchorId) return `sub-chat of "${title}" (${parent.id})`;
  const anchor = services.chats.message(settings.anchorId);
  return `thread on ${anchor ? `#${anchor.seq}` : 'a message'} of "${title}" (${parent.id}) – the work on that message goes here`;
}

const fromPerson = (message: Message) => message.authorKind === 'human' || (message.authorKind === 'external' && !isExternalAgent(message.authorId));

/** The agent's newest line here, sent by chat.send from a turn in another chat that served a person's request: that chat and request (see the header). */
function sentFrom(services: RuntimeServices, agentId: string, conversationId: string, nameOf: (id: string) => string | undefined): string | undefined {
  try {
    const own = services.chats.messages(conversationId, { limit: 50 }).filter((message) => message.authorId === agentId && message.kind === 'text' && message.meta.sentDuringRun === true).at(-1);
    const origin = own?.runId ? services.runs.get(own.runId)?.conversationId : undefined;
    if (!own || !origin || origin === conversationId) return undefined;
    const there = services.chats.messages(origin, { limit: 50 });
    // Written there since, from another turn (the sending turn's own final there does not count): taken care of.
    if (there.some((message) => message.authorId === agentId && message.kind === 'text' && message.createdAt > own.createdAt && message.runId !== own.runId)) return undefined;
    const request = there.filter((message) => message.kind === 'text' && !message.silent && message.createdAt <= own.createdAt && fromPerson(message)).at(-1);
    const chat = services.chats.get(origin);
    if (!request || !chat) return undefined;
    const title = displayTitle(chat, services.chats.members(origin), agentId, nameOf) || 'Untitled chat';
    return `I wrote #${own.seq} here from my chat "${title}" (${origin}) for ${nameOf(request.authorId) ?? 'a person'}'s request there: "${excerpt(request.body, 300)}" What it asks for there (a result, a reply) goes there – chat.send with that chatId.`;
  } catch {
    return undefined; // a fake without messages or runs: no such line
  }
}
