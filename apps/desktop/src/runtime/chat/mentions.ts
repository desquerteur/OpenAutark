// @mention candidates of a chat message (split from chat/service.ts): the members other than the
// author, with the human under every name agents use for them – the profile name (the label
// agents see in their context, context/render.ts humanLabel), "CEO", "Human" and "You" – so an
// agent's "@Gerd, the upload needs your login code" reaches the person even in a quiet turn.
// Owns: the human's mention aliases and the tie rule: an agent named like the person loses to the
// person (agents see that agent as "Name (agent)", never under the person's label); which mentioned
// ids are people (B-047 D4: a mention of them makes a quiet agent message loud).
// Never: changes how members are named in titles, status lines or search (ChatService.nameOf).

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Member } from '../../shared/model/chat.ts';
import { isExternalAgent } from '../../shared/model/external-agents.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { SettingsService } from '../contracts.ts';

/** A mentioned id that is a person: the owner, a person of the organisation, a bridged contact (never an external agent, C8). */
export function isPersonMention(id: string): boolean {
  return id === HUMAN_ID || isPersonId(id) || (id.startsWith('ext:') && !isExternalAgent(id));
}

/** Names that always mean the human, besides the profile name. */
export const HUMAN_ALIASES: readonly string[] = ['CEO', 'Human', 'You'];

/** The human's mention names: the trimmed profile name (when set) first, then the fixed aliases. */
export function humanAliases(settings: Pick<SettingsService, 'get'> | undefined): string[] {
  let profile = '';
  try { profile = settings?.get().profile?.name?.trim() ?? ''; } catch { /* settings not wired */ }
  return [...new Set([profile, ...HUMAN_ALIASES].filter(Boolean))];
}

/**
 * Candidates for findMentions: every member except the author; the human (when a member) under
 * all aliases. The human comes first because findMentions keeps the first of equally long names.
 */
export function mentionCandidates(
  members: readonly Pick<Member, 'memberId'>[],
  authorId: string,
  nameOf: (memberId: string) => string,
  settings: Pick<SettingsService, 'get'> | undefined,
): Array<{ id: string; name: string }> {
  const others = members.filter((member) => member.memberId !== authorId);
  const human = others.some((member) => member.memberId === HUMAN_ID) ? humanAliases(settings).map((name) => ({ id: HUMAN_ID, name })) : [];
  const rest = others.filter((member) => member.memberId !== HUMAN_ID).map((member) => ({ id: member.memberId, name: nameOf(member.memberId) }));
  return [...human, ...rest];
}
