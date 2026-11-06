// A chat as the caller sees it (B-050 K2/K9) – the same for the owner's window, the owner's phones and a
// person's device, where 'human' is always the caller: its title through the shared rule (displayTitle –
// a two-member room is named after the other member; where that knows no name – no stored title and
// nobody else in it, e.g. a default 1:1 whose partner was removed or lost their access – the UI's own
// label "Untitled chat", never a blank), its partner (the one active member besides the caller: the other one of a two-member
// room, or the only member of a room the caller is not in) and its quiet second line (the partner's role
// or title, else how many are in it). Plain data, so `.ts` modules and unit tests use it; the picture is
// lib/chat-face.tsx.
// Owns: these per-viewer views of a chat for the UI. Never: stores or derives stored titles (the runtime does).

import type { ConversationSummary, Member } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { counterpartId, displayTitle } from '../../shared/text/chat-names.ts';
import { knownAgentMap, settings } from './store.ts';
import { peopleMap } from './people.ts';
import { selfIdentity } from './self-identity.ts';

type ChatMembers = Pick<ConversationSummary, 'members'>;
type ChatNaming = Pick<ConversationSummary, 'title' | 'titleNamed' | 'settings' | 'members'>;

/** Shown for a chat nobody can name (no stored title, nobody else in it). */
export const UNTITLED_CHAT = 'Untitled chat';

/** A member's display name, undefined when unknown: the caller as the profile button names them, an agent (an archived one too), a person. */
export function memberName(id: string): string | undefined {
  if (id === HUMAN_ID) return selfIdentity(settings.value?.profile, peopleMap.value.get(HUMAN_ID)).name;
  return knownAgentMap.value.get(id)?.name ?? peopleMap.value.get(id)?.name;
}

function activeMembers(chat: ChatMembers): Member[] {
  return chat.members.filter((member) => !member.leftAt);
}

/** The chat's name for the caller (shared/text/chat-names.ts displayTitle), never empty (see the header). */
export function chatTitle(chat: ChatNaming): string {
  return displayTitle(chat, activeMembers(chat), HUMAN_ID, memberName) || UNTITLED_CHAT;
}

/** The one active member besides the caller (two-member room, or a room of one the caller is not in); else undefined. */
export function chatPartner(chat: ChatMembers): Member | undefined {
  const active = activeMembers(chat);
  const other = counterpartId(active, HUMAN_ID);
  if (other !== undefined) return active.find((member) => member.memberId === other);
  return active.length === 1 && active[0].memberId !== HUMAN_ID ? active[0] : undefined;
}

/** The partner's page, when it has one here: an agent's insight or a person's page. */
export function partnerPage(partner: Member | undefined): { kind: 'agent' | 'person'; id: string } | undefined {
  if (!partner) return undefined;
  if (partner.kind === 'agent') return { kind: 'agent', id: partner.memberId };
  return peopleMap.value.has(partner.memberId) ? { kind: 'person', id: partner.memberId } : undefined;
}

/** The quiet line under the chat's name: the partner's role (agent) or title (person), else "N agents" / "N members". */
export function chatSubtitle(chat: ChatMembers): string {
  const partner = chatPartner(chat);
  if (partner) return (knownAgentMap.value.get(partner.memberId)?.role ?? peopleMap.value.get(partner.memberId)?.title ?? '').trim();
  const others = activeMembers(chat).filter((member) => member.memberId !== HUMAN_ID);
  if (!others.length) return '';
  return others.every((member) => member.kind === 'agent') ? `${others.length} agents` : `${others.length} members`;
}
