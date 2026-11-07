// Composition of AF-013's access service (runtime/access/*): the store on the agent folders and the kv table, the
// approval requests on the bus (and as a 'blocker' notification, so a closed window still learns of one), the agents'
// home projects from the agent core. Owns: this wiring. Never: behaviour.

import { randomBytes } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/access.ts';
import '../contracts/agent-core.ts';
import type { AccessRequest } from '../../shared/model/access.ts';
import { KvRepo } from '../store/kv.ts';
import { AccessStore } from '../access/store.ts';
import { ApprovalBroker } from '../access/approvals.ts';
import { AccessService } from '../access/service.ts';

/** A request id: `acr_` + time + random (an id the RPC parameters accept). */
export function requestId(now: number): string {
  return `acr_${now.toString(36)}${randomBytes(6).toString('hex')}`;
}

/** A waiting request also reaches the person with the window closed: a 'blocker' notification that opens its chat. */
function notifyRequest(s: RuntimeServices, request: AccessRequest): void {
  try {
    s.notifications?.notify({ kind: 'blocker', title: `${request.agentName} asks for approval`, body: request.summary, ...(request.conversationId ? { conversationId: request.conversationId } : {}) });
  } catch { /* the dialog still shows it */ }
}

export function createAccess(s: RuntimeServices): AccessService {
  const store = new AccessStore({ dataDir: s.paths.data, kv: new KvRepo(s.db), now: () => s.clock.now() });
  const broker = new ApprovalBroker({
    emit: (event: 'access.requested' | 'access.resolved', data: never) => {
      s.bus.emit(event, data);
      if (event === 'access.requested') notifyRequest(s, data as AccessRequest);
    },
    now: () => s.clock.now(), id: () => requestId(s.clock.now()),
  });
  const access = new AccessService({
    store, broker,
    emit: (event, data) => s.bus.emit(event, data),
    workspace: () => s.paths.workspace,
    home: (agentId) => s.agentCore?.homes.usable(agentId),
    agentName: (agentId) => s.org?.get(agentId)?.name ?? agentId,
  });
  s.access = access;
  return access;
}
