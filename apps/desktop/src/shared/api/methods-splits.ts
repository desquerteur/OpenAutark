// RPC contract part (B-057): an agent's splits (shared/model/splits.ts) – the groups it split its work into, one split
// with its group and the person's Stop. Handlers: runtime/rpc/handlers/splits.ts – reads with the access rule of
// runs.items (through the group's parent run: its chat or task), stop with the rights of runs.cancel. Merged into Methods by module augmentation (methods.ts is at
// its size limit). Owns: these method shapes. Never: behaviour.

import type { SplitGroupView, SplitView } from '../model/splits.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Split groups, newest first: of an agent, of one parent run, one group, or of a chat; `active`: not yet gathered or stopped. */
    'splits.list': { params: { agentId?: string; parentRunId?: string; groupId?: string; conversationId?: string; active?: boolean; limit?: number }; result: SplitGroupView[] };
    /** One split with its group. */
    'splits.get': { params: { id: string }; result: { split: SplitView; group: SplitGroupView } };
    /** The person's Stop of one split (`id`) or of a whole group: running ones are aborted, waiting ones stopped. */
    'splits.stop': { params: { id?: string; groupId?: string }; result: { stopped: number } };
  }
}

export {};
