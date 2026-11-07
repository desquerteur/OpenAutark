// RPC contract part (AF-013): an agent's access mode and rules, a chat's or a run's mode, and the approval requests.
// Handlers: runtime/rpc/handlers/access.ts. Merged into Methods by module augmentation.
// Owns: these method shapes. Never: behaviour.

import type { AccessAnswer, AccessMode, AccessRequest, AccessRules, EffectiveAccess } from '../model/access.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** 'chat': the access in effect for the agent's turns – in the chat `conversationId` when given (its mode cell). */
    'access.get': { params: { agentId: string; conversationId?: string }; result: EffectiveAccess };
    /** Owner: sets the agent's own mode and/or rules (rules replace the stored ones whole). Kept in agents/<id>/access.json. */
    'access.set': { params: { agentId: string; mode?: AccessMode; rules?: AccessRules }; result: EffectiveAccess };
    /** Owner: the mode for every agent's turns in this chat (null: each agent's own mode again). */
    'access.setChatMode': { params: { conversationId: string; mode: AccessMode | null }; result: { mode?: AccessMode } };
    /** Owner: the mode of one running run (null: back to the chat's or the agent's). Kept while this runtime runs. */
    'access.setRunMode': { params: { runId: string; mode: AccessMode | null }; result: { mode?: AccessMode } };
    /** Owner: the approval requests waiting for the person, oldest first. */
    'access.pending': { params: void; result: AccessRequest[] };
    /** Owner: answers one: once, always for this agent (its rules grow by the request's `always`), or deny. */
    'access.answer': { params: { id: string; answer: AccessAnswer }; result: { ok: boolean } };
  }
}

export {};
