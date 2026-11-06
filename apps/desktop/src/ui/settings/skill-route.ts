// How a skill on Settings › Skills & memory is reached: an agent's own copy (only it), a manager's (it and everyone below
// it), the shared one, the built-in one, and whether it stands in every prompt (`always`).
// Owns: those words and the row order. Never: resolves a route for an agent (runtime/skills/service.ts).

import type { SkillInfo } from '../../shared/model/knowledge.ts';

const ORDER: readonly SkillInfo['source'][] = ['user', 'agent', 'builtin'];

/** Shared first, then the agents' copies, then the built-in ones; by name inside each (pure). */
export function skillRows(skills: readonly SkillInfo[]): SkillInfo[] {
  return [...skills].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source) || a.name.localeCompare(b.name));
}

/** "Own · Ada", "Manager · Ben", "Shared", "Built-in"; `always` follows. `isManager`: someone reports to this agent. */
export function skillRoute(skill: SkillInfo, nameOf: (agentId: string) => string, isManager: (agentId: string) => boolean): string {
  const owner = skill.ownerAgentId;
  const route = skill.source === 'builtin' ? 'Built-in'
    : skill.source === 'user' || !owner ? 'Shared'
    : `${isManager(owner) ? 'Manager' : 'Own'} · ${nameOf(owner)}`;
  return skill.always ? `${route} · always` : route;
}
