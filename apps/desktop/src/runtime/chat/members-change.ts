// Member changes of a chat, split from chat/service.ts (MM6, to make room there): adds members
// (the person starts "read" at the join point, agents may backfill history through their
// context), removes them, and keeps one lead agent – the explicit choice, else the current
// lead while still a member, else chat/lead.ts pickLead – all in one transaction. F-52: a chat left
// to people only is marked theirs (settings.peopleChat) until the owner joins it visibly. B-050 K1:
// the default 1:1 mark (settings.direct, chat/direct.ts) stays with its pair and ends when one of the
// two leaves; it never passes to another pair (keepDirectPair). B-078 D7: a 1:1 stays two – an add of
// an agent or a person to a marked 1:1 is refused with DIRECT_STAYS_TWO (a person's own call: DIRECT_STAYS_TWO_PERSON; a bridged outside contact,
// 'ext:…', still joins: it is the chat's channel, not a third partner).
// Owns: those writes. Never: posts the status lines or emits events (the chat service does,
// after the transaction).

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { directPair, type Conversation, type Member, type StatusLine } from '../../shared/model/chat.ts';
import type { OrgService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { ConversationRepo } from './conversation-repo.ts';
import { pickLead } from './lead.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { activePerson } from '../people/repo.ts';

export interface MemberChange { add?: string[]; remove?: string[]; lead?: string }

/** B-078 D7: the refusal when someone would join a 1:1 – in the voice of the one who tried. */
export const DIRECT_STAYS_TWO = 'This 1:1 stays between the two of us. For more people I start a group with chat.create; a colleague I talk to in my own 1:1 with them (chat.send to).';
/** The same for a person (the owner's or a colleague's client): the words of the window, no tool names. */
export const DIRECT_STAYS_TWO_PERSON = 'A 1:1 stays two. For more people, start a group with them.';

const staysTwoFor = (by: string): string => (by === HUMAN_ID || isPersonId(by) ? DIRECT_STAYS_TWO_PERSON : DIRECT_STAYS_TWO);

/**
 * B-050 K1, after a member change of a default 1:1 (settings.direct): the mark stays while both of its
 * pair are active members – an older mark without a stored pair gets the pair of `before` (the
 * active members before the change) –, else it goes. When it goes and the chat has no title (a default
 * 1:1 stores none) and at most one member is left, the name of the pair's member who left becomes its
 * title (`nameOf`; not a named one, titleNamed stays false), so the former 1:1 keeps its name. Written;
 * call inside the transaction.
 */
export function keepDirectPair(convs: ConversationRepo, conversation: Conversation, before: readonly Member[], nameOf?: (memberId: string) => string): void {
  if (!conversation.settings.direct) return;
  const pair = directPair(conversation.settings, before);
  const active = new Set(convs.members(conversation.id).map((member) => member.memberId));
  if (pair && pair.every((id) => active.has(id))) {
    if (conversation.settings.directPair) return;
    conversation.settings = { ...conversation.settings, directPair: [pair[0], pair[1]] };
  } else {
    const { direct: _direct, directPair: _pair, ...rest } = conversation.settings;
    conversation.settings = rest;
    const gone = pair?.find((id) => !active.has(id));
    if (!conversation.title.trim() && gone && nameOf && active.size < 2) conversation.title = nameOf(gone); // others still there name it themselves
  }
  convs.update(conversation);
}

export interface MemberDeps {
  db: Db;
  convs: ConversationRepo;
  org?: OrgService;
  nameOf(memberId: string): string;
}

/** Writes the change; returns the 'member_added' / 'member_removed' lines to post. */
export function changeMembers(deps: MemberDeps, conversation: Conversation, change: MemberChange, by: string, now: number): StatusLine[] {
  const { convs, org } = deps;
  const id = conversation.id;
  const lines: StatusLine[] = [];
  deps.db.tx(() => {
    const peopleChat = conversation.settings.peopleChat === true; // F-52: the people's own chat before this change
    const before = convs.members(id);
    const hiddenBefore = peopleChat;
    for (const memberId of change.add ?? []) {
      const existing = convs.member(id, memberId);
      if (existing && existing.leftAt === undefined) continue;
      // F-52: a person of the organisation joins as a human member (history from now, people/access.ts).
      const kind: Member['kind'] = memberId === HUMAN_ID || isPersonId(memberId) ? 'human' : memberId.startsWith('ext:') ? 'external' : 'agent';
      if (conversation.settings.direct && kind !== 'external') throw new WorkforceError('conflict', staysTwoFor(by), { details: { conversationId: id, reason: 'direct' } });
      if (kind === 'agent' && org && !org.get(memberId)) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: memberId } });
      if (isPersonId(memberId) && !activePerson(deps.db, memberId)) throw new WorkforceError('not_found', 'This person is no longer in the organisation.', { details: { personId: memberId } });
      convs.upsertMember({ conversationId: id, memberId, kind, role: 'member', readSeq: kind === 'human' ? conversation.lastSeq : 0, joinedAt: now });
      // The owner joining the people's own chat is a visible take-over (people/service.ts audits it for each person in it).
      const takeover = memberId === HUMAN_ID && hiddenBefore;
      lines.push({ type: 'member_added', text: `Added ${deps.nameOf(memberId)}`, details: { memberId, by, ...(takeover ? { takeover: true } : {}) } });
    }
    for (const memberId of change.remove ?? []) {
      if (convs.leave(id, memberId, now)) lines.push({ type: 'member_removed', text: `Removed ${deps.nameOf(memberId)}`, details: { memberId, by } });
    }
    const active = convs.members(id);
    // F-52: a people's chat stays marked until the owner joins it.
    const owned = active.some(m => m.memberId === HUMAN_ID) ? false : peopleChat;
    if (owned !== peopleChat) {
      const { peopleChat: _before, ...rest } = conversation.settings;
      conversation.settings = owned ? { ...rest, peopleChat: true } : rest;
      convs.update(conversation);
    }
    keepDirectPair(convs, conversation, before, deps.nameOf);
    const agents = active.filter(m => m.kind === 'agent').map(m => m.memberId);
    const currentLead = active.find(m => m.role === 'lead')?.memberId;
    const wanted = change.lead && agents.includes(change.lead) ? change.lead
      : currentLead && agents.includes(currentLead) ? currentLead
      : pickLead({ agentIds: agents, createdBy: conversation.createdBy, org });
    for (const member of active) {
      if (member.kind !== 'agent') continue;
      const role: Member['role'] = member.memberId === wanted ? 'lead' : member.role === 'lead' ? 'member' : member.role;
      if (role !== member.role) convs.setRole(id, member.memberId, role);
    }
  });
  return lines;
}
