// The quiet routing lines of one turn (RT5 + SG), for agents/turn.ts announceSwitch:
//   - a model/effort switch: "Switched to <model> · <effort> — <why>" (switch-line.ts) – the why
//     leads with a deviation from the chat's model hint when routing did not take it
//   - no switch (or the chat's first turn) but routing deviates from the hint: one "Kept <model> ·
//     <effort> — <why>" ("Using …" on a first turn) – once per situation: kv 'route_line' keeps the
//     last noted (hint → model) per agent and chat, so the same deviation is not repeated every
//     turn; a taken hint clears it.
// Without a hint deviation a turn only reads kv (one indexed lookup) and deletes a marker that is
// actually there – no write on the usual turn. (B-044 removed the soft guide's notes.)
// Owns: these lines and their de-duplication. Never: posts lines (turn.ts does), routes, or
// writes kv for a turn without a hint deviation unless an old marker must be cleared.

import type { RuntimeServices } from '../contracts.ts';
import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';
import { capText, switchText, switchWhy } from './switch-line.ts';

const NS = 'route_line';

export interface RouteLine { text: string; details: Record<string, unknown> }

/** The deviation of a route: the hint it did not take (undefined: none). */
export function deviation(route: Pick<RouteDecision, 'hint'>): string | undefined {
  return route.hint && !route.hint.taken && route.hint.why ? route.hint.why : undefined;
}

function marker(route: RouteDecision): string {
  return `${route.hint?.modelId ?? ''}>${route.modelId}`;
}

/** Lines to post for this route; `from` = what the chat's last turn ran on (turn.ts switchedFrom). */
export function routeLines(services: Pick<RuntimeServices, 'db' | 'clock' | 'log'>, scope: { agentId: string; conversationId?: string }, route: RouteDecision, modelName: string, from: { modelId: string; effort: Effort; requested?: boolean } | undefined): RouteLine[] {
  const switched = Boolean(from && (from.modelId !== route.modelId || from.effort !== route.effort));
  const off = deviation(route);
  const details = { to: route.modelId, effort: route.effort, reason: route.reason, by: route.by, ...(route.hint ? { hint: route.hint } : {}) };
  let kv: KvRepo | undefined;
  const key = `${scope.agentId}:${scope.conversationId ?? ''}`;
  try { kv = scope.conversationId ? new KvRepo(services.db) : undefined; } catch { kv = undefined; }
  let seen: string | undefined;
  try { seen = kv?.get<string>(NS, key); } catch { seen = undefined; }
  const remember = (value: string | undefined) => {
    try {
      if (!kv || value === seen) return;
      if (value) kv.set(NS, key, value, services.clock.now());
      else kv.delete(NS, key);
    } catch (error) {
      services.log.warn('route line marker failed', { error: String(error) });
    }
  };

  if (switched && from) {
    const why = switchWhy(route, from);
    remember(off ? marker(route) : undefined);
    return [{ text: switchText(modelName, route.effort, why), details: { from: from.modelId, ...details } }];
  }
  if (!off) {
    remember(undefined); // back inside: the next deviation is noted again
    return [];
  }
  if (seen === marker(route)) return [];
  remember(marker(route));
  const verb = from ? 'Kept' : 'Using';
  return [{ text: capText(`${verb} ${modelName} · ${route.effort} — ${off}`), details: { ...(from ? { from: from.modelId } : {}), ...details } }];
}
