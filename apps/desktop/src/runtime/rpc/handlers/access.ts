// RPC handlers (AF-013) of the access modes: access.get with 'chat' (the composer's mode cell reads it), everything
// that changes access or answers an approval request for the owner only – the person on this PC, never an agent
// (an agent's MCP lease or tool calls never reach these) and never a paired device.
// Owns: param checks. Never: business logic (runtime/access/service.ts); a runtime without it answers 'unavailable'.

import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/access.ts';
import '../../../shared/api/methods-access.ts'; // the method shapes (module augmentation)
import { ACCESS_MODES, type AccessMode } from '../../../shared/model/access.ts';
import { bad, id, input, onlyKeys, oneOf, optId } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
const ANSWERS = ['once', 'always', 'deny'] as const;

function access(services: RuntimeServices) {
  if (!services.access) throw new WorkforceError('unavailable', 'Access modes are not available in this runtime.');
  return services.access;
}

/** `mode`: one of the four, or null (clears an override). */
function modeOrNull(o: Record<string, unknown>): AccessMode | undefined {
  if (!('mode' in o)) bad('mode', 'read, ask, project, full or null');
  if (o.mode === null) return undefined;
  return oneOf(o, 'mode', ACCESS_MODES);
}

export function register(table: HandlerTable): void {
  table.add('access.get', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId']);
    const agentId = id(o, 'agentId');
    ctx.services.org.require(agentId);
    const conversationId = optId(o, 'conversationId');
    return access(ctx.services).effective({ agentId, ...(conversationId ? { conversationId } : {}) });
  }, CHAT);
  table.add('access.set', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'mode', 'rules']);
    const agentId = id(o, 'agentId');
    ctx.services.org.require(agentId);
    const mode = o.mode === undefined ? undefined : oneOf(o, 'mode', ACCESS_MODES);
    if (mode === undefined && o.rules === undefined) bad('mode', 'a mode or rules to set');
    return access(ctx.services).set(agentId, { ...(mode ? { mode } : {}), ...(o.rules !== undefined ? { rules: o.rules as never } : {}) });
  }, 'owner');
  table.add('access.setChatMode', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'mode']);
    const conversationId = id(o, 'conversationId');
    if (!ctx.services.chats.get(conversationId)) throw new WorkforceError('not_found', 'This chat does not exist.');
    const mode = modeOrNull(o);
    access(ctx.services).setChatMode(conversationId, mode);
    return mode ? { mode } : {};
  }, 'owner');
  table.add('access.setRunMode', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['runId', 'mode']);
    const runId = id(o, 'runId');
    const mode = modeOrNull(o);
    access(ctx.services).setRunMode(runId, mode);
    return mode ? { mode } : {};
  }, 'owner');
  table.add('access.pending', (params, ctx) => {
    if (params !== undefined && params !== null) onlyKeys(input(params), []);
    return access(ctx.services).pending();
  }, 'owner');
  table.add('access.answer', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'answer']);
    return { ok: access(ctx.services).answer(id(o, 'id'), oneOf(o, 'answer', ANSWERS)) };
  }, 'owner');
}
