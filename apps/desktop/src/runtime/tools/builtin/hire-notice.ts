// AF-017: a hire by an agent is never invisible. After agents.create made a new agent, the chat the hiring agent works
// in gets one 'agent_hired' status line (the UI draws it as the card "New agent: <name> – <role>" with Open chat,
// chat/AgentHiredCard.tsx) and the person gets a 'done' notification (a toast in the window, a push where allowed).
// A split's call posts into its parent chat. Both are cosmetic: a failure never fails the hire.
// Owns: the hire's announcement. Never: hires, changes the org or decides where the agent lands.

import type { Agent } from '../../../shared/model/org.ts';
import type { ToolContext } from '../types.ts';

/** The chat the hire happened in (a split posts into its parent chat). */
function hireChat(ctx: ToolContext): string | undefined {
  return ctx.conversationId ?? ctx.split?.parentConversationId;
}

export function announceHire(ctx: ToolContext, agent: Agent, space?: string): void {
  const by = ctx.agent;
  const role = agent.role.trim();
  const text = `${by.name} hired ${agent.name}${role ? ` · ${role}` : ''}`;
  const conversationId = hireChat(ctx);
  if (conversationId) {
    try {
      ctx.services.chats.status(conversationId, {
        type: 'agent_hired', text,
        details: { agentId: agent.id, name: agent.name, role, by: by.id, ...(agent.spaceId ? { spaceId: agent.spaceId } : {}), ...(space ? { space } : {}) },
      }, { authorId: by.id, runId: ctx.runId });
    } catch { /* the card is cosmetic */ }
  }
  try {
    ctx.services.notifications.notify({
      kind: 'done', title: `New agent: ${agent.name}`,
      body: [role, space, `hired by ${by.name}`].filter(Boolean).join(' · '),
      ...(conversationId ? { conversationId } : {}),
    });
  } catch { /* the notification is cosmetic */ }
}
