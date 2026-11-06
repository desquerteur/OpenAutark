// The space a task belongs to (B-054, owner 29.10.2026 "To-dos gehören ja nicht zum Chat"): a task handed over in
// a chat gets its space from that chat (as before); a chat-free task keeps its own `spaceId` (taken at creation
// from its parent, else from the agent that made it). Companions, learning, recipes and the task center ask here
// instead of "the chat's space".
// Owns: that one rule. Never: writes anything, or falls back from a task with a chat to its stored space_id (the
// chat is the truth while there is one).

import type { Task } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';

export type SpaceDeps = Pick<RuntimeServices, 'chats'>;

/** The task's space: its chat's when it has one, else its own; undefined = the company-wide space. */
export function taskSpace(s: SpaceDeps, task: Pick<Task, 'conversationId' | 'spaceId'>): string | undefined {
  if (task.conversationId) {
    try { return s.chats.get(task.conversationId)?.spaceId; } catch { return undefined; }
  }
  return task.spaceId;
}
