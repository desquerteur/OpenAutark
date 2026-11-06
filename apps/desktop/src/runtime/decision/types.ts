// Decision backend contract and the structured-LLM runner shape shared by the decision backend,
// verification and compaction.
// Owns: shapes. Never: backend selection (service.ts) or engine details (engine-runner.ts).

import type { DecisionRequest, DecisionResult } from '../contracts.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { CacheTokens } from '../engines/types.ts';

export interface DecisionBackend {
  readonly id: string;
  /** Can answer now. Must be cheap (no network). */
  available(): boolean;
  /** Raw answer; the service validates options and clamps confidence. */
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

/**
 * One cheap, clean-context LLM call with optional JSON schema (structured output).
 * Implemented over EngineRegistry + Router by `engine-runner.ts`; injected everywhere so tests
 * and headless setups can replace it.
 */
export type StructuredRunner = (input: {
  purpose: string; // 'decision' | 'verify' | 'compact' | …
  system: string;
  prompt: string;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
  /** SG: a higher effort than the helper default (e.g. 'medium' after an unsure low-effort answer). */
  effort?: Effort;
  /** The caller's time budget: the call ends when it passes. */
  deadlineMs?: number;
  /** B-078 D14: sampling temperature (0–2) – low for picking and searching, higher for writing; honoured only where the engine takes one, the rest ignore it. */
  temperature?: number;
}) => Promise<{ text: string; structured?: unknown; by: string; effort?: Effort; efforts?: readonly Effort[]; usage?: { inputTokens: number; outputTokens: number } & CacheTokens }>; // usage: what the call used, when the engine says (inputTokens all input, the cached part beside it); SG: effort = what the call ran at, efforts = what its model supports (empty: unknown)

/** Token used by choice requests for "none of the options fits" (always offered). */
export const NONE_OPTION = 'none';

/** Max options one decide tool call may offer. */
export const MAX_OPTIONS = 255;
