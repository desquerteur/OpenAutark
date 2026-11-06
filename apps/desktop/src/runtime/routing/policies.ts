// Model policies at three scopes and how the router combines them:
//   agent        → agents.model_policy (org.update)          – set by the user or a manager
//   chat + agent → conversation.settings.models/efforts[agentId] – the chat's hard pin ("Always use
//                  this model", API clients' messages.send model) and effort; a chat-scope setPolicy
//                  replaces the choice whole
//   global       → kv ns 'routing', key 'default_policy'      – defaults for every agent; never a
//                  cost mode (23.10.2026: one global cost mode, Settings.routing.costMode – a
//                  global setPolicy with costMode writes it there; migration 55 moved stored ones) and
//                  never a pin (01.11.2026: the default model is the Work use, Settings.routing.work – a
//                  global setPolicy with a pin writes it there; an older stored pin moves there once)
// Owns: validation of ModelPolicy input, get/set per scope, the PolicyApi factory for RPC and
// `effectivePolicy` (global defaults → agent → chat choice; the default model is the Work use, router.ts).
// Never: routes (router.ts does) or lets a chat scope store bounds (only pin/effort live there).

import type { RuntimeServices } from '../contracts.ts';
import type { PolicyApi } from '../rpc/extras.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Effort, ModelInfo, ModelPolicy } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { normalizeEffort } from '../models/efforts.ts';
import { USE_AUTO, chosenFor, isProviderChoice, useValue } from '../../shared/model/models-uses.ts';

export interface PolicyScope {
  agentId?: string;
  conversationId?: string;
}

export const POLICY_NS = 'routing';
export const DEFAULT_POLICY_KEY = 'default_policy';
export const TIER_ORDER: ReadonlyArray<ModelInfo['tier']> = ['local', 'small', 'strong', 'frontier'];
const COST_MODES: ReadonlySet<string> = new Set(['economy', 'balanced', 'best']);
const MAX_LIST = 50;
const MAX_ID = 200;

function bad(message: string): never {
  throw new WorkforceError('bad_request', message);
}

function modelId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '' || value === 'auto') return undefined;
  if (typeof value !== 'string' || value.length > MAX_ID || /[\u0000-\u001f]/.test(value)) bad(`Enter a valid model for ${field}.`);
  return value.trim() || undefined;
}

function tier(value: unknown, field: string): ModelInfo['tier'] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!TIER_ORDER.includes(value as ModelInfo['tier'])) bad(`Choose a valid ${field}.`);
  return value as ModelInfo['tier'];
}

function idList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST) bad(`Enter a valid list of models for ${field}.`);
  const out = [...new Set(value.map((item) => modelId(item, field)).filter((item): item is string => Boolean(item)))];
  return out.length ? out : undefined;
}

/** Validates and normalizes a policy (unknown fields dropped, 'auto' pin = no pin). */
export function cleanPolicy(value: unknown): ModelPolicy {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) bad('Enter a valid model policy.');
  const raw = value as Record<string, unknown>;
  const policy: ModelPolicy = {};
  const pin = modelId(raw.pin, 'the pinned model');
  if (pin) policy.pin = pin;
  if (raw.effort !== undefined && raw.effort !== null && raw.effort !== '' && raw.effort !== 'auto') {
    const effort = normalizeEffort(raw.effort);
    if (!effort) bad('Choose a valid effort.');
    policy.effort = effort;
  }
  const floor = tier(raw.floorTier, 'lowest tier');
  const ceiling = tier(raw.ceilingTier, 'highest tier');
  if (floor && ceiling && TIER_ORDER.indexOf(floor) > TIER_ORDER.indexOf(ceiling)) bad('The lowest allowed tier is above the highest allowed tier.');
  if (floor) policy.floorTier = floor;
  if (ceiling) policy.ceilingTier = ceiling;
  if (raw.costMode !== undefined && raw.costMode !== null && raw.costMode !== '') {
    if (!COST_MODES.has(String(raw.costMode))) bad('Choose economy, balanced or best.');
    policy.costMode = raw.costMode as ModelPolicy['costMode'];
  }
  const prefer = idList(raw.prefer, 'preferred models');
  const avoid = idList(raw.avoid, 'avoided models');
  if (prefer) policy.prefer = prefer;
  if (avoid) policy.avoid = avoid;
  return policy;
}

