// AF-013: Codex's own sandbox and approval policy for an agent turn with an access policy (EngineTurnInput.access).
// Without a policy an agent turn keeps today's full access (isolation.ts turnPermissions); a read turn (helpers, a cwd
// overlapping the server's) stays read-only in every case. With one:
//   read     sandbox readOnly, approval 'never' – a write fails in the sandbox, nobody is asked
//   ask      sandbox workspaceWrite (cwd + write folders), approval 'untrusted' – Codex asks before every command
//            that is not on its own safe list and before every patch; each request is judged by the rules (`decide`)
//   project  sandbox workspaceWrite, approval 'on-request' – Codex works in its folder and asks to leave the sandbox
//   full     with rules: no sandbox, approval 'untrusted' – the requests are judged, everything not forbidden runs
// The network inside the sandbox follows the rules (on unless they ask or deny); approval requests go to the client
// (approvalsReviewer 'user'), never to Codex's auto-reviewer. On Windows the sandbox is Codex's own Windows sandbox:
// where that build has none, a 'workspaceWrite' or 'readOnly' turn is as strict as Codex makes it, and the app's own
// tools are judged by the tool registry either way.
// Owns: these turn/start settings. Never: judges a request (turn.ts asks `decide`).

import type { TurnAccessPolicy } from '../types.ts';
import { turnPermissions, type TurnAccess } from './isolation.ts';

const REVIEWER = 'user';

/** turn/start settings for this turn: today's without a policy, else the mode's sandbox and approval policy. */
export function accessPermissions(policy: TurnAccessPolicy | undefined, access: TurnAccess, cwd: string): Record<string, unknown> {
  if (!policy || access === 'read') return turnPermissions(access);
  const writable = { type: 'workspaceWrite', writableRoots: [cwd, ...policy.writable], networkAccess: policy.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  switch (policy.mode) {
    case 'read':
      return { approvalPolicy: 'never', approvalsReviewer: REVIEWER, sandboxPolicy: { type: 'readOnly', networkAccess: policy.network } };
    case 'ask':
      return { approvalPolicy: 'untrusted', approvalsReviewer: REVIEWER, sandboxPolicy: writable };
    case 'project':
      return { approvalPolicy: 'on-request', approvalsReviewer: REVIEWER, sandboxPolicy: writable };
    case 'full':
      return { approvalPolicy: 'untrusted', approvalsReviewer: REVIEWER, sandboxPolicy: { type: 'dangerFullAccess' } };
  }
}

/** The paths a fileChange item names (item/started, item/completed): `changes: [{ path }]`. */
export function changePaths(item: Record<string, unknown>): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((change) => (typeof change === 'object' && change !== null ? (change as { path?: unknown }).path : undefined)).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}
