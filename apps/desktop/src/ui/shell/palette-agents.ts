// AF-017: the command palette's agent entries – per active agent its page ("Making", hint: role · project) and,
// where this connection may open its chat, "Chat with Making". Pure – the palette (CommandPalette.tsx) attaches what
// each entry does.
// Owns: which entries there are and their words. Never: runs them or loads agents.

import type { Agent } from '../../shared/model/org.ts';
import { projectOf } from '../agents/directory-model.ts';

export const AGENTS_GROUP = 'Agents';

export interface AgentPaletteEntry {
  id: string;
  kind: 'page' | 'chat';
  agentId: string;
  label: string;
  hint?: string;
}

export function agentPaletteEntries(
  agents: readonly Agent[],
  projects: ReadonlyArray<{ id: string; name: string; agents: ReadonlyArray<{ id: string }> }>,
  options: { canChat: (agentId: string) => boolean },
): AgentPaletteEntry[] {
  const out: AgentPaletteEntry[] = [];
  for (const agent of agents) {
    if (agent.archivedAt !== undefined) continue;
    const project = projectOf(agent.id, projects);
    const hint = [agent.role.trim(), project?.name ?? ''].filter(Boolean).join(' · ') || undefined;
    out.push({ id: `g:${agent.id}`, kind: 'page', agentId: agent.id, label: agent.name, ...(hint ? { hint } : {}) });
    if (options.canChat(agent.id)) out.push({ id: `g:${agent.id}:chat`, kind: 'chat', agentId: agent.id, label: `Chat with ${agent.name}`, hint: 'Open chat' });
  }
  return out;
}