function isEmpty(policy: ModelPolicy | undefined): boolean {
  return !policy || Object.values(policy).every((value) => value === undefined);
}

/** The single agent of a chat when a client names only the conversation (1:1 composer). */
function soleAgent(services: RuntimeServices, conversationId: string): string | undefined {
  const agents = services.chats.members(conversationId).filter((member) => member.kind === 'agent' && !member.leftAt);
  return agents.length === 1 ? agents[0].memberId : undefined;
}

function resolveScope(services: RuntimeServices, scope: PolicyScope): { kind: 'global' } | { kind: 'agent'; agentId: string } | { kind: 'chat'; agentId: string; conversationId: string } {
  const conversationId = scope.conversationId || undefined;
  let agentId = scope.agentId || undefined;
  if (conversationId) {
    agentId ??= soleAgent(services, conversationId);
    if (!agentId) bad('Choose which agent this model choice is for.');
    return { kind: 'chat', agentId, conversationId };
  }
  return agentId ? { kind: 'agent', agentId } : { kind: 'global' };
}

/** The global default policy (or undefined); an older stored pin moves to the Work use once (it is no part of it). */
export function defaultPolicy(services: RuntimeServices): ModelPolicy | undefined {
  const kv = new KvRepo(services.db);
  const stored = kv.get<ModelPolicy>(POLICY_NS, DEFAULT_POLICY_KEY);
  if (!stored) return undefined;
  let policy: ModelPolicy;
  try { policy = cleanPolicy(stored); } catch { return undefined; }
  if (!policy.pin) return policy;
  const { pin, ...rest } = policy;
  try {
    if (useValue(services.settings.get().routing, 'work') === USE_AUTO) services.settings.update({ routing: { work: pin } });
    if (isEmpty(rest)) kv.delete(POLICY_NS, DEFAULT_POLICY_KEY);
    else kv.set(POLICY_NS, DEFAULT_POLICY_KEY, rest, services.clock.now());
  } catch { /* moved on a later read */ }
  return rest;
}

/** The sticky composer choice of one agent in one chat ('auto' = no pin). */
export function chatChoice(services: RuntimeServices, conversationId: string | undefined, agentId: string): { pin?: string; effort?: Effort } {
  if (!conversationId) return {};
  const settings = services.chats.get(conversationId)?.settings;
  const pin = settings?.models?.[agentId];
  const effort = normalizeEffort(settings?.efforts?.[agentId]);
  return { pin: typeof pin === 'string' && pin && pin !== 'auto' ? pin : undefined, effort };
}

export function getPolicy(services: RuntimeServices, scope: PolicyScope): ModelPolicy | null {
  const target = resolveScope(services, scope);
  if (target.kind === 'global') {
    const stored = defaultPolicy(services) ?? {}; // first: an older stored pin moves to the Work use
    const work = chosenFor(services.settings.get().routing, 'work');
    const policy: ModelPolicy = { ...stored, ...(work && !isProviderChoice(work) ? { pin: work } : {}) };
    return isEmpty(policy) ? null : policy;
  }
  if (target.kind === 'agent') {
    const agent = services.org.get(target.agentId);
    if (!agent) throw new WorkforceError('not_found', 'This agent does not exist.');
    return isEmpty(agent.modelPolicy) ? null : { ...agent.modelPolicy };
  }
  const choice = chatChoice(services, target.conversationId, target.agentId);
  const policy: ModelPolicy = {};
  if (choice.pin) policy.pin = choice.pin;
  if (choice.effort) policy.effort = choice.effort;
  return isEmpty(policy) ? null : policy;
}

