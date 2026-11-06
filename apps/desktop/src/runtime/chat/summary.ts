// List-row projection of conversations (ConversationSummary): members, unread (and how many of them are
// important – B-041 Home and briefing), preview, a thread's reply count (B-078), working agents, open tasks and draft – built with a few batched
// queries, no message load. B-075: who works and what comes from the chat's rows in state 'streaming' (`live`, and
// `working` their agents) – the same on every PC the rows reach, never from this PC's memory. A row that still streams
// previews no text, so the list's line says who works and what (ui/chat/row-preview.ts), not a half-written answer.
// Owns: the projection rules (unread = human-visible, non-silent messages after the human's
// cursor that the human did not write; only chats in the main list count unread – team rooms
// and app-owned system chats never do) and which chats the default list folds out.
// Never: writes anything; never defines the section rule itself (shared/text/chat-sections.ts).

import { HUMAN_ID } from '../../shared/ids.ts';
import { previewText } from '../../shared/text/chat-names.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import type { Conversation, ConversationSummary } from '../../shared/model/chat.ts';
import type { ConversationRepo } from './conversation-repo.ts';
import type { MessageRepo } from './message-repo.ts';

export function buildSummaries(
  conversations: Conversation[],
  repos: { conversations: ConversationRepo; messages: MessageRepo },
): ConversationSummary[] {
  const ids = conversations.map(c => c.id);
  const members = repos.conversations.membersOf(ids);
  const live = repos.messages.liveRows(ids);
  const openTasks = repos.conversations.openTasks(ids);
  const drafts = repos.conversations.drafts(ids);
  return conversations.map(conversation => {
    const list = members.get(conversation.id) ?? [];
    const human = list.find(m => m.memberId === HUMAN_ID);
    const counts = human !== undefined && chatSection({ settings: conversation.settings, members: list }) === 'main';
    const last = repos.messages.last(conversation.id);
    const unread = counts ? repos.messages.unreadCounts(conversation.id, HUMAN_ID, human.readSeq) : undefined;
    const runs = live.get(conversation.id);
    const summary: ConversationSummary = {
      ...conversation,
      members: list,
      unread: unread?.unread ?? 0,
      working: [...new Set((runs ?? []).map((run) => run.agentId))],
      openTasks: openTasks.get(conversation.id) ?? 0,
    };
    if (runs) summary.live = runs;
    if (unread?.important) summary.importantUnread = unread.important;
    if (last) summary.lastPreview = { authorId: last.authorId, text: last.state === 'streaming' ? '' : previewText(last.body, last.attachments), at: last.createdAt };
    if (conversation.settings.anchorId) summary.replies = repos.messages.replies(conversation.id); // B-078: the line under its message
    const draft = drafts.get(conversation.id);
    if (draft) summary.draft = draft;
    return summary;
  });
}

/** Folded out of the default chats.list: team rooms and system chats (only 'main' stays). */
export function isHidden(summary: ConversationSummary): boolean {
  return chatSection(summary) !== 'main';
}
