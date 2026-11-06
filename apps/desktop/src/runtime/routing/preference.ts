// The model preference of one agent turn (B-044 "Model choice": Best | Balanced | Cheaper, stored
// best/balanced/economy): the same value the router scores with and the agent reads – economy while
// the agent's budget warns, else an agent policy's own cost mode (no UI sets one since B-044; a stored
// one is still honoured), else Settings.routing.costMode. Also the work plan agent turns prefer
// (shared/model/model-guide.ts effectiveWorkPlan over the Work use and the accounts – the router and the
// models.list tool read it here; helper calls never do).
// Owns: those rules. Never: routes, or writes a policy or settings.

import type { RuntimeServices } from '../contracts.ts';
import { effectiveWorkPlan } from '../../shared/model/model-guide.ts';
import { useValue } from '../../shared/model/models-uses.ts';
import type { EffectivePolicy } from './policies.ts';
import type { CostMode } from './score.ts';

/** The cost mode a route of this agent uses. */
export function costModeOf(s: RuntimeServices, policy: Pick<EffectivePolicy, 'costMode'>): CostMode {
  let stored: CostMode | undefined;
  try { stored = s.settings.get().routing.costMode; } catch { stored = undefined; }
  return policy.costMode ?? stored ?? 'balanced';
}

/** The plan provider agent turns prefer now ('claude' by default while a Claude Code plan login is enabled); undefined = none. */
export function workPlanOf(s: Pick<RuntimeServices, 'settings' | 'accounts'>): string | undefined {
  let work: string | undefined;
  try { work = useValue(s.settings.get().routing, 'work'); } catch { work = undefined; }
  let accounts: ReturnType<RuntimeServices['accounts']['list']> = [];
  try { accounts = s.accounts.list(); } catch { accounts = []; }
  return effectiveWorkPlan(work, accounts).plan;
}
