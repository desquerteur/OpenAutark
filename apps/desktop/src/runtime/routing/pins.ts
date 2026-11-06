// Pin helpers of the router (moved out of router.ts unchanged, RT1): the reason texts of pins,
// the Settings use pin (Work for agents, Decisions for runtime helper calls – shared/model/models-uses.ts),
// why a pin is unusable, and how a pinned id finds its model.
// Owns: these lookups and texts. Never: decides whether a pin wins (router.ts does) or reads
// state beyond the settings and catalog list it is given.

import type { RouteRequest } from '../contracts.ts';
import type { ModelInfo } from '../../shared/model/providers.ts';
import type { RoutingSettings } from '../../shared/model/system.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { chosenFor, isProviderChoice } from '../../shared/model/models-uses.ts';
import { ENGINE_PROVIDERS } from '../accounts/candidates.ts';
import { categoryLabel } from './categories.ts';

/** Provider prefixes of catalog ids (`${provider}:${model}`). */
const PROVIDER_IDS: ReadonlySet<string> = new Set(Object.values(ENGINE_PROVIDERS).flat());

export const PIN_TEXT: Record<'chat' | 'agent' | 'settings' | 'helper', string> = {
  chat: 'pinned in this chat', agent: 'pinned for this agent', settings: 'set in Settings',
  helper: 'helper default', // SG: runtime text calls on a Codex plan's small model (helper-default.ts)
};

/**
 * The Settings use of a route as a pin: agent turns take the Work model (every kind of work; a plan's provider id is
 * no pin – it is the work plan, preference.ts), runtime helper calls (agent 'system') the Decisions model. "auto" = none.
 */
export function settingsPin(settings: RoutingSettings, request: RouteRequest): { modelId: string; source: 'settings' } | undefined {
  const chosen = chosenFor(settings, request.agent.id === SYSTEM_ID ? 'decision' : 'work');
  return chosen && !isProviderChoice(chosen) ? { modelId: chosen, source: 'settings' } : undefined;
}

export function pinProblem(why: string, category: string): string {
  if (why === 'never') return `not for ${categoryLabel(category)}`;
  if (why === 'policy') return 'outside the model policy';
  return `needs ${why}`;
}

/**
 * Exact model id; a bare provider model id from an old client ("claude-opus-5-5", "qwen3:8b")
 * matches any provider listing it. A provider-qualified id never moves to another provider –
 * e.g. a "codex:" plan pin must not silently become a pay-per-use "openai:" API-key model.
 */
export function resolvePin(models: readonly ModelInfo[], pin: string): ModelInfo | undefined {
  const exact = models.find((model) => model.id === pin);
  if (exact) return exact;
  // the older "<provider>:<model>" of a connection that now names itself (settings.json providers)
  const older = models.filter((model) => `${model.provider}:${model.model}` === pin);
  if (older.length) return older.find((model) => model.available) ?? older[0];
  const colon = pin.indexOf(':');
  if (colon > 0 && PROVIDER_IDS.has(pin.slice(0, colon))) return undefined;
  return models.find((model) => model.model === pin && model.available) ?? models.find((model) => model.model === pin);
}
