// "Use model X" requests of the agent itself (model.set tool → the routing of later turns) and
// the choice a turn returns to (RT2).
// Owns: in the kv table, one pending next-step request per (agent, chat) – the next turn consumes
// it – and one task request per (agent, chat, task) – every turn on that task applies it until the
// task is done or cancelled, then its row is dropped; on a stuck task (RT1) a task request whose
// model stalled gives way to the escalation (a next-step request still wins its one step);
// `returnChoice`, a turn's RouteRequest.previous:
// the request in force (explicit; the next step's fields over the task's), else the last done run
// in the chat that no request shaped (runs.route.by 'request' is skipped) and that the interim B-044
// small-model chat default did not route (its reason OLD_CHAT_DEFAULT: that default is gone, so a chat it
// put on Luna never stays there by the return rule) – on a stuck task the newest run of the stalled
// model (RT1) – with that run's category.
// B-048 E4.2: a request may name a need (stronger, cheaper, faster, vision, long_context – routing/need.ts)
// instead of a model: it keeps the need, `from` (the model the agent ran on) and the model model.set
// named in its answer; the router resolves the need again on the turn (RouteRequest.previous.need).
// B-078 (D14/D16): a request may carry a temperature (0..2), kept like the effort (next step or task) and handed to the
// engine with the turn (temperatureOf → EngineTurnInput.temperature); engines without one ignore it.
// Never: bypasses the router – a request reaches it as the explicit previous choice and the
// router keeps policy, budget and availability bounds (routing/previous.ts).

import type { Db } from '../db/database.ts';
import type { RouteRequest } from '../contracts.ts';
import type { Effort } from '../../shared/model/providers.ts';
import { ROUTE_BY_REQUEST, type Run } from '../../shared/model/runs.ts';

const NS = 'next_route';
const TASK_NS = 'next_route_task';

type Previous = NonNullable<RouteRequest['previous']>;
type Need = NonNullable<Previous['need']>['kind'];

/** `need` + `from` (E4.2): a kind of model relative to the one the agent ran on; `modelId` is then the model model.set named.
 *  `temperature` (B-078): the sampling temperature 0..2, kept like the effort; engines that take one send it. */
export interface NextRoute { modelId?: string; effort?: Effort; reason?: string; at: number; need?: Need; from?: string; temperature?: number }

/** The temperature a turn's previous choice carries (returnChoice), else undefined (the router never reads it; the turn hands it to the engine). */
export function temperatureOf(previous: RouteRequest['previous']): number | undefined {
  const value = previous?.temperature;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `previous` with the request's temperature on it (a copy; unchanged without one). */
function withTemperature(previous: Previous | undefined, requested: NextRoute | undefined): Previous | undefined {
  const temperature = requested?.temperature;
  if (!previous || typeof temperature !== 'number') return previous;
  return { ...previous, temperature };
}

/** The route reason of a turn the removed B-044 chat default (an agent's plain conversation on Luna) chose. */
export const OLD_CHAT_DEFAULT = 'small model for conversation';

/** A done run of this chat the return rule may continue from (B-057: never a split's – its model is its part's). */
const returnable = (run: Run, conversationId: string | undefined) => !run.splitId && run.conversationId === conversationId && Boolean(run.model) && run.status === 'done'
  && run.route?.by !== ROUTE_BY_REQUEST && !run.route?.reason?.includes(OLD_CHAT_DEFAULT);

function key(agentId: string, conversationId: string | undefined): string {
  return `${agentId}:${conversationId ?? ''}`;
}

function put(db: Db, ns: string, k: string, value: NextRoute): void {
  db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [ns, k, JSON.stringify(value), value.at]);
}

function read(db: Db, ns: string, k: string): NextRoute | undefined {
  const row = db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [ns, k]);
  if (!row) return undefined;
  try { return JSON.parse(row.value) as NextRoute; } catch { return undefined; }
}

/** The request for the agent's next turn in this chat (one step). */
export function setNextRoute(db: Db, agentId: string, conversationId: string | undefined, value: NextRoute): void {
  put(db, NS, key(agentId, conversationId), value);
}

/** The request for every turn of the agent on `taskId` in this chat until the task is done (replaces an earlier one). */
export function setTaskRoute(db: Db, agentId: string, conversationId: string | undefined, taskId: string, value: NextRoute): void {
  put(db, TASK_NS, `${key(agentId, conversationId)}:${taskId}`, value);
}

