// The member's personal assistant (B-041): the active agent hired as 'secretary' or 'ceo-assistant' that works for that
// member (the first person up its chain of command – the owner 'human' at the top; the shallowest, then the oldest
// when there are several), else – for the owner – the responsible manager of the private space (or of everything,
// without one), else none. wakeAssistant tells it once about the person's new to-dos an agent can help with (one wake
// naming them, coalesced; origin 'news') – never for "Only me" or finished to-dos.
// Owns: who the assistant is and that wake. Never: writes a to-do or picks a colleague's agent for the owner.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Agent } from '../../shared/model/org.ts';
import { ORIGINS } from '../../shared/model/origin.ts';
import { isPersonId } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { responsibleManager } from '../tasks/owners.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

export const ASSISTANT_TEMPLATES: readonly string[] = ['secretary', 'ceo-assistant'];
/** The wake's note, above the to-do lines. */
export const PREPARE_NOTE = 'The person added to-dos I can help with. I prepare them with todos.prepare (opening hours, documents, links, '
  + 'a time window) or do what I can myself:';
/** The bundled wake's key and delay (more to-dos typed in a row join one wake). */
const WAKE_KEY = 'assistant:todos';
const WAKE_DELAY_MS = 60_000;

export type AssistantDeps = Pick<RuntimeServices, 'org' | 'tasks' | 'wakes' | 'clock'> & Partial<Pick<RuntimeServices, 'log'>>;

const isAssistant = (agent: Agent) => ASSISTANT_TEMPLATES.includes(agent.template ?? '') || ASSISTANT_TEMPLATES.includes(agent.mode);
const isManager = (agent: Agent) => agent.mode === 'manager' || agent.template === 'manager';

/** The member an agent works for: the first person up its chain ('human' at the top). */
function memberOf(org: Pick<RuntimeServices['org'], 'get'>, agent: Agent): string {
  let current: Agent | undefined = agent;
  for (let hops = 0; current && hops < 20; hops++) {
    const boss = current.managerId;
    if (!boss) return HUMAN_ID;
    if (boss === HUMAN_ID || isPersonId(boss)) return boss;
    current = org.get(boss);
  }
  return HUMAN_ID;
}

/** The assistant of `ownerId` ('human' or a per_… id), or none. */
export function personalAssistant(s: Pick<RuntimeServices, 'org'>, ownerId: string): Agent | undefined {
  let agents: Agent[];
  try { agents = s.org.list().filter((agent) => agent.archivedAt === undefined); } catch { return undefined; }
  const depth = (agent: Agent) => { try { return s.org.managers(agent.id).length; } catch { return 0; } };
  const own = agents.filter((agent) => isAssistant(agent) && memberOf(s.org, agent) === ownerId)
    .sort((a, b) => depth(a) - depth(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (own[0]) return own[0];
  if (ownerId !== HUMAN_ID) return undefined; // a colleague's own space comes later (contract §7)
  let privateSpace: string | undefined;
  try {
    privateSpace = s.org.spaces().filter((space) => space.kind === 'private' && space.archivedAt === undefined)
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)[0]?.id;
  } catch { privateSpace = undefined; }
  const manager = responsibleManager(s.org, privateSpace);
  return manager && isManager(manager) && memberOf(s.org, manager) === HUMAN_ID ? manager : undefined;
}

/** Tells the member's assistant about these to-dos in one wake. Returns the woken agent's id, or undefined. */
export function wakeAssistant(s: AssistantDeps, ownerId: string, taskIds: string[], source: string): string | undefined {
  const agent = personalAssistant(s, ownerId);
  if (!agent) return undefined;
  const lines: string[] = [];
  for (const id of new Set(taskIds)) {
    const task = s.tasks.get(id);
    if (!task || task.private || task.status === 'done' || task.status === 'cancelled') continue;
    lines.push(`- ${task.id}: ${excerpt(task.title, 120)}`);
  }
  if (!lines.length) return undefined;
  s.wakes.wake({ agentId: agent.id, reason: 'task', coalesceKey: WAKE_KEY, dueAt: s.clock.now() + WAKE_DELAY_MS, note: [PREPARE_NOTE, ...lines].join('\n'), origin: ORIGINS.news });
  s.log?.info('assistant told about new to-dos', { agentId: agent.id, count: lines.length, source });
  return agent.id;
}
