// The default 1:1 with a member (B-050 K1/K9): "Message" on an agent or a person, and the new-chat dialog
// with one member and no topic, open it – chats.direct finds it, adopts an older unnamed chat of exactly
// the two or creates it on first open (the owner's with an agent exists from the hire on – B-050 K1, Nachtrag
// Runde 4 –, so for an agent it is found). Wherever the session lists
// chats.direct this is the one path – the owner, a phone with 'chat', a person's device (its person
// variant, people/rpc-chats.ts); without it (an older runtime) a colleague's 1:1 is people.directChat, and
// an agent's "Message" opens the new-chat dialog with that agent chosen.
// Owns: opening that chat from the UI. Never: names or creates chats itself (the runtime does).

import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { newChatOpen } from '../lib/shell-state.ts';
import { agentMap, conversations, upsertById } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';

/** True when this connection opens the default 1:1 with `memberId` directly (else the new-chat dialog). */
export function directReachable(memberId: string): boolean {
  return can('chats.direct') || (!agentMap.value.has(memberId) && can('people.directChat'));
}

/** True when "Message" may show for this member here. */
export function canMessage(memberId: string): boolean {
  return directReachable(memberId) || (agentMap.value.has(memberId) && can('chats.create'));
}

/** Opens the default 1:1 with `memberId`; false when it failed (a notice says why). */
export async function openDirect(memberId: string): Promise<boolean> {
  try {
    if (can('chats.direct')) {
      const chat = await rpc.call('chats.direct', { memberId });
      upsertById(conversations, chat); // the row exists at once; conversation.upserted keeps it fresh
      go.chat(chat.id);
    } else {
      go.chat((await rpc.call('people.directChat', { id: memberId })).conversationId);
    }
    return true;
  } catch (error) {
    toastError(error, 'Could not open the chat');
    return false;
  }
}

/** "Message" on an agent or a person: their default 1:1, else (an agent on a person's device) the new-chat dialog. */
export function messageMember(memberId: string): void {
  if (directReachable(memberId)) void openDirect(memberId);
  else newChatOpen.value = { agentIds: [memberId] };
}
