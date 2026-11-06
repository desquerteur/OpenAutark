// Answers to Codex app-server approval server-requests. Agent turns run with approvalPolicy 'never'
// (isolation.ts), so these arrive only from an older server or an odd config: an agent turn accepts them
// for the session, a read-only turn (helpers) declines them.
// Owns: the exact decision values per method (verified against the app-server's generated JSON schema).
// Never: asks anyone.

import { isRecord } from '../shared.ts';

export const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'execCommandApproval', 'applyPatchApproval',
]);

/** The JSON-RPC result for an approval request: accepted for the session, or declined (the turn goes on). */
export function approvalResponse(method: string, params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'acceptForSession' : 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved_for_session' : 'denied' };
    case 'item/permissions/requestApproval':
      return allow ? { permissions: isRecord(params.permissions) ? params.permissions : {}, scope: 'session' } : { permissions: {}, scope: 'turn' };
    default:
      return {};
  }
}

/** `item/tool/requestUserInput`: we never answer for the human; empty answers decline politely. */
export function declineUserInput(): Record<string, unknown> {
  return { answers: {} };
}
