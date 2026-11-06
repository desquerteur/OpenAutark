// Shared shapes of one agent turn (dispatcher ↔ turn executor ↔ its phases).
// B-054: a turn carries its wakes' origin (TurnRequest.origin) and its thread (TurnPlan.thread, threadKey in
// shared/model/origin.ts) – native sessions and turn state are keyed by the thread: the chat id, `task:<id>` or `src:<source>`.
// Owns: request/plan/attempt/outcome types, plus `effectful` – whether a tool call did something (the ownership loop's
// progress signal, tasks/ownership.ts).
// Never: other behaviour.

import type { CacheTokens, Engine, EngineTurnResult } from '../engines/types.ts';
import type { PromptParts, RouteRequest } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { AnswerVisibility } from '../../shared/model/chat.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { Account, RouteDecision } from '../../shared/model/providers.ts';
import type { AgentActivity, RunStatus, WakeReason } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { SplitTurn } from '../../shared/model/splits.ts'; // B-057
import type { SubconsciousTrace } from '../../shared/model/subconscious.ts';
import type { ActionCategory, ToolSpec } from '../tools/types.ts';
import type { SessionBinding } from './sessions.ts';
import type { SentSections } from './volatile-delta.ts';

/** One tool call of a turn: our tools with their category, engine-native ones by name. */
export interface ToolUse {
  name: string;
  /** Category of one of our tools; undefined for engine-native tools (judged by name). */
  category?: ActionCategory;
  native: boolean;
  /** False when the call failed or was refused; undefined while unknown. */
  ok?: boolean;
}

/** Engine-native tools that only look (Claude/Codex/ACP agent names). */
const LOOKS = /^(read|view|grep|glob|ls|list|search|find|web_?search|web_?fetch|fetch|todo_?read|notebook_?read)$/i;

/** True when the call did something (it can change something, or it is task work) and did not fail. */
export function effectful(use: ToolUse): boolean {
  if (use.ok === false) return false;
  if (use.native) return !LOOKS.test(use.name.replace(/^mcp__\w+__/, ''));
  return use.category !== 'read' && (use.category !== 'think' || /^(tasks|schedules|agents|human)\./.test(use.name));
}

/** Live handles the dispatcher uses while a turn runs (steer, cursor bookkeeping). */
export interface TurnControl {
  engine?: Engine;
  /** Highest message seq included in this turn's input. */
  lastSeq: number;
  /** Highest seq steered into the running turn (advanced together with lastSeq). */
  steeredSeq: number;
  /** Why the dispatcher aborted the turn (the first abort decides): the human pressed Stop or
   *  Cancel, an important message took over, or the runtime shuts down. */
  stopKind?: StopKind;
}

export type StopKind = 'human' | 'urgent' | 'shutdown';

export interface TurnRequest {
  runId: string;
  agentId: string;
  conversationId?: string;
  taskId?: string;
  reason: WakeReason;
  /** B-054: what started the run (the wake group's origin: a mail, a schedule, task news …); absent on plain chat and task wakes. */
  origin?: Origin;
  /** B-054 fix: the note of the outside event that origin came from (WakeGroup.originNote). */
  originNote?: string;
  notes: Array<{ text: string; at: number; reason?: WakeReason }>;
  /** An earlier attempt in this same run failed; the next input can explain its retry. */
  interruption?: { at: number; reason: string };
  signal: AbortSignal;
  control: TurnControl;
  /** Admission for heavy turns (engine processes); resolves with a release function. */
  admit?(signal: AbortSignal): Promise<() => void>;
  /** Short live status ("running tests"). */
  onStatus?(note: string): void;
  /** A tool call (ours or engine-native) started (true) or ended (false) – the turn's tool boundaries (dispatch-boundary.ts). */
  onTool?(callId: string, running: boolean): void;
  /** B-048 E4.5: what the turn runs on – at route time and again after a renewal, rebuild or failover (turn.ts bindTurn). */
  onRoute?(route: TurnRoute): void;
  /** B-057: set on a split's turn (reason 'split', its lane – no conversationId, no taskId; thread `split:<id>`). */
  split?: SplitTurn;
}

