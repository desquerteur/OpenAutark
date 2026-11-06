// Model guidance shared by runtime and UI: the one model preference ("Model choice", B-044), the
// person's per-chat model hint and the work plan rule. Everything here is a mild, overridable signal – never a block; hard
// budgets, pins and policy bounds stay where they are (routing/policies.ts).
//   choice Settings.routing.costMode, stored 'best' | 'balanced' | 'economy', shown Best | Balanced |
//          Cheaper (B-044, 25.10.: "einfach nur Balanced oder halt nur das Beste oder ein bisschen
//          weniger"). The router's weights follow it (routing/score.ts) and every agent reads it as one
//          "Model preference" line (context/prompt-volatile.ts) – one switch for both.
//   hint   ConversationSettings.modelHints[agentId]: picked in the composer ("suggest this model").
//          Lifetime: it stays with that agent in that chat until the person picks Auto, another
//          model or "Always use this model" (= a hard pin, ConversationSettings.models); it is never
//          copied to other chats or agents and survives restarts. Routing gives it a bounded bonus.
//   work   the Work use (Settings.routing.work, shared/model/models-uses.ts): a plan's provider id ('codex') is the
//          plan agent turns prefer (routing/score.ts workPlanBonus); 'auto' = Claude Code while an enabled Claude
//          Code plan login exists, exactly as if 'claude' were chosen; a model id pins instead (routing/pins.ts).
//          Helper calls never use it (their use is Decisions, routing/helper-default.ts).
// B-044 removed the soft quality floor and cost guide (routing.guide, migration 69 strips stored
// values): the model choice above is the one cost preference.
// It joins the shared settings/chat/route shapes by module augmentation (like day-settings.ts), so
// those files stay untouched; RouteDecision.by 'hint' is the one direct addition (providers.ts).
// Owns: these shapes, defaults and labels, and the work plan rule. Never: reads settings or the catalog itself, or decides a route.

import type { Account } from './providers.ts';
import { accountCharge } from './charge.ts';
import { USE_AUTO, isProviderChoice } from './models-uses.ts';

/** The stored model choice (Settings.routing.costMode, ModelPolicy.costMode). */
export type ModelChoice = 'best' | 'balanced' | 'economy';
/** Best | Balanced | Cheaper, in this order (Settings › Models › Model choice). */
export const MODEL_CHOICES: readonly ModelChoice[] = ['best', 'balanced', 'economy'];
export const MODEL_CHOICE_LABELS: Readonly<Record<ModelChoice, string>> = { best: 'Best', balanced: 'Balanced', economy: 'Cheaper' };
/** What the choice asks of an agent, one clause for its "Model preference" line. */
export const MODEL_CHOICE_TEXT: Readonly<Record<ModelChoice, string>> = {
  best: 'the person prefers the strongest model for each step',
  balanced: 'the person wants good results at a fair price',
  economy: 'the person prefers the cheapest model that does each step well',
};

/** A stored model hint: a catalog-style id – no whitespace or control characters (it reaches prompts and chat lines). */
export const HINT_ID = /^[\w.:/@+~=,-]{1,200}$/;

/** The default work plan: Claude Code (provider 'claude'). */
export const DEFAULT_WORK_PLAN = 'claude';

/**
 * The plan agent turns prefer and whether it is the default (see the header's "work"): `work` is the Work use's value
 * ('auto', a plan's provider id, or a model id – a pin, no plan preference); undefined plan = none.
 */
export function effectiveWorkPlan(work: string | undefined, accounts: readonly Pick<Account, 'provider' | 'enabled' | 'auth' | 'plan'>[]): { plan?: string; byDefault: boolean } {
  const chosen = work?.trim();
  if (chosen && chosen !== USE_AUTO) return isProviderChoice(chosen) ? { plan: chosen, byDefault: false } : { byDefault: false };
  const claude = accounts.some((account) => account.provider === DEFAULT_WORK_PLAN && account.enabled && accountCharge(account) === 'plan');
  return claude ? { plan: DEFAULT_WORK_PLAN, byDefault: true } : { byDefault: false };
}

declare module './chat.ts' {
  interface ConversationSettings {
    /** Addition (SG): the person's soft model suggestion per member agent (agentId → model id). */
    modelHints?: Record<string, string>;
  }
}

declare module './providers.ts' {
  interface RouteDecision {
    /** Addition (SG): the chat's model hint and whether this route took it (`why` when not). */
    hint?: { modelId: string; taken: boolean; why?: string };
  }
}
