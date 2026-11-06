// Names of chat members for readers outside the app (B-050 K8): the chat folders (chat-files/*) and
// the external protocol's event payloads (http/message-view.ts). The owner appears under the profile
// name, people of the organisation and agents under theirs, an 'ext:' member under its label (the last
// segment of its id), the system as "System"; a chat's title is the one its viewer sees (displayTitle).
// Owns: these lookups (one cache per call site, so a rename shows at the next write). Never: writes
// anything or decides who may see a chat.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import type { Conversation, Member } from '../../shared/model/chat.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { displayTitle } from '../../shared/text/chat-names.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/people.ts';

export type NameOf = (memberId: string) => string;
type NameSources = Partial<Pick<RuntimeServices, 'settings' | 'org' | 'people'>>;

/** A cached id → name lookup (create one per batch of writes). */
export function memberNamer(s: NameSources): NameOf {
  const cache = new Map<string, string>();
  return (memberId) => {
    let name = cache.get(memberId);
    if (name === undefined) {
      name = lookup(s, memberId);
      cache.set(memberId, name);
    }
    return name;
  };
}

function lookup(s: NameSources, memberId: string): string {
  if (memberId === HUMAN_ID) {
    try { return s.settings?.get().profile.name?.trim() || 'Owner'; } catch { return 'Owner'; }
  }
  if (memberId === SYSTEM_ID) return 'System';
  if (memberId.startsWith('ext:')) return memberId.split(':').pop()?.trim() || 'External';
  if (isPersonId(memberId)) {
    try { return s.people?.get(memberId)?.name ?? 'Former colleague'; } catch { return 'Former colleague'; }
  }
  try { return s.org?.get(memberId)?.name ?? memberId; } catch { return memberId; }
}

/** The chat's title as `viewerId` sees it (a 1:1 by the other member's name). */
export function chatTitleFor(chat: Pick<Conversation, 'title' | 'titleNamed' | 'settings'>, members: readonly Pick<Member, 'memberId' | 'leftAt'>[], viewerId: string, nameOf: NameOf): string {
  return displayTitle(chat, members.filter((member) => member.leftAt === undefined), viewerId, nameOf);
}