/** B-048 E4.5: the route fields of AgentActivity (catalog model id, display name, effort, engine). */
export type TurnRoute = Required<Pick<AgentActivity, 'model' | 'modelName' | 'effort' | 'engine'>>;

export interface TurnPlan {
  agent: Agent;
  mode: ModeInfo;
  task?: TaskView;
  conversationId?: string;
  /** B-054: what started the run (TurnRequest.origin). */
  origin?: Origin;
  /** B-054: threadKey of the turn (chat id, else `task:<id>`, else `src:<source>`, else '') – the key of its session and turn state. */
  thread: string;
  memberCursor: number;
  /** Reply to a spoken call line; typed messages and task turns stay in the chat. */
  callId?: string;
  focus: string;
  /** What the subconscious shows this turn, as real tool calls in the main AI's history (subconscious/service.ts beforeTurn). */
  trace?: SubconsciousTrace;
  /** Model/effort to return to; `explicit` when the agent itself asked for it (model.set), `asked`/`category` as in RouteRequest (RT2). */
  previous?: RouteRequest['previous'];
  needsVision: boolean;
  /** No connected model can read images: the turn runs without them and the agent is told. */
  imagesHidden?: boolean;
  /** B-047 D4 (agents/publishing.ts): a person waits for this turn's answer (a new line of theirs, an awaited wake, a call). */
  awaited: boolean;
  /** Who waits (the newest person's line's author, else 'human' for an awaited wake or a call). */
  waitingFor?: string;
  /** Where an untagged final text would go as planned (the finish re-judges with what the turn did); not 'internal' = a streaming placeholder. */
  publish: AnswerVisibility;
  /** B-057: the split this turn works for (TurnRequest.split); its finish stays internal. */
  split?: SplitTurn;
}

export interface RoutedTurn {
  route: RouteDecision;
  engine: Engine;
  account: Account;
  model: string; // provider model id
  modelName: string; // display name for meta/status lines
  contextWindow?: number;
  session?: SessionBinding;
  prompt: PromptParts;
  /** Our tools passed natively to the engine (buildTurn: the same offer the prompt key covers). */
  tools?: ToolSpec[];
  /** sha256 of the stable prompt + sorted offered tool names; saved with the session (SES2). */
  promptKey?: string;
  input: Array<{ type: 'text'; text: string } | { type: 'image'; path: string; mime: string }>;
  lastSeq: number;
  /** B-049 F6: the volatile sections the session holds once this turn finishes (turn-finish records them; volatile-delta.ts). */
  volatileSent?: SentSections;
  /** B-057 S6: the split groups whose "Split results" block is in this turn's input (gathered when it ends 'done'). */
  splitGroups?: string[];
  /** The subconscious's calls for this turn (TurnPlan.trace), handed to the engine (EngineTurnInput.trace). */
  trace?: SubconsciousTrace;
}

export interface AttemptResult {
  result: EngineTurnResult;
  streamed: string;
  reasoning: string;
  toolCalls: number;
  /** What ran (our tools with their category, engine-native by name) – the progress signal. */
  tools?: ToolUse[];
  /** The engine's latest plan ('plan' events), for ledger.plan. */
  plan?: string[];
  /** How many steps of that plan are done. */
  planDone?: number;
  /** inputTokens: all input; the cached part beside it as the engine's result reported it (CacheTokens). */
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; contextTokens?: number } & CacheTokens;
  /** After a failover (mergeAttempts) `usage` sums both attempts (run, budget); this is the final
   *  attempt's own usage – the model outcome's cost, like `ms`, is per attempt. */
  lastUsage?: AttemptResult['usage'];
  ms: number;
}

export interface TurnOutcome {
  runId: string;
  status: RunStatus | 'skipped';
  messageId?: string;
  error?: string;
}
