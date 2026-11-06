// Origin (B-054, owner 29.10.2026 "Läufe und To-dos gehören keinem Chat"): why a wake, a run or a task exists.
// A chat is only one possible origin; a task, a mail, a schedule, a connector or the To-do area are others, and
// nothing downstream asks "which chat?" – a new event source needs no special code.
// Owns: the Origin shape, the well-known source keys and the thread key (one native session per chat, per task or
// per source). Never: written by an agent – runtime code sets the origin; never a person, a secret or message text.

import { splitThread } from './splits.ts'; // B-057: a split's own thread

/** Why a wake, run or task exists. Always written by runtime code, never by an agent. */
export interface Origin {
  /** 'app:<appId>' | 'schedule:<id>' | 'news' | 'approvals' | 'todo-list' | 'intake' | 'system' (open: new sources add keys). */
  source: string;
  /** Short human label ("New mail in office@…", "To-do area", "Routine \"Morning check\""). */
  label: string;
}

/** Well-known origins with a fixed label. Keyed sources (app:, schedule:) are built by their owners. */
export const ORIGINS = {
  todoList: { source: 'todo-list', label: 'To-do area' },
  intake: { source: 'intake', label: 'Quick task' },
  news: { source: 'news', label: 'Task news' },
  approvals: { source: 'approvals', label: 'Approval to review' },
  system: { source: 'system', label: 'System' },
} as const satisfies Record<string, Origin>;

/** The source key of a connected app ('app:<appId>'). */
export const appSource = (appId: string): string => `app:${appId}`;
/** The source key of a schedule ('schedule:<id>'). */
export const scheduleSource = (scheduleId: string): string => `schedule:${scheduleId}`;

/** Longest stored label; longer labels are cut (labels are UI lines, not content). */
export const ORIGIN_LABEL_MAX = 120;

/** A clean origin (trimmed, label cut), or undefined when the source is empty. */
export function cleanOrigin(origin: Origin | undefined): Origin | undefined {
  const source = origin?.source?.trim();
  if (!source) return undefined;
  const label = (origin?.label ?? '').trim().slice(0, ORIGIN_LABEL_MAX) || source;
  return { source, label };
}

/**
 * The thread a turn belongs to: its native session and turn state are keyed by it. A chat keeps its chat id (old
 * sessions resume unchanged); a chat-free task gets `task:<id>`; a chat-free, task-free wake gets `src:<source>`.
 * B-057: a split's turn (`split`: its split id, or a SplitTurn – ToolContext.split) is checked first and gets
 * `split:<splitId>` (shared/model/splits.ts).
 */
export function threadKey(p: { conversationId?: string; taskId?: string; origin?: Origin; split?: string | { splitId: string } }): string {
  if (p.split) return splitThread(typeof p.split === 'string' ? p.split : p.split.splitId);
  if (p.conversationId) return p.conversationId;
  if (p.taskId) return `task:${p.taskId}`;
  return p.origin?.source ? `src:${p.origin.source}` : '';
}
