// The archive in the chat list and the chat details (C2). Archiving only takes a chat out of the
// person's list – its agents keep working there – and the runtime brings it back by itself when
// something needs the person (chat/lifecycle.ts). Archived chats of either section are listed in
// the collapsed "Archived" section at the end of the list; app-owned system chats in no section.
// Owns: which list section a chat is in and the archive confirmation text. Never: calls the
// runtime, reads the store, or defines the main/team rule (shared/text/chat-sections.ts).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';

export type ListSection = 'main' | 'team' | 'archived';

/** The list section a chat shows in; undefined for a system chat (in no list). */
export function listSection(chat: Pick<ConversationSummary, 'settings' | 'members' | 'archivedAt'>): ListSection | undefined {
  const section = chatSection(chat);
  if (section === 'system') return undefined;
  return chat.archivedAt !== undefined ? 'archived' : section;
}

/** The archive confirmation: the chat leaves the list, its work goes on (open tasks count the person's to-dos too). */
export function archiveNote(openTasks: number): string {
  const work = openTasks === 1 ? 'Work on its open task goes on' : openTasks > 1 ? `Work on its ${openTasks} open tasks goes on` : 'Its agents keep working there';
  return `It leaves your chat list. ${work}, and it comes back when something needs you.`;
}
