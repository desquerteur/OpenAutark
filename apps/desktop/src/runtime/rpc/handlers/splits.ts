// splits.* (B-057, shared/api/methods-splits.ts): an agent's splits for the owner's window and phones. Reads are 'chat'
// methods with the access rule of runs.items (org.ts checkRunAccess), applied through the group's PARENT run – its chat,
// or for a chat-free parent its task while it exists; 'manage' devices
// and the owner read every group. splits.list leaves out the groups a device may not open instead of failing.
// splits.stop needs the rights of runs.cancel ('manage') and stops as the person (merging a part's branch is the agent's
// work: agents.split_merge). Without a split service (fakes) the list is empty, a split is not found and nothing is
// stopped.
// Owns: these handlers, their parameter checks and that access rule. Never: the split lifecycle (services.splits).

import { HUMAN_ID } from '../../../shared/ids.ts';
import '../../../shared/api/methods-splits.ts'; // the method shapes (module augmentation)
import '../../contracts/splits.ts'; // RuntimeServices.splits
import type { Run } from '../../../shared/model/runs.ts';
import { SPLIT_TERMINAL, type SplitGroup, type SplitView } from '../../../shared/model/splits.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { bad, id, input, notFound, oneOf, onlyKeys, optBool, optId, optNum } from '../params.ts';
import { scopeHas } from '../table.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
const MANAGE = { capability: 'manage' } as const;
const LIST_MAX = 200;

/** The group's parent run as stored, else (a run that is gone) the group's own chat and task. */
function parentRun(ctx: HandlerContext, group: SplitGroup): Pick<Run, 'id' | 'conversationId' | 'taskId'> {
  const run = ctx.services.runs.get(group.parentRunId);
  return run ?? { id: group.parentRunId, conversationId: group.conversationId, taskId: group.taskId };
}

/** runs.items' rule (org.ts checkRunAccess) for the group's parent run. */
function checkGroupAccess(ctx: HandlerContext, group: SplitGroup): void {
  if (scopeHas(ctx.scope, 'manage')) return;
  const run = parentRun(ctx, group);
  if (run.conversationId && ctx.services.chats.get(run.conversationId)) return;
  if (!run.conversationId && (!run.taskId || ctx.services.tasks.get(run.taskId))) return;
  throw new WorkforceError('forbidden', 'Open this on your PC, or allow this phone in Settings › Devices.', { details: { groupId: group.id } });
}

function mayOpen(ctx: HandlerContext, group: SplitGroup): boolean {
  try { checkGroupAccess(ctx, group); return true; } catch { return false; }
}

export function register(table: HandlerTable): void {
  table.add('splits.list', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'parentRunId', 'groupId', 'conversationId', 'active', 'limit']);
    const agentId = optId(o, 'agentId');
    if (agentId) ctx.services.org.require(agentId);
    const query = {
      agentId, parentRunId: optId(o, 'parentRunId'), groupId: optId(o, 'groupId'), conversationId: optId(o, 'conversationId'),
      active: optBool(o, 'active'), limit: optNum(o, 'limit', { min: 1, max: LIST_MAX }) ?? 50,
    };
    const groups = ctx.services.splits?.list(query) ?? [];
    return groups.filter((group) => mayOpen(ctx, group));
  }, CHAT);

  table.add('splits.get', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const splitId = id(o);
    const found = ctx.services.splits?.get(splitId) ?? notFound('Split', { id: splitId });
    checkGroupAccess(ctx, found.group);
    return found;
  }, CHAT);

  table.add('splits.stop', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'groupId']);
    const splitId = optId(o, 'id');
    const groupId = optId(o, 'groupId');
    if (!splitId && !groupId) bad('id', 'a split id or a groupId');
    const splits = ctx.services.splits;
    if (!splits) return { stopped: 0 };
    const group = splitId
      ? (splits.get(splitId) ?? notFound('Split', { id: splitId })).group
      : splits.list({ groupId, limit: 1 })[0] ?? notFound('Split group', { groupId });
    if (splitId && groupId && group.id !== groupId) bad('groupId', 'the group of that split');
    checkGroupAccess(ctx, group);
    return { stopped: splits.stop(splitId ? { splitId } : { groupId: group.id }, HUMAN_ID) };
  }, MANAGE);

}