export function setPolicy(services: RuntimeServices, scope: PolicyScope, policy: ModelPolicy): void {
  const clean = cleanPolicy(policy);
  const target = resolveScope(services, scope);
  if (target.kind === 'global') {
    // One global cost mode (Settings.routing.costMode) and one default model (the Work use, Settings.routing.work).
    const { costMode, pin, ...rest } = clean;
    if (costMode || pin) services.settings.update({ routing: { ...(costMode ? { costMode } : {}), ...(pin ? { work: pin } : {}) } });
    const kv = new KvRepo(services.db);
    if (isEmpty(rest)) kv.delete(POLICY_NS, DEFAULT_POLICY_KEY);
    else kv.set(POLICY_NS, DEFAULT_POLICY_KEY, rest, services.clock.now());
    return;
  }
  if (!services.org.get(target.agentId)) throw new WorkforceError('not_found', 'This agent does not exist.');
  if (target.kind === 'agent') {
    services.org.update(target.agentId, { modelPolicy: clean });
    return;
  }
  // Chat scope stores only the composer choice; the maps are replaced whole (shallow settings merge).
  const conversation = services.chats.get(target.conversationId);
  if (!conversation) throw new WorkforceError('not_found', 'This chat does not exist.');
  const models = { ...(conversation.settings.models ?? {}) };
  const efforts = { ...(conversation.settings.efforts ?? {}) };
  if (clean.pin) models[target.agentId] = clean.pin;
  else delete models[target.agentId];
  if (clean.effort) efforts[target.agentId] = clean.effort;
  else delete efforts[target.agentId];
  // SG: the chat choice is replaced whole – the agent's soft hint goes too, so a later "no pin" never revives it.
  const hints = conversation.settings.modelHints;
  const modelHints = hints && target.agentId in hints ? Object.fromEntries(Object.entries(hints).filter(([id]) => id !== target.agentId)) : undefined;
  services.chats.update(target.conversationId, { settings: { models, efforts, ...(modelHints ? { modelHints } : {}) } }, 'human');
}

/** RPC surface (`models.getPolicy` / `models.setPolicy`). */
export function createPolicyApi(services: () => RuntimeServices): PolicyApi {
  return {
    get: (scope) => getPolicy(services(), scope ?? {}),
    set: (scope, policy) => setPolicy(services(), scope ?? {}, policy),
  };
}

/** The policy the router applies for one agent in one chat, with where each part came from. */
export interface EffectivePolicy {
  pin?: { modelId: string; source: 'chat' | 'agent' };
  /** Fixed effort of the agent policy (wins over the chat choice). */
  agentEffort?: Effort;
  chatEffort?: Effort;
  defaultEffort?: Effort;
  floorTier?: ModelInfo['tier'];
  ceilingTier?: ModelInfo['tier'];
  costMode?: ModelPolicy['costMode'];
  prefer: string[];
  avoid: string[];
}

export function effectivePolicy(services: RuntimeServices, agent: Agent, conversationId?: string): EffectivePolicy {
  let agentPolicy: ModelPolicy = {};
  try { agentPolicy = cleanPolicy(agent.modelPolicy); } catch { agentPolicy = {}; } // tolerate old rows
  const global = defaultPolicy(services) ?? {};
  const chat = chatChoice(services, conversationId, agent.id);
  const pin = chat.pin ? { modelId: chat.pin, source: 'chat' as const }
    : agentPolicy.pin ? { modelId: agentPolicy.pin, source: 'agent' as const } : undefined;
  // Agent bounds override the defaults; a conflict created by mixing them drops the default.
  let floorTier = agentPolicy.floorTier ?? global.floorTier;
  let ceilingTier = agentPolicy.ceilingTier ?? global.ceilingTier;
  if (floorTier && ceilingTier && TIER_ORDER.indexOf(floorTier) > TIER_ORDER.indexOf(ceilingTier)) {
    if (agentPolicy.floorTier) ceilingTier = agentPolicy.ceilingTier;
    else floorTier = undefined;
  }
  return {
    pin, agentEffort: agentPolicy.effort, chatEffort: chat.effort, defaultEffort: global.effort, floorTier, ceilingTier,
    costMode: agentPolicy.costMode ?? global.costMode,
    prefer: [...new Set([...(agentPolicy.prefer ?? []), ...(global.prefer ?? [])])],
    avoid: [...new Set([...(agentPolicy.avoid ?? []), ...(global.avoid ?? [])])],
  };
}
