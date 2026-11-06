// Wave 3: the agent core folder service (SYSTEM.md as the agents' instructions, Main Skills) as a
// member of RuntimeServices (merged by module augmentation, like the other late additions in this
// folder). Implemented by runtime/agent-core/service.ts, wired in compose/agent-core.ts.
// Owns: the member declaration only.

import type { AgentCore } from '../agent-core/service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** Wave 3: SYSTEM.md and Main Skills per agent; missing = not wired (fakes) – prompts then use the agent row. */
    agentCore?: AgentCore;
  }
}

export type { AgentCore };
