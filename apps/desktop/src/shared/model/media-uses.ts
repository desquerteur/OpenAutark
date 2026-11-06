// What still uses a stored file (MM6): the answer of `media.uses` and the details of a
// `media.delete` conflict – the chat messages that attach or show the file (with their chat
// and a preview, and the other files only they hold, so the confirmation can name what goes),
// the messages that only name its id in their text (they stay), the other places by kind, and
// whether an agent is working with it right now – plus the sentence the runtime's refusal and
// the Media tab use for it.
// Owns: the shape and its English wording. Never: finds the uses (runtime/files/references.ts).

/** Places besides chat messages that keep a stored file. */
export type MediaUseKind = 'draft' | 'task' | 'knowledge' | 'avatar' | 'chat' | 'settings' | 'feedback' | 'schedule' | 'app';

/** A message that attaches or shows the file (media.delete removes it when confirmed). */
export interface MediaUseMessage {
  id: string;
  conversationId: string;
  /** The chat's title (media.uses). */
  chat?: string;
  /** One line of the message (media.uses). */
  preview?: string;
}

export interface MediaUses {
  /** Messages that attach or show the file (at most 100). */
  messages: MediaUseMessage[];
  /** More messages use it than are listed. */
  moreMessages?: boolean;
  /** Messages that only name the file's id in their text (a link, a path): they stay when it is deleted. */
  mentions?: number;
  /** Other stored files only the listed messages hold – the clean-up removes them with those messages (media.uses). */
  alongside?: Array<{ fileId: string; name: string }>;
  /** Other places, each kind once, in a stable order. */
  other: MediaUseKind[];
  /** An agent is working with the file right now (an unfinished run or a pending wake names it). */
  busy?: boolean;
}

/** Stable order of the other kinds (and the order references.ts checks them in). */
export const MEDIA_USE_KINDS: readonly MediaUseKind[] = ['draft', 'task', 'knowledge', 'avatar', 'chat', 'settings', 'feedback', 'schedule', 'app'];

const LABELS: Record<MediaUseKind, string> = {
  draft: 'an unsent draft',
  task: 'a task or to-do',
  knowledge: 'a memory',
  avatar: "an agent's avatar",
  chat: "a chat's picture",
  settings: 'your profile or settings',
  feedback: 'a feedback report',
  schedule: 'a scheduled message',
  app: 'saved mini-app data',
};

/** "2 messages, an agent's avatar and a memory" – what keeps the file ('' when nothing does). */
export function usesText(uses: Pick<MediaUses, 'messages' | 'moreMessages' | 'other'>): string {
  const parts: string[] = [];
  const count = uses.messages.length;
  if (count) parts.push(uses.moreMessages ? `more than ${count} messages` : count === 1 ? 'a message' : `${count} messages`);
  for (const kind of uses.other) parts.push(LABELS[kind] ?? kind);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
