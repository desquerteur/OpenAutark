// Unowned team work gets an owner by one decision-model call (B-078 D11, owner 06.11.: "ein System, das halt einfach
// mit Decision-Model … entscheidet, zu wem geht das, zu welchem Agent. Und dann können sie sich untereinander noch
// entscheiden"): the choice is among the active agents (name and role) – for work handed over in a chat, among that
// chat's agent members, so nobody joins a chat by this pick – with the task's title and the start of its notes. A sure
// pick (SURE_CONFIDENCE) assigns it (by the system: the agent is woken as owner, tasks.assign settles the rest
// among the agents); an unsure one, no model, a failed call or fewer than two candidates go the old way (the
// fallback: the chat lead or the responsible manager decides, lifecycle.ts wakeLead). The answer arrives
// asynchronously: it counts while the task is still unfinished team work (else someone took it and nobody is woken).
// Owns: that pick. Never: wakes anyone itself, adds an agent to a chat, or holds the work back while it decides.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { Agent } from '../../shared/model/org.ts';
import { SURE_CONFIDENCE } from '../decision/service.ts';
import type { TaskServiceImpl } from './service.ts';

const NOTES_CHARS = 400;
const PICK_TIMEOUT_MS = 20_000;

/** The agents the work may go to: the chat's agent members, else every active agent – never the one that made it team work. */
export function ownerCandidates(t: TaskServiceImpl, task: Pick<Task, 'conversationId' | 'createdBy'>): Agent[] {
  const org = t.s.org;
  if (!org) return [];
  const active = org.list().filter((agent) => agent.archivedAt === undefined && agent.id !== task.createdBy);
  if (!task.conversationId) return active;
  let members: Set<string>;
  try { members = new Set(t.s.chats.members(task.conversationId).filter((member) => !member.leftAt).map((member) => member.memberId)); } catch { return []; }
  return active.filter((agent) => members.has(agent.id));
}

/**
 * Still unfinished team work (the guard for an answer that arrives later): nobody took it meanwhile. Whatever its
 * status or place was at hand-over (a child step, 'working', 'blocked') counts as it was then.
 */
function stillUnowned(t: TaskServiceImpl, id: string): boolean {
  const task = t.repo.get(id);
  return Boolean(task && task.assigneeKind === 'team' && task.status !== 'done' && task.status !== 'cancelled');
}

/** The agent the decision model picks for `task` (undefined: unsure, no model, or no answer). */
export async function pickOwner(t: TaskServiceImpl, task: Pick<Task, 'title' | 'notes'>, candidates: readonly Agent[]): Promise<Agent | undefined> {
  const decisions = t.s.decisions;
  if (!decisions || candidates.length < 2) return undefined;
  const byName = new Map(candidates.map((agent) => [agent.name, agent]));
  const result = await decisions.decide({
    purpose: 'route',
    type: 'choice',
    question: 'Which agent owns this task? I pick the one whose role fits it best.',
    options: [...byName.keys()],
    context: `Task: ${excerpt(task.title, 200)}${task.notes.trim() ? `\n${excerpt(task.notes, NOTES_CHARS)}` : ''}\nAgents: ${candidates.map((agent) => (agent.role ? `${agent.name} (${agent.role})` : agent.name)).join(', ')}`,
    timeoutMs: PICK_TIMEOUT_MS,
  });
  if (!result.choice || result.confidence < SURE_CONFIDENCE) return undefined;
  return byName.get(result.choice.trim());
}

/**
 * Team work was created or handed to the team: with two or more candidates and a decision model the pick runs (the
 * work is assigned when it is sure); everything else – and an unsure pick – runs `fallback` (wakeLead).
 */
export function routeTeamWork(t: TaskServiceImpl, task: Task, fallback: () => void): void {
  const candidates = ownerCandidates(t, task);
  const decisions = t.s.decisions;
  let ready = false;
  try { ready = Boolean(decisions?.available()); } catch { ready = false; }
  if (!ready || candidates.length < 2) { fallback(); return; }
  void pickOwner(t, task, candidates).then((agent) => {
    if (!stillUnowned(t, task.id)) return; // someone took it meanwhile
    if (agent && t.s.org?.get(agent.id)?.archivedAt === undefined) t.assign(task.id, { kind: 'agent', id: agent.id }, SYSTEM_ID);
    else fallback();
  }).catch((error: unknown) => {
    t.s.log?.warn('picking a task owner failed', { taskId: task.id, error: String(error) });
    if (stillUnowned(t, task.id)) fallback();
  });
}
