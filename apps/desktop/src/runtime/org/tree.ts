// Builds the org tree (agents nested under their manager) from a flat agent list.
// Owns: the pure nesting logic. Agents whose manager is missing or archived become roots
// (they report to the human). Never: database access.

import type { Agent, OrgNode } from '../../shared/model/org.ts';

export function buildTree(agents: Agent[]): OrgNode[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.managerId && ids.has(agent.managerId)) {
      const list = children.get(agent.managerId) ?? [];
      list.push(agent);
      children.set(agent.managerId, list);
    } else roots.push(agent);
  }
  const seen = new Set<string>(); // guards against cycles in damaged data
  const build = (agent: Agent): OrgNode => {
    seen.add(agent.id);
    return { agent, reports: (children.get(agent.id) ?? []).filter((child) => !seen.has(child.id)).map(build) };
  };
  return roots.map(build);
}
