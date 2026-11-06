// RPC handler: `session.info` – who this connection is (owner or device), its capabilities,
// whether its transport is secure and exactly which methods it may call, computed from the
// handler table with the same rule the server enforces (table.ts `allowedScope`). The UI gates
// its controls with it instead of guessing from the platform.
// Owns: that projection. Never: grants anything – the server still checks every call.

import type { MethodName, SessionInfo } from '../../../shared/api/methods.ts';
import type { ClientScope } from '../../../shared/api/protocol.ts';
import { allowedScope, capabilitiesOf, secureScope } from '../table.ts';
import type { HandlerTable } from '../table.ts';

/** The session as `scope` sees it on this table. */
export function sessionInfo(table: HandlerTable, scope: ClientScope): SessionInfo {
  const allowedMethods = table.methods().filter((method) => {
    const entry = table.get(method);
    return entry !== undefined && allowedScope(entry.scope, scope);
  }) as MethodName[];
  return { kind: scope.kind === 'owner' ? 'owner' : 'device', capabilities: capabilitiesOf(scope), secure: secureScope(scope), allowedMethods };
}

export function register(table: HandlerTable): void {
  table.add('session.info', (_params, ctx) => sessionInfo(table, ctx.scope), 'any');
}
