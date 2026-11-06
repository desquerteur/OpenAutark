// A chat's title as one member sees it, for runtime texts (B-050 K2): shared/text/chat-names.ts
// displayTitle with the runtime's member names – an agent's name, a person's (F-52), a bridged
// contact's label, the owner's profile name (else the people register's name for them, "CEO", as
// people/escalation.ts has no settings). A two-member room is named after the other member.
// Owns: that lookup. Never: stores a title (the stored title stays what was named or derived).

import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { displayTitle } from '../../shared/text/chat-names.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/people.ts';

/** The name sources (each optional – a missing one leaves its members unnamed). */
export interface NameDeps {
  org?: Pick<RuntimeServices['org'], 'get'>;
  people?: Pick<NonNullable<RuntimeServices['people']>, 'nameOf'>;
  settings?: Pick<RuntimeServices['settings'], 'get'>;
}
type TitleDeps = NameDeps & { chats: Pick<RuntimeServices['chats'], 'get' | 'members'> };

/** A member's display name for titles; undefined when unknown. The owner: the profile name, else what the people register calls them ("CEO"). */
export function memberName(s: NameDeps, id: string): string | undefined {
  if (id === HUMAN_ID) {
    let profile: string | undefined;
    try { profile = s.settings?.get().profile?.name?.trim() || undefined; } catch { profile = undefined; }
    return profile ?? (s.people?.nameOf(id)?.trim() || undefined);
  }
  if (id.startsWith('ext:')) return id.split(':').pop() || undefined; // the label ends the id
  if (isPersonId(id)) return s.people?.nameOf(id);
  return s.org?.get(id)?.name;
}

/** The title of chat `conversationId` for `viewerId` (see displayTitle); '' when the chat is unknown or nothing names it. */
export function chatTitleFor(s: TitleDeps, conversationId: string, viewerId: string): string {
  const chat = s.chats.get(conversationId);
  if (!chat) return '';
  return displayTitle(chat, s.chats.members(conversationId), viewerId, (id) => memberName(s, id));
}
