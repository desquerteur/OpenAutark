// RPC contract part (AF-006): the personality – the global one is settings.json `personality` (settings.update), an
// agent's own one is its personality.json (personality.setAgent) – and the agent's role, its own part of SYSTEM.md
// (personality.setRole). Handlers: runtime/rpc/handlers/personality.ts. Merged into Methods by module augmentation
// (methods.ts is at its size limit). Owns: these method shapes. Never: behaviour.

import type { Agent } from '../model/org.ts';
import type { AgentPersonality } from '../model/personality.ts';

/** What an agent's page shows: its own values, its role part and the section its next turn reads. */
export interface AgentPersonalityInfo {
  /** Only the fields it overrides (a missing one follows Settings › Personality). */
  own: AgentPersonality;
  /** Its own part of SYSTEM.md (from "## My role" on); the whole SYSTEM.md when it has no team standard. */
  role: string;
  /** True when SYSTEM.md holds the team's standard above the role (`role` is then only a part of it). */
  standard: boolean;
  /** SYSTEM.md as it is now – the `base` of personality.setRole. */
  instructions: string;
  /** "## My personality" as the agent's next turn reads it ('' = nothing set). */
  preview: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** 'chat': an agent's own personality, its role part and the prompt section it reads now. */
    'personality.agent': { params: { agentId: string }; result: AgentPersonalityInfo };
    /** 'manage': replaces the agent's own values (only valid fields; {} removes its personality.json). */
    'personality.setAgent': { params: { agentId: string; personality: AgentPersonality }; result: AgentPersonalityInfo };
    /**
     * 'manage': replaces the agent's own part of SYSTEM.md (from "## My role" on) – the team's standard above it stays.
     * `base`: SYSTEM.md as the editor loaded it; changed meanwhile = 'conflict'.
     */
    'personality.setRole': { params: { agentId: string; role: string; base?: string }; result: Agent };
    /** 'chat': "## My personality" for an agent without own values (Settings › Personality's preview). */
    'personality.preview': { params: void; result: { text: string } };
  }
}

export {};
