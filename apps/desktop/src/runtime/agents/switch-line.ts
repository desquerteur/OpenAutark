// Wording of the quiet "model switched" status line (RT5): "Switched to <model> · <effort> —
// <why>", at most 120 characters. The chat shows the text and the agent reads the same text in its
// delta ("· Switched to …", context/render.ts), so both know why the model changed.
//   why = the first segment of the route reason ("GPT-6.1 Sol is weak at video animation",
//   "pinned in this chat"); a bare category label joins what follows ("strongest fit for coding").
//   failover = what happened to the model before ("GPT-6.1 Sol hit its usage limit"); the same
//   model on another account names no account (labels may hold an e-mail address).
//   RT2: an effort change the agent asked for itself (model.set) says "effort requested by the
//   agent"; the return to the choice before a request says so (RETURN_WHY).
//   An escalation of a stuck task says "no progress in the last 4 turns" (no routing jargon).
// Owns: these texts. Never: posts lines (turn.ts does) or reads state.

import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import { categoryLabel } from '../routing/categories.ts';
import { BY_REQUEST, EFFORT_REQUESTED } from '../routing/previous.ts';

/** Longest status text (the chat line and the agent's delta stay one short line). */
export const STATUS_MAX = 120;
const SEGMENT = ' · ';

/** routing/escalate.ts's note on a stuck task's route ("stuck 4 turns → stronger model"). */
const STUCK = /^stuck (\d+) turns?(?![a-z])/;

/** Why of the turn after the agent's own request (RT2) that returns to the choice before it. */
export const RETURN_WHY = 'back to the choice before the agent\'s request';

/** Cuts at a word boundary when one is near and ends with "…". */
export function capText(text: string, max = STATUS_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·—-]+$/u, '')}…`;
}

/** The first reason segment of a route reason (router.ts joins segments with " · "). */
export function firstReason(reason: string | undefined, category: string | undefined): string | undefined {
  const segments = (reason ?? '').split(SEGMENT).map((segment) => segment.trim()).filter(Boolean);
  const [first, next] = segments;
  if (!first) return undefined;
  const label = category ? categoryLabel(category) : undefined;
  if (first !== label) return first;
  return next ? `${next} for ${label}` : `for ${label}`;
}

/** "Switched to Claude Opus 5.5 · high — GPT-6.1 Sol is weak at video animation". */
export function switchText(modelName: string, effort: Effort, why?: string): string {
  return capText(`Switched to ${modelName} · ${effort}${why ? ` — ${why}` : ''}`);
}

/** The failover line: the model (or account) the turn moved away from and why. */
export function failoverText(input: { modelName: string; effort: Effort; failedName: string; sameModel: boolean; limited: boolean }): string {
  if (input.sameModel) {
    const why = input.limited ? 'the first one hit its usage limit' : 'the first one is unavailable right now';
    return capText(`Switched to another account · ${input.modelName} · ${input.effort} — ${why}`);
  }
  const why = input.limited ? `${input.failedName} hit its usage limit` : `${input.failedName} is unavailable right now`;
  return switchText(input.modelName, input.effort, why);
}

/**
 * The why of a routing switch away from `from` (what the chat's last turn ran on; `requested` =
 * that turn was shaped by the agent's own request): an effort-only change the agent asked for names
 * the request, the return rule continuing the choice before a request says so, else the first reason.
 */
export function switchWhy(route: Pick<RouteDecision, 'modelId' | 'reason' | 'category' | 'by'>, from: { modelId: string; requested?: boolean }): string | undefined {
  const segments = route.reason.split(SEGMENT).map((segment) => segment.trim());
  if (route.by === BY_REQUEST && route.modelId === from.modelId && segments.includes(EFFORT_REQUESTED)) return EFFORT_REQUESTED;
  if (from.requested && route.by === 'previous') return RETURN_WHY;
  // an escalation (routing/escalate.ts "stuck N turns …"): plain words, without the work category
  const stalls = segments.map((segment) => STUCK.exec(segment)?.[1]).find(Boolean);
  if (stalls) return stalls === '1' ? 'no progress in the last turn' : `no progress in the last ${stalls} turns`;
  return firstReason(route.reason, route.category);
}
