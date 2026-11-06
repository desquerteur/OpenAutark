// Creating a conversation, split from chat/service.ts (C2, to make room there): the title (the
// given one, else none – B-050 K2: every viewer sees the other members' names), the space (given, else the first agent's), the lead
// (chat/lead.ts pickLead: the explicit choice, else by rule), the initial settings (cleaned – a
// hidden or app-owned chat is so from its first event on) and the member rows, the person as
// 'owner' when they started it, and F-52 the people it names (a person who started it as its 'owner'),
// in one transaction.
// Owns: those writes. Never: emits events (the chat service announces the new chat).

import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Conversation } from '../../shared/model/chat.ts';
import type { ChatService, OrgService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { ConversationRepo } from './conversation-repo.ts';
import { pickLead } from './lead.ts';
import { cleanSettings } from './sticky-model.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { activePerson } from '../people/repo.ts';

export interface CreateDeps {
  db: Db;
  convs: ConversationRepo;
  org?: OrgService;
  now: number;
  nameOf(memberId: string): string;
}

export function createConversation(deps: CreateDeps, input: Parameters<ChatService['create']>[0]): Conversation {
  const { convs, org, now } = deps;
  const agentIds = [...new Set(input.agentIds)];
  for (const id of agentIds) {
    if (org && !org.get(id)) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: id } });
  }
  const withHuman = input.humans ?? true;
  // F-52: people of the organisation (active only), the creator first – a chat without the owner is possible.
  const people = [...new Set((input.people ?? []).filter((id) => isPersonId(id)))];
  for (const id of people) {
    if (!activePerson(deps.db, id)) throw new WorkforceError('not_found', 'This person is no longer in the organisation.', { details: { personId: id } });
  }
  if (!agentIds.length && !withHuman && !people.length) throw new WorkforceError('bad_request', 'A chat needs at least one member.');
  const title = input.title?.trim() ?? '';
  const conversation: Conversation = {
    id: newId('ch', now),
    // B-050 K2: without a given title a chat stays untitled – each viewer sees the other members' names
    // (shared/text/chat-names.ts displayTitle) until a first human message names it (chat/service.ts deriveTitle).
    title,
    titleNamed: Boolean(title),
    createdBy: input.createdBy,
    pinned: false,
    // F-52: people without the owner – marked as the people's chat until the owner joins.
    settings: cleanSettings({ ...input.settings, ...(people.length && !withHuman ? { peopleChat: true } : {}) }),
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const spaceId = input.spaceId ?? (agentIds.length ? org?.get(agentIds[0])?.spaceId : undefined);
  if (spaceId) conversation.spaceId = spaceId;
  const lead = pickLead({ agentIds, createdBy: input.createdBy, explicit: input.lead, org });
  deps.db.tx(() => {
    convs.insert(conversation);
    if (withHuman) {
      convs.upsertMember({ conversationId: conversation.id, memberId: HUMAN_ID, kind: 'human', role: input.createdBy === HUMAN_ID ? 'owner' : 'member', readSeq: 0, joinedAt: now });
    }
    for (const id of people) {
      convs.upsertMember({ conversationId: conversation.id, memberId: id, kind: 'human', role: input.createdBy === id ? 'owner' : 'member', readSeq: 0, joinedAt: now });
    }
    for (const id of agentIds) {
      convs.upsertMember({ conversationId: conversation.id, memberId: id, kind: 'agent', role: id === lead ? 'lead' : 'member', readSeq: 0, joinedAt: now });
    }
  });
  return conversation;
}