/** Returns and deletes the pending next-step request (it applies to one turn only). */
export function takeNextRoute(db: Db, agentId: string, conversationId: string | undefined): NextRoute | undefined {
  const k = key(agentId, conversationId);
  const value = read(db, NS, k);
  db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [NS, k]);
  return value;
}

/**
 * The request in force for a turn: the next step's (consumed) over the task's, field by field;
 * the task requests of finished tasks (`finished`) in this chat are dropped first. `stalled` = on
 * a stuck task (RT1), the models of its stalled turns: a task request for one of them gives way
 * to the escalation on this turn (its row stays and holds again once the task makes progress).
 */
export function pendingRoute(db: Db, agentId: string, conversationId: string | undefined, taskId: string | undefined, finished: (taskId: string) => boolean, stalled: readonly string[] = []): NextRoute | undefined {
  const prefix = `${key(agentId, conversationId)}:`;
  const rows = db.all<{ key: string }>('SELECT key FROM kv WHERE ns = ? AND substr(key, 1, ?) = ?', [TASK_NS, prefix.length, prefix]);
  for (const row of rows) if (finished(row.key.slice(prefix.length))) db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [TASK_NS, row.key]);
  const step = takeNextRoute(db, agentId, conversationId);
  const held = taskId ? read(db, TASK_NS, `${prefix}${taskId}`) : undefined;
  const scoped = held?.modelId && stalled.includes(held.modelId) ? undefined : held;
  if (!step || !scoped) return step ?? scoped;
  // A next-step request that names a model or a need replaces the task's model choice as a whole (E4.2).
  const model = step.modelId || step.need ? { modelId: step.modelId, need: step.need, from: step.from } : { modelId: scoped.modelId, need: scoped.need, from: scoped.from };
  const merged: NextRoute = { ...model, effort: step.effort ?? scoped.effort, reason: step.reason ?? scoped.reason, temperature: step.temperature ?? scoped.temperature, at: step.at };
  for (const field of ['modelId', 'need', 'from', 'effort', 'reason', 'temperature'] as const) if (merged[field] === undefined) delete merged[field];
  return merged;
}

/**
 * RouteRequest.previous of a turn. `runs` = the agent's runs, newest first; `stalled` = on a stuck
 * task (RT1), its newest stalled model: that model's newest run there (done or failed) is the
 * base, so a kept stalled model is raised above the effort it stalled at. A request without a
 * model and without a run to return to keeps modelId '' (its effort still applies).
 */
export function returnChoice(runs: readonly Run[], conversationId: string | undefined, requested: NextRoute | undefined, stalled?: { taskId: string; modelId: string }): Previous | undefined {
  return withTemperature(choiceOf(runs, conversationId, requested, stalled), requested);
}

function choiceOf(runs: readonly Run[], conversationId: string | undefined, requested: NextRoute | undefined, stalled?: { taskId: string; modelId: string }): Previous | undefined {
  const stuck = stalled && runs.find((run) => !run.splitId && run.taskId === stalled.taskId && run.model === stalled.modelId && (run.status === 'done' || run.status === 'failed'));
  const last = stuck || runs.find((run) => returnable(run, conversationId));
  const category = last?.route?.category ? { category: last.route.category } : {};
  const base: Previous | undefined = last?.model ? { modelId: last.model, effort: last.effort ?? 'medium', ...category } : undefined;
  if (requested?.need) {
    // E4.2: the router resolves the need relative to `from`; modelId = the model model.set named (else `from`).
    const need = { kind: requested.need, ...(requested.from ? { from: requested.from } : {}) };
    const modelId = requested.modelId ?? requested.from ?? base?.modelId ?? '';
    return requested.effort
      ? { modelId, effort: requested.effort, explicit: true, need }
      : { modelId, effort: base?.effort ?? 'medium', explicit: true, asked: 'model', need, ...category };
  }
  if (requested?.modelId && requested.effort) return { modelId: requested.modelId, effort: requested.effort, explicit: true };
  if (requested?.modelId) return { modelId: requested.modelId, effort: base?.effort ?? 'medium', explicit: true, asked: 'model', ...category };
  if (requested?.effort) return { modelId: base?.modelId ?? '', effort: requested.effort, explicit: true, asked: 'effort', ...category };
  return base;
}
