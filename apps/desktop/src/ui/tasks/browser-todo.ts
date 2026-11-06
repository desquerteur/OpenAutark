// Which "For you" to-dos get "Open browser" (MP9, BrowserTodo.tsx): a confirm to-do (something the
// person does, then confirms – a sign-in, a captcha) created by a browser or social agent – by the
// agent's or the to-do's mode, or because the agent has a browser open – opens that agent's own
// browser, taken over by the person, at the to-do's http(s) address.
// Owns: that rule. Never: renders or calls the runtime.

import type { BrowserSessionInfo } from '../../shared/model/browser.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

/** Modes whose workspace is the browser (resources/modes/browser.md, social.md). */
export const BROWSER_MODES: ReadonlySet<string> = new Set(['browser', 'social']);

export interface BrowserTodoTarget { agentId: string; url?: string }

type TodoAgent = Pick<Agent, 'id' | 'mode' | 'archivedAt'>;

export function browserTodoTarget(task: Pick<TaskView, 'widget' | 'createdBy' | 'mode'>, agents: ReadonlyMap<string, TodoAgent>, sessions: readonly BrowserSessionInfo[]): BrowserTodoTarget | undefined {
  if (task.widget?.type !== 'confirm') return undefined;
  const agent = agents.get(task.createdBy);
  if (!agent || agent.archivedAt !== undefined) return undefined;
  const open = sessions.some((entry) => entry.agentId === agent.id);
  if (!open && !BROWSER_MODES.has(agent.mode) && !(task.mode && BROWSER_MODES.has(task.mode))) return undefined;
  const target: BrowserTodoTarget = { agentId: agent.id };
  const url = task.widget.url;
  if (typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim())) target.url = url.trim();
  return target;
}
