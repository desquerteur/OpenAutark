// Routing limits shared by router.ts and model-list.ts (moved out of router.ts unchanged, RT4):
// the error that says why no model fits a turn (no model, a missing capability, "never" priors, the policy band,
// or every account limited – with the earliest moment one is back).
// Owns: these texts. Never: routes, or changes state.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { ModelInfo } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { blockedUntil } from '../accounts/candidates.ts';
import { categoryLabel } from './categories.ts';
import type { Need } from './score.ts';

export const NO_MODEL_MESSAGE = 'No model is connected. Add an account in Settings → Models.';
/** Models fit, but every account that could run them is limited: an outage (B-059: a chat-free run waits for it, tasks/outages.ts). */
export const LIMITED_MESSAGE = 'Every account that can run a suitable model is limited right now.';
const NEED_TEXT: Record<Need, string> = {
  vision: 'No connected model can read images.',
  computerUse: 'No connected model supports computer use.',
  structured: 'No connected model supports structured answers.',
};

/** The first filter stage that left nothing, as the error the turn reports. */
export function nothingFits(input: {
  s: RuntimeServices; request: RouteRequest; connected: ModelInfo[]; capable: ModelInfo[]; suitable: ModelInfo[];
  bounded: ModelInfo[]; category: string; now: number;
}): WorkforceError {
  const { request, connected, capable, suitable, bounded } = input;
  if (!connected.length) return new WorkforceError('unavailable', request.exclude?.length ? 'No other model is available right now.' : NO_MODEL_MESSAGE);
  if (!capable.length) {
    const need = (['vision', 'computerUse', 'structured'] as Need[]).find((item) => request.needs?.[item]) ?? 'vision';
    return new WorkforceError('unavailable', NEED_TEXT[need], { details: { need, setup: true } });
  }
  // setup: true – the person (or the manager) has to change the setup; no outage that heals itself.
  if (!suitable.length) return new WorkforceError('unavailable', `No connected model is suitable for ${categoryLabel(input.category)}.`, { details: { setup: true } });
  if (!bounded.length) return new WorkforceError('unavailable', `No connected model fits the model policy of ${request.agent.name}.`, { details: { setup: true } });
  // Models fit, but every account that could run them is limited, excluded or unhealthy right now:
  // the earliest moment one of them is back (cooling or a used-up window of that model).
  const byId = new Map(input.s.accounts.list().map((account) => [account.id, account]));
  const until = bounded.flatMap((model) => model.accounts.map((id) => {
    const account = byId.get(id);
    return account ? blockedUntil(account, input.now, model.model) : undefined;
  })).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
  return new WorkforceError('unavailable', LIMITED_MESSAGE, until ? { retryAfterMs: until - input.now } : {});
}
