// RPC contract part (AF-014): an agent made from a folder – what the folder suggests, creating the agent, and which
// agents work in which folder (the sidebar's grouping by folder). Handlers: runtime/rpc/handlers/folder-agents.ts.
// Merged into Methods by module augmentation. Owns: these method shapes. Never: behaviour.

import type { AccessMode } from '../model/access.ts';
import type { FolderFinding } from '../model/folder-agent.ts';
import type { Agent } from '../model/org.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner (a folder of this PC): the suggested name and role, the instruction files, skills and agents of `folder`. */
    'folderAgents.find': { params: { folder: string }; result: FolderFinding };
    /** Owner: hires the agent – the folder its home project, its own text following the folder's files, mode `project` unless given. */
    'folderAgents.create': { params: { folder: string; name?: string; role?: string; mode?: AccessMode }; result: { agent: Agent; finding: FolderFinding } };
    /** Owner: each agent's home project folder (agents without one are left out) – the sidebar groups agents by it. */
    'folderAgents.homes': { params: void; result: Array<{ agentId: string; folder: string; label: string }> };
  }
}

export {};
