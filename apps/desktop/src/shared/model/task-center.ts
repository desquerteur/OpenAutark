// Quick tasks (the person's task composer): one line of work becomes one plain task (runtime/tasks/quick.ts) – for an
// agent, a manager's branch, a team, a person of the organisation, the person themselves ('me'), or (no target) the
// team, where the responsible manager decides. tasks.route sends unowned work to a target or wakes that manager again.
// Joins Methods by module augmentation.
// Owns: the shapes only. Never: behaviour or a second task store.

import type { TaskView } from './tasks.ts';

/**
 * An optional addressee of a quick task: one agent, a manager's branch (`id` = the manager's agent id), a team
 * (`id` = the team name agents carry in Agent.team), one active person of the organisation ('per_…', the owner's
 * quick task only: handed over in the owner's 1:1 chat with her) or 'me' (`id` = 'human': the person's own to-do).
 */
export type QuickTargetKind = 'agent' | 'branch' | 'team' | 'person' | 'me';
export const QUICK_TARGET_KINDS: readonly QuickTargetKind[] = ['agent', 'branch', 'team', 'person', 'me'];
export interface QuickTaskTarget {
  kind: QuickTargetKind;
  id: string;
}

/** `tasks.quickCreate`: one line of work for the company – returns at once (no model call). */
export interface QuickTaskParams {
  text: string;
  /** Files uploaded with files.upload (kept with the task). */
  attachments?: Array<{ fileId: string; name?: string; durationMs?: number }>;
  target?: QuickTaskTarget;
  priority?: 0 | 1 | 2;
  /** The space a chat-free task belongs to. */
  spaceId?: string;
  dueAt?: number;
  /** Idempotency key: a retried post returns the task the first one made. */
  clientId?: string;
}

export interface QuickTaskResult {
  task: TaskView;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'tasks': a quick task (runtime/tasks/quick.ts). A person target: the owner only, straight into the 1:1 chat with her. */
    'tasks.quickCreate': { params: QuickTaskParams; result: QuickTaskResult };
    /** 'tasks': unowned (or any unfinished) work to `target` (an agent, branch or team – never a person); no target: the responsible manager decides. */
    'tasks.route': { params: { id: string; target?: QuickTaskTarget }; result: TaskView };
  }
}
