// LLM fallback decision backend: a cheap engine with structured output answers the same typed
// question when no decision model is configured ("rules first, decision second, LLM third").
// SG: an answer from a low-effort helper call (routing/helper-default.ts starts decisions at low)
// that is unsure (confidence below ESCALATE_BELOW) or unreadable is asked once more at medium –
// "low by default, medium when needed"; the better of the two answers counts. Only when the model
// that answered can run above that effort (medium clamped to its efforts differs from the one
// that ran): otherwise the retry would be the same call again at twice the time and quota.
// A request's deadline (timeoutMs) goes to the runner as its time budget (what is left of it for the retry).
// Owns: the decision prompt + JSON schema per type, answer parsing and that one escalation.
// Never: free-form text answers; it returns only what the schema allows; never a third call.

import type { DecisionRequest, DecisionResult } from '../contracts.ts';
import type { DecisionBackend, StructuredRunner } from './types.ts';
import { clampEffort } from '../models/efforts.ts';

/** Below this confidence a low-effort answer is asked again at medium (service.ts SURE_CONFIDENCE). */
export const ESCALATE_BELOW = 0.55;
const LOW: ReadonlySet<string> = new Set(['none', 'low']);

const SYSTEM = [
  'I am a decision function inside an agent runtime.',
  'I answer the question from the given context alone. My reply is JSON that matches the schema, nothing else.',
  '"confidence" is my probability (0..1) that the answer is right.',
  'For choices, I pick "none" when no option fits or I cannot judge it.',
].join('\n');

export function schemaFor(request: DecisionRequest): Record<string, unknown> {
  const confidence = { type: 'number', minimum: 0, maximum: 1 };
  if (request.type === 'choice') {
    return { type: 'object', additionalProperties: false, required: ['choice', 'confidence'],
      properties: { choice: { type: 'string', enum: request.options ?? [] }, confidence } };
  }
  if (request.type === 'predicate') {
    return { type: 'object', additionalProperties: false, required: ['value', 'confidence'], properties: { value: { type: 'boolean' }, confidence } };
  }
  return { type: 'object', additionalProperties: false, required: ['score', 'confidence'],
    properties: { score: { type: 'number', minimum: 0, maximum: 1 }, confidence } };
}

function parse(result: { text: string; structured?: unknown }): Record<string, unknown> | undefined {
  if (result.structured && typeof result.structured === 'object') return result.structured as Record<string, unknown>;
  const match = /\{[\s\S]*\}/.exec(result.text);
  if (!match) return undefined;
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return undefined; }
}

export class LlmDecisionBackend implements DecisionBackend {
  readonly id = 'llm' as const;
  private run: StructuredRunner;
  private enabled: () => boolean;
  private now: () => number;

  constructor(run: StructuredRunner, enabled: () => boolean = () => true, now: () => number = Date.now) {
    this.run = run;
    this.enabled = enabled;
    this.now = now;
  }

  available(): boolean {
    return this.enabled();
  }

  async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
    const lines = [`Question: ${request.question}`];
    if (request.options?.length) lines.push('Options:', ...request.options.map(option => `- ${option}`));
    if (request.context) lines.push('', 'Context:', request.context);
    if (request.type === 'score') lines.push('', '"score" is between 0 and 1.');
    const started = this.now();
    const budget = request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
    const deadline = () => (budget === undefined ? {} : { deadlineMs: Math.max(0, budget - (this.now() - started)) });
    const ask = (effort?: 'medium') => this.run({ purpose: 'decision', system: SYSTEM, prompt: lines.join('\n'), schema: schemaFor(request), signal, ...(effort ? { effort } : {}), ...deadline() });
    const sureness = (value: Record<string, unknown> | undefined) => (typeof value?.confidence === 'number' ? value.confidence : value ? 0.5 : 0);
    let result = await ask();
    let answer = parse(result);
    const raisable = result.effort !== undefined && LOW.has(result.effort) && clampEffort('medium', result.efforts ?? []) !== result.effort;
    if (sureness(answer) < ESCALATE_BELOW && raisable && !signal.aborted) {
      const again = await ask('medium').catch(() => undefined);
      const better = again && parse(again);
      if (again && better && sureness(better) >= sureness(answer)) { result = again; answer = better; }
    }
    const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0.5;
    const by = `llm:${result.by}`;
    if (!answer) return { confidence: 0, by };
    if (request.type === 'choice') return { choice: typeof answer.choice === 'string' ? answer.choice : undefined, confidence, by };
    if (request.type === 'predicate') return typeof answer.value === 'boolean' ? { value: answer.value, confidence, by } : { confidence: 0, by };
    return typeof answer.score === 'number' ? { score: answer.score, confidence, by } : { confidence: 0, by };
  }
}
