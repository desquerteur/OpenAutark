// Chooses a chat's lead agent: the one that answers a person's un-addressed group message when no
// responder pick decides (B-050 round 4: an agent's then wakes nobody) and picks an owner for team tasks. Order: explicit choice → a manager among the members → the creating
// agent → the most senior agent (shortest chain of command) → the first agent.
// Owns: that rule only. Never: writes to the DB (the chat service stores the member role).

import type { OrgService } from '../contracts.ts';

export function pickLead(input: { agentIds: string[]; createdBy: string; explicit?: string; org?: OrgService }): string | undefined {
  const { agentIds, createdBy, explicit, org } = input;
  if (!agentIds.length) return undefined;
  if (explicit && agentIds.includes(explicit)) return explicit;
  if (agentIds.length === 1) return agentIds[0];
  if (org) {
    // A manager of another member, or an agent in manager mode.
    const managerOfMember = agentIds.find(id => agentIds.some(other => other !== id && org.get(other)?.managerId === id));
    if (managerOfMember) return managerOfMember;
    const managerMode = agentIds.find(id => org.get(id)?.mode === 'manager');
    if (managerMode) return managerMode;
  }
  if (agentIds.includes(createdBy)) return createdBy;
  if (org) {
    const depth = (id: string) => {
      try { return org.managers(id).length; } catch { return Number.MAX_SAFE_INTEGER; }
    };
    return [...agentIds].sort((a, b) => depth(a) - depth(b))[0];
  }
  return agentIds[0];
}
