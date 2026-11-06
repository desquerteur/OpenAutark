// Splits (B-057 "Ultra mode", owner 29.10.2026 – an agent splits itself up):
// a persistent agent splits ITSELF into short-lived workers ("splits") that run in parallel under its own identity, each
// with one part of the work; their results come back to the main agent, which merges them. A group is one
// `agents.split` call (parts #1 … #N); a split is one part. Splits are no agents and no tasks: they run under the
// parent's agentId (runs.split_id names them), on their own native session thread `split:<splitId>`, never in a chat.
// Splitting is the agent's own free choice (owner 30.10.2026: "nur eine Möglichkeit, die die KI nutzen kann"); the person
// may suggest Ultra on one message (MessageMeta.ultra, the composer's Ultra cell) – a hint for that message, never a rule.
// Owns: the split, group and view shapes, the limits, the split thread key and the split.upserted event shape.
// Never: behaviour (runtime/splits/**), a second identity – a split is always its parent agent.

import type { Effort, EngineId } from './providers.ts';
import type { Run } from './runs.ts';
import type { Origin } from './origin.ts';

/** How a part starts: 'fork' – as the parent with the context it had at the split (native fork, ledger rebuild or
 *  text fallback); 'brief' – a fresh session with only its brief (cheapest; independent checks, judges, searches). */
export type SplitContext = 'fork' | 'brief';
export type SplitStatus = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
export type SplitGroupStatus = 'pending' | 'running' | 'settled' | 'gathered' | 'stopped';
export const SPLIT_TERMINAL: readonly SplitStatus[] = ['done', 'failed', 'stopped', 'skipped'];
export const SPLIT_LIMITS = { partsPerCall: 12, activeGroupsPerAgent: 3, runningPerAgent: 4, attempts: 2,
  resultChars: 24_000, briefChars: 4_000, titleChars: 80, goalChars: 400, returnsChars: 400 } as const;

/** One part as the agent asks for it (agents.split input). */
export interface SplitPartInput { title: string; brief: string; returns?: string; context?: SplitContext;
  model?: string; effort?: Effort; after?: number[]; worktree?: boolean }

/** How a split's session was seeded (set at its first start). */
export interface SplitFork { how: 'native' | 'ledger' | 'text' | 'fresh'; engine?: EngineId; accountId?: string; parentRef?: string }

/** `ultra`: the person had suggested Ultra on their latest message in the chat when the agent split (MessageMeta.ultra). */
export interface SplitGroup { id: string; agentId: string; parentRunId: string; conversationId?: string; taskId?: string;
  origin?: Origin; thread: string; modeKey?: string; cwd?: string; goal: string; ultra: boolean; status: SplitGroupStatus;
  parts: number; createdAt: number; startedAt?: number; endedAt?: number; gatheredAt?: number }

export interface Split { id: string; groupId: string; agentId: string; idx: number /* 1-based */; of: number;
  title: string; brief: string; returns?: string; context: SplitContext; model?: string; effort?: Effort; after: number[];
  worktree: boolean; status: SplitStatus; attempts: number; error?: string; fork?: SplitFork;
  branch?: { name: string; stat?: string; merged?: 'merged' | 'discarded' | 'conflict' };
  createdAt: number; startedAt?: number; endedAt?: number }

export type SplitRunView = Pick<Run, 'id' | 'model' | 'effort' | 'engine' | 'status' | 'costUsd' | 'notionalUsd' | 'costBasis'
  | 'summary' | 'error' | 'startedAt' | 'endedAt' | 'inputTokens' | 'outputTokens'>;
/** A split with its newest run (`run`) and how many runs it had (`runs`; a retry is a second run). */
export interface SplitView extends Split { run?: SplitRunView; runs: number }
/** A group with its splits in idx order and the summed cost of their runs. */
export interface SplitGroupView extends SplitGroup { splits: SplitView[]; costUsd?: number; notionalUsd?: number }

/** What a split turn carries (TurnRequest.split / TurnPlan.split / ToolContext.split). */
export interface SplitTurn { splitId: string; groupId: string; idx: number; of: number; title: string; parentRunId: string;
  parentThread: string; parentConversationId?: string; parentTaskId?: string; context: SplitContext; modeKey?: string;
  cwd?: string; model?: string; effort?: Effort; firstTurn: boolean }

/** The native session thread of a split (never the parent's chat or task thread). */
export function splitThread(splitId: string): string { return `split:${splitId}`; }
export function isSplitThread(thread: string): boolean { return thread.startsWith('split:'); }

declare module './chat.ts' {
  interface MessageMeta {
    /** B-057 (owner 30.10.2026): the person suggested Ultra for this message – splitting it may suit it; the agent decides. */
    ultra?: true;
  }
  interface SendMessageInput {
    /** B-057: the composer's Ultra cell for this one message – stored as meta.ultra on the person's message. */
    ultra?: boolean;
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** B-057: a split group or one of its splits changed (topic runs:<agentId>, like run.upserted). */
    'split.upserted': SplitGroupView;
  }
}
