// Mode strategy (23.10.2026): the agent – not a picker in the chat – chooses the working mode of
// its work. Three moves, one rule each (the same words are in the stable rules, rules.md "Modes",
// and in the agents.handoff / agents.delegate descriptions):
//   switch   – agents.handoff to a mode key: the REST of the task is another kind of work; the same
//              agent continues it there (new session with that mode's tools, a checkpoint, no context drag);
//   sub-step – agents.delegate to a mode key: one bounded part needs another mode, then the work
//              goes on in the current mode (the part runs in a hidden work chat; the task waits on it);
//   colleague – agents.delegate to an agent whose own mode it is: the part can be done separately
//              and that colleague's knowledge, accounts or PC help (modes.list names them).
// Checked here for a switch: no switch into the mode the run already works in, and a hint when a colleague works in
// the target mode.
// Owns: that check and the specialist lookup. Never: switches or delegates itself
// (agents/handoff.ts does), or forbids a delegation (a colleague hint is only advice).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';

const SPECIALISTS = 3;

/** The sentence the handoff and delegate descriptions share (kept short: it is in every tool list). */
export const MODE_MOVES = 'Mode moves: when the rest of the task is other work, I hand off to the mode key and go on there; for one bounded part, I delegate to the mode key and go on here with its result; when a colleague works in that mode (modes.list) and the part stands alone, I delegate to them.';

export interface Specialist { id: string; name: string }

/** Active agents (not archived, not paused) whose own mode is `key`, except `exceptId`; at most three. None for 'general' (no specialist mode). */
export function specialistsFor(services: Pick<RuntimeServices, 'org'>, key: string, exceptId?: string): Specialist[] {
  if (key === 'general') return [];
  let agents: Agent[];
  try { agents = services.org.list(); } catch { return []; }
  return agents
    .filter((agent) => agent.mode === key && agent.id !== exceptId && !agent.archivedAt && agent.status !== 'paused')
    .slice(0, SPECIALISTS)
    .map((agent) => ({ id: agent.id, name: agent.name }));
}

export interface SwitchCheck {
  /** Why the switch is refused (nothing changed). */
  refuse?: string;
  /** A colleague works in the target mode: delegating a separate part may fit better. */
  advice?: string;
}

/** The checks before agents.handoff switches the current task to mode `to` (only for a mode key, not an agent). */
export function checkModeSwitch(services: Pick<RuntimeServices, 'org'>, input: { agentId: string; mode: string; taskId?: string; to: string }): SwitchCheck {
  if (input.to === input.mode) return { refuse: `I already work in ${input.to} mode: I continue the work here.` };
  const colleagues = specialistsFor(services, input.to, input.agentId);
  if (!colleagues.length) return {};
  const names = colleagues.map((colleague) => `${colleague.name} (${colleague.id})`).join(', ');
  return { advice: `${names} ${colleagues.length === 1 ? 'works' : 'work'} in ${input.to} mode. For a part that stands on its own, agents.delegate to them keeps their knowledge and lets me go on meanwhile.` };
}
