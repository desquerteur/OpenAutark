// AF-005: which agents may use a connector – the entry's "agents" list in mcp.json / mail.json (agent ids, or names for
// the AI's convenience; Settings › Connectors writes ids). Missing (or not a list): every agent, as before; [] : none.
// The registry offers a connector's tools only to those agents and refuses the others' calls (tools.ts `forAgent`,
// tools/registry.ts); a changed list applies at once, without connecting again (connectors.ts leaves it out of the
// fingerprint). AF-013 (permissions) builds on connectorAllows().
// Owns: reading the list and the one rule. Never: changes a file, or decides anything else about a call.

import type { Agent } from '../../shared/model/org.ts';
import type { Connector } from './types.ts';

/** Longest list kept (a file with more is cut). */
export const MAX_AGENTS = 200;

/** The entry's "agents" as the Connector field: undefined unless it is a list; texts only, trimmed, unique. */
export function agentsOf(raw: Record<string, unknown>): { agents?: string[] } {
  if (!Array.isArray(raw.agents)) return {};
  const agents = [...new Set(raw.agents.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
  return { agents: agents.slice(0, MAX_AGENTS) };
}

/** May `agent` use the connector? No list: yes; else its id, or its name in any case, is in the list. */
export function connectorAllows(connector: Pick<Connector, 'agents'> | undefined, agent: Pick<Agent, 'id'> & Partial<Pick<Agent, 'name'>>): boolean {
  const list = connector?.agents;
  if (!list) return true;
  const name = agent.name?.trim().toLowerCase();
  return list.some((entry) => entry === agent.id || (name !== undefined && name !== '' && entry.toLowerCase() === name));
}

/** Two lists name the same agents (order and case of names aside); undefined only equals undefined. */
export function sameAgents(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return a === b;
  const norm = (list: readonly string[]) => [...new Set(list.map((entry) => entry.toLowerCase()))].sort().join('\n');
  return norm(a) === norm(b);
}
