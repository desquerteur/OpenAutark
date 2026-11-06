// RPC handlers of the F-51 start paths: patterns.* (team pattern library; importing another agent system is a
// skill now); agents.deriveKnowledge lives with
// the other agent portability handlers (portability.ts).
// Tiers: like hiring ('manage'); fetching or reading a pattern from outside (patterns.import,
// patterns.refresh) is owner-only. Proposals are checked again in the runtime (org/team-proposal.ts).
// Owns: param checks. Never: business logic; a runtime without these services answers 'unavailable'.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { PATTERN_MAX_CHARS } from '../../../shared/model/team-start.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/team-start.ts';
import '../../../shared/api/methods-team-start.ts'; // the method shapes (module augmentation)
import { cleanProposal, createTeam } from '../../org/team-proposal.ts';
import { bad, capJson, id, input, obj, oneOf, onlyKeys, optId, optNum, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const MANAGE = { capability: 'manage' } as const;

function need<K extends 'patterns'>(s: RuntimeServices, key: K): NonNullable<RuntimeServices[K]> {
  const service = s[key];
  if (!service) throw new WorkforceError('unavailable', 'This is not available in this runtime.');
  return service as NonNullable<RuntimeServices[K]>;
}

/** 'human' (report to the person) or an agent id. */
function manager(o: Record<string, unknown>): string | undefined {
  if (o.managerId === HUMAN_ID) return HUMAN_ID;
  return optId(o, 'managerId');
}

function proposal(o: Record<string, unknown>) {
  capJson('agents', o.agents, 1_500_000);
  return cleanProposal(o.agents);
}

export function register(table: HandlerTable): void {
  table.add('patterns.list', (params, ctx) => {
    onlyKeys(input(params), []);
    return need(ctx.services, 'patterns').list();
  }, MANAGE);
  table.add('patterns.get', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return need(ctx.services, 'patterns').get(id(o));
  }, MANAGE);
  table.add('patterns.apply', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['patternId', 'agents', 'managerId']);
    const patternId = optId(o, 'patternId');
    if (patternId) need(ctx.services, 'patterns').get(patternId); // a removed pattern fails clearly
    return { agents: createTeam(ctx.services, proposal(o), { managerId: manager(o), ref: `pattern:${patternId ?? 'edited'}` }) };
  }, MANAGE);
  table.add('patterns.saveFromOrg', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'description', 'rootId']);
    return need(ctx.services, 'patterns').saveFromOrg({ name: text(o, 'name', { max: 80 }), description: optText(o, 'description', { max: 500 }), rootId: optId(o, 'rootId') });
  }, MANAGE);
  table.add('patterns.import', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['url', 'name', 'text']);
    const url = optText(o, 'url', { max: 2000 });
    const body = optText(o, 'text', { max: PATTERN_MAX_CHARS, multiline: true });
    if (!url === (body === undefined)) bad('params', 'either url or text');
    return need(ctx.services, 'patterns').import({ url, name: optText(o, 'name', { max: 300 }), text: body });
  });
  table.add('patterns.refresh', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return need(ctx.services, 'patterns').refresh(id(o));
  });
  table.add('patterns.remove', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    need(ctx.services, 'patterns').remove(id(o));
    return { ok: true as const };
  }, MANAGE);
}
