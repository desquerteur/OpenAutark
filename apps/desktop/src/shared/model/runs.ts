// Run model: what agents actually did (turns, tool calls, effects). Used for the agent
// insight view, audit, cost accounting, recovery and routing outcome statistics.
// B-054: a run is started by an origin (shared/model/origin.ts); it has a chat only when its origin is one.
// Owns: shapes only. Never: invents inner thoughts – only provider-visible summaries.

import type { Effort, EngineId } from './providers.ts';
import type { Origin } from './origin.ts';

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'unknown';

export type WakeReason =
  | 'message' // new message for the agent
  | 'task' // task assigned/claimable/news
  | 'schedule' // reminder/routine fired
  | 'answer' // human answered a widget/approval
  | 'approval' // approval decided (runs before the permission gate was removed)
  | 'handoff' // received a handoff
  | 'child' // a delegated agent finished
  | 'retry' // ownership loop retry
  | 'review' // manager review / heartbeat
  | 'manual'
  | 'report' // addition (T08): a manager's bundled report of its reports' finished work (org/reports.ts)
  | 'setup' // B-044: old runs only; since B-066 the first run ends with an ordinary 'message' (onboarding/service.ts)
  | 'event' // B-054: something outside happened (a new mail, a connector or webhook push) – the origin says what
  | 'split'; // B-057: the run of a split (shared/model/splits.ts) – never a queued wake

export interface Run {
  id: string;
  agentId: string;
  conversationId?: string;
  taskId?: string;
  trigger: WakeReason;
  engine?: EngineId;
  model?: string;
  effort?: Effort;
  accountId?: string;
  deviceId?: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  summary?: string; // one line ("edited timeline, rendered preview")
  route?: { reason: string; by: string; category: string };
  origin?: Origin; // B-054: what started it (runs.source/source_label); absent on chat and task runs without one
  splitId?: string; // B-057: the split this run worked for (runs.split_id, shared/model/splits.ts); absent on every other run
}

export type RunItemKind = 'tool_call' | 'tool_result' | 'reasoning' | 'plan' | 'effect' | 'approval' | 'note' | 'error';

export interface RunItem {
  id: string;
  runId: string;
  seq: number;
  kind: RunItemKind;
  name?: string; // tool name
  data: Record<string, unknown>; // truncated; big outputs are blob refs
  effectStatus?: 'none' | 'pending' | 'confirmed' | 'unknown' | 'failed';
  idemKey?: string;
  createdAt: number;
}

/** Live activity shown in group headers and the agent row ("who is working"). */
export interface AgentActivity {
  agentId: string;
  runId: string;
  conversationId?: string;
  taskId?: string;
  note: string; // short live status line
  startedAt: number;
  // B-048 E4.5 (ACTIVITY-UI): what the run runs on right now – set at route time and again after a
  // failover or a session renewal/rebuild (agents/turn.ts bindTurn → dispatch-runs.ts), absent while routing.
  model?: string; // catalog model id (RouteDecision.modelId)
  modelName?: string; // display name
  effort?: Effort;
  engine?: EngineId;
  origin?: Origin; // B-054: what started the run (the agent page shows its label when there is no task)
  /** B-057: set when the run is a split's (its lane `<agentId>#<splitId>`); the agent's main turn has none. */
  split?: { id: string; groupId: string; idx: number; of: number; parentRunId: string; title: string };
  /** Tool calls waiting for their output right now (absent: none) – the subconscious never wakes then (subconscious/wake.ts). */
  toolCalls?: number;
}

/** Addition (RT2): `Run.route.by` of a turn that the agent's own model.set request shaped (its
 * model or effort). The return rule skips such runs, so a request holds for one step – or for
 * the turns of its task until the task is done – and routing then returns to the choice before. */
export const ROUTE_BY_REQUEST = 'request';

/**
 * Addition (PR9, runtime/models/pricing.ts): how a run's cost was judged. Only pay-per-use
 * connections (API key, env key, a Claude Code/Codex API-key login) cost real money – their
 * `costUsd` is booked as the agent's spend: 'provider' = the provider or engine reported it
 * (OpenRouter usage.cost, Claude Code's total_cost_usd), 'list-price' = tokens × Artificial
 * Analysis list prices, 'prior-price' = tokens × the curated price in model-priors.json,
 * 'unpriced' = no price is known (amount 0 – a price is never invented). 'plan' = a subscription
 * plan: no charge, `notionalUsd` = what the turn would have cost at list price ("plan, no
 * charge"); 'free' = a local runtime or a server without a key.
 */
export type CostBasis = 'provider' | 'list-price' | 'prior-price' | 'unpriced' | 'plan' | 'free';

/** Addition (PR9): merged into Run above – the cost basis and the plan's notional list-price cost. */
export interface Run {
  costBasis?: CostBasis;
  notionalUsd?: number;
}
