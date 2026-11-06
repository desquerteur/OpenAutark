// B-057 S10 – how a split's turn routes (router.ts applies it for RouteRequest.split). The split's own choice
// (agents/split-turn.ts turns 'same' | 'cheap' | 'strong' | a model id into RouteRequest.previous and needs.tier) beats
// the agent's pin, and – when it names an effort (or keeps the parent's: 'same') – the agent's fixed effort; a split
// has no chat, so the chat's pin and effort never apply.
// Owns: that adjustment. Never: picks a model, changes state, or touches a route that is not a split's.

import type { RouteRequest } from '../contracts.ts';
import type { EffectivePolicy } from './policies.ts';

/** The policy of a split's route: no agent pin (the Work use still applies, router.ts), no fixed effort when the split names one. */
export function splitPolicy(policy: EffectivePolicy, request: Pick<RouteRequest, 'split' | 'previous'>): EffectivePolicy {
  if (!request.split) return policy;
  const effortNamed = request.previous?.explicit === true && request.previous.asked !== 'model';
  return {
    ...policy,
    pin: undefined,
    ...(effortNamed ? { agentEffort: undefined, chatEffort: undefined } : {}),
  };
}
