// RPC handlers (AF-006) of the personality: personality.agent (an agent's own values, its role part of SYSTEM.md and the
// prompt section it reads now) and personality.preview with 'chat' – reads like agents.get; personality.setAgent (its
// personality.json) and personality.setRole (its own part of SYSTEM.md, the team's standard above it kept –
// org/system-parts.ts withOwnPart, the rule of the agents.update tool) with 'manage', like agents.update. The global
// personality is settings.json `personality` and goes through settings.update.
// Owns: param checks. Never: the wording (personality/prompt.ts) or the file form (personality/store.ts).

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { Agent } from '../../../shared/model/org.ts';
import { PERSONALITY_FIELDS, personalityProblem, type AgentPersonality } from '../../../shared/model/personality.ts';
import '../../../shared/api/methods-personality.ts'; // the method shapes (module augmentation)
import type { AgentPersonalityInfo } from '../../../shared/api/methods-personality.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/open-fs.ts'; // services.prompts
import { hasWorkStandard, ownPart, withOwnPart } from '../../org/system-parts.ts';
import { staleBase } from '../../root/text-doc.ts';
import { personalitySection, personalityText } from '../../personality/prompt.ts';
import { readAgentPersonality, writeAgentPersonality } from '../../personality/store.ts';
import { bad, id, input, obj, onlyKeys, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
const MANAGE = { capability: 'manage' } as const;
/** SYSTEM.md's cap (org/patch.ts). */
const SYSTEM_MAX = 20_000;

function rules(services: RuntimeServices): string | undefined {
  try { return services.prompts?.get('rules'); } catch { return undefined; }
}

function info(services: RuntimeServices, agent: Agent): AgentPersonalityInfo {
  const instructions = agent.instructions ?? '';
  const inForce = rules(services);
  return {
    own: readAgentPersonality(services.paths?.data, agent.id),
    role: ownPart(instructions, inForce),
    standard: hasWorkStandard(instructions, inForce),
    instructions,
    preview: personalitySection(services, agent),
  };
}

function live(services: RuntimeServices, agentId: string): Agent {
  const agent = services.org.require(agentId);
  if (agent.archivedAt !== undefined) throw new WorkforceError('conflict', 'Restore this agent first.', { details: { id: agentId } });
  return agent;
}

/** The personality param: only known fields, each valid, null = follow the global one. */
function personalityParam(o: Record<string, unknown>): AgentPersonality {
  const value = obj(o, 'personality');
  onlyKeys(value, PERSONALITY_FIELDS, 'personality');
  const out: Record<string, string> = {};
  for (const field of PERSONALITY_FIELDS) {
    const item = value[field];
    if (item === undefined || item === null) continue;
    const problem = personalityProblem(field, item);
    if (problem) bad(`personality.${field}`, problem);
    out[field] = item as string;
  }
  return out as AgentPersonality;
}

export function register(table: HandlerTable): void {
  table.add('personality.agent', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId']);
    return info(ctx.services, ctx.services.org.require(id(o, 'agentId')));
  }, CHAT);
  table.add('personality.setAgent', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'personality']);
    const agent = live(ctx.services, id(o, 'agentId'));
    const personality = personalityParam(o);
    try {
      writeAgentPersonality(ctx.services.paths?.data, agent.id, personality);
    } catch (error) {
      throw new WorkforceError('conflict', `Could not save this agent's personality: ${error instanceof Error ? error.message : String(error)}`);
    }
    return info(ctx.services, agent);
  }, MANAGE);
  table.add('personality.setRole', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'role', 'base']);
    const agent = live(ctx.services, id(o, 'agentId'));
    const role = text(o, 'role', { max: SYSTEM_MAX, allowEmpty: true, multiline: true });
    const base = optText(o, 'base', { max: SYSTEM_MAX, allowEmpty: true, multiline: true });
    const next = role.trim() ? withOwnPart(agent.instructions ?? '', role, rules(ctx.services)) : '';
    if (!next.trim()) bad('role', 'the agent\'s role in a few words');
    if (base !== undefined && staleBase(agent.instructions ?? '', base, next)) {
      throw new WorkforceError('conflict', 'The instructions changed while you were editing (in SYSTEM.md or another edit). Load the new text and save again.');
    }
    return ctx.services.org.update(agent.id, { instructions: next }, { by: HUMAN_ID });
  }, MANAGE);
  table.add('personality.preview', (params, ctx) => {
    onlyKeys(input(params), []);
    let settings: ReturnType<RuntimeServices['settings']['get']> | undefined;
    try { settings = ctx.services.settings.get(); } catch { settings = undefined; }
    return { text: personalityText({ name: settings?.profile?.name ?? '', agentId: '<id>', global: settings?.personality }) };
  }, CHAT);
}
