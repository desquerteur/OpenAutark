// RPC contract part (wave 3): an agent's core folder – the state of its SYSTEM.md (the instructions
// agents.update edits) and its Main Skills, and saving one Main Skill. Removing one is skills.delete.
// B-044: its home project (agents.setHome – the person's set or clear; agents set their own through the
// agents.update tool; agents.openHome opens it). Handlers: runtime/rpc/handlers/agent-core.ts. Merged into Methods by module augmentation
// (methods.ts is at its size limit). Owns: these method shapes. Never: behaviour.

import type { AgentCoreInfo, AgentHome } from '../model/agent-core.ts';
import type { SkillInfo } from '../model/knowledge.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** 'chat': SYSTEM.md's state (notice), the Main Skills, the home project; `folder` and the home's path only for the person on the PC. */
    'agents.core': { params: { agentId: string }; result: AgentCoreInfo };
    /**
     * 'manage': creates or changes one of the agent's Main Skills (a new one needs a free name); recorded as a skill
     * version. `base`: the text the editor started from – a SKILL.md changed meanwhile (on disk, by the agent) is a
     * 'conflict', never overwritten unseen. Main Skills have no modes: the agent's prompt lists them in every mode.
     */
    'agents.saveMainSkill': { params: { agentId: string; name: string; description: string; body: string; base?: { description: string; body: string } }; result: SkillInfo };
    /** B-044, owner (a folder of this PC): sets (an absolute folder) or clears (null / '') the agent's home project. */
    'agents.setHome': { params: { agentId: string; home: string | null }; result: { home?: AgentHome } };
    /** B-044, owner (the desktop's file manager): opens the agent's home project folder while it is usable ('not_found' otherwise). */
    'agents.openHome': { params: { agentId: string }; result: { ok: true } };
  }
}

export {};
