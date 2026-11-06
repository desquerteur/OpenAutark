// RPC contract part: F-51 start paths – the local team pattern library (patterns.*). Handlers:
// runtime/rpc/handlers/team-start.ts. Merged into Methods by module augmentation (methods.ts is at its size limit).
// Owns: these method shapes. Never: behaviour.

import type { CreatedTeam, PatternSummary, ProposedAgent, TeamPattern } from '../model/team-start.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** 'manage': built-in, saved and imported team patterns. */
    'patterns.list': { params: void; result: PatternSummary[] };
    /** 'manage': one pattern with its editable proposal. */
    'patterns.get': { params: { id: string }; result: TeamPattern };
    /** 'manage': creates the proposal the person edited (from a pattern) – all or nothing. */
    'patterns.apply': { params: { patternId?: string; agents: ProposedAgent[]; managerId?: string }; result: CreatedTeam };
    /** 'manage': the current team (or one branch) saved as an editable pattern – roles and instructions only. */
    'patterns.saveFromOrg': { params: { name: string; description?: string; rootId?: string }; result: PatternSummary };
    /** Owner: a pattern from an https URL or a picked file's text, with provenance and version. */
    'patterns.import': { params: { url?: string; name?: string; text?: string }; result: PatternSummary };
    /** Owner: fetches a URL pattern again ("Check for update"); keeps the previous hash. */
    'patterns.refresh': { params: { id: string }; result: PatternSummary };
    /** 'manage': removes a saved or imported pattern (built-ins stay). */
    'patterns.remove': { params: { id: string }; result: { ok: true } };
  }
}

export {};
