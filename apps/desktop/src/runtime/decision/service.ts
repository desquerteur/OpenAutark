// DecisionService: typed choice / score / predicate answers with confidence from the first backend that answers – a
// connection on the decision protocol (systemone.ts), else a connected model with structured output (llm-fallback.ts over
// engine-runner.ts): the Decisions use of settings.json (routing.decision; "auto" = a cheap one, routing/helper-default.ts);
// with none connected, every answer is "no answer" and callers use their own rules.
// Owns: redaction of the request, option validation (unknown choice → no answer), the always-offered "none" option,
// the request's deadline (timeoutMs) and its caller's stop (signal), and what a choice answer means (outcome).
// Never: throws for "no backend" (returns confidence 0, by 'none') or sends secret values.

import type { DecisionOutcome, DecisionRequest, DecisionResult, DecisionService, Logger } from '../contracts.ts';
import { NONE_OPTION, type DecisionBackend } from './types.ts';

const MAX_CONTEXT_CHARS = 12_000;
/** From this confidence on a choice is 'choice' and a picked "none" is 'none_fit'; below it 'unsure'. */
export const SURE_CONFIDENCE = 0.55;

export interface DecisionHubOptions {
  /** Tried in order; the first available one answers, the next when it fails. */
  backends: DecisionBackend[];
  redact?: (text: string) => string;
  log?: Logger;
  /** Per attempt of a request without its own deadline (default 30 s). */
  timeoutMs?: number;
}

const NO_ANSWER: DecisionResult = { confidence: 0, by: 'none' };
/** No answer within the request's timeoutMs (the running call was aborted). */
const TIMED_OUT: DecisionResult = { confidence: 0, by: 'timeout' };
/** The caller stopped the request (its signal); a late answer is not used. */
const STOPPED: DecisionResult = { confidence: 0, by: 'stopped' };

export class DecisionHub implements DecisionService {
  private readonly options: DecisionHubOptions;

  constructor(options: DecisionHubOptions) {
    this.options = options;
  }

  available(): boolean {
    return this.options.backends.some((backend) => backend.available());
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const deadline = deadlineOf(request.timeoutMs, request.signal);
    try {
      const answered = await this.answer(request, deadline.signal);
      const result = request.signal?.aborted ? STOPPED : answered;
      // A choice nobody answered (no backend, timeout, stop, no options) is 'unsure'.
      return request.type === 'choice' && !result.outcome ? { ...result, outcome: 'unsure' } : result;
    } finally {
      deadline.clear();
    }
  }

  private async answer(request: DecisionRequest, deadline?: AbortSignal): Promise<DecisionResult> {
    const redact = this.options.redact ?? ((text: string) => text);
    const clean: DecisionRequest = {
      ...request,
      question: redact(request.question),
      context: request.context === undefined ? undefined : redact(request.context).slice(0, MAX_CONTEXT_CHARS),
      options: request.options?.map((option) => redact(option)),
    };
    if (clean.type !== 'choice') return this.single(clean, [], deadline);
    const options = [...new Set((clean.options ?? []).map((option) => option.trim()).filter(Boolean))];
    if (!options.length) return NO_ANSWER;
    return this.single({ ...clean, options: options.includes(NONE_OPTION) ? options : [...options, NONE_OPTION] }, request.options ?? [], deadline);
  }

  private async single(request: DecisionRequest, original: string[], deadline?: AbortSignal): Promise<DecisionResult> {
    const startedAt = performance.now();
    for (const backend of this.options.backends) {
      if (deadline?.aborted) return TIMED_OUT;
      if (!backend.available()) continue;
      try {
        // A request with its own deadline has that time (a tool timeout review on a CLI that took 35 s to start aborted the running command after 30 s, q2m live 02.11.2026).
        const attempt = AbortSignal.timeout(request.timeoutMs ?? this.options.timeoutMs ?? 30_000);
        const signal = deadline ? AbortSignal.any([attempt, deadline]) : attempt;
        const left = request.timeoutMs === undefined ? request : { ...request, timeoutMs: Math.max(1, Math.round(request.timeoutMs - (performance.now() - startedAt))) };
        return this.validate(await untilAborted(backend.decide(left, signal), deadline), request, original);
      } catch (error) {
        if (deadline?.aborted) return TIMED_OUT;
        this.options.log?.warn('decision backend failed', { backend: backend.id, purpose: request.purpose, error: String(error) });
      }
    }
    return NO_ANSWER;
  }

  private validate(raw: DecisionResult, request: DecisionRequest, original: string[]): DecisionResult {
    const confidence = Math.max(0, Math.min(1, Number.isFinite(raw.confidence) ? raw.confidence : 0));
    if (request.type === 'choice') {
      const options = request.options ?? [];
      const picked = raw.choice?.trim();
      const index = picked === undefined ? -1 : options.findIndex((option) => option.toLowerCase() === picked.toLowerCase());
      if (index < 0) return { confidence: 0, by: raw.by, outcome: 'unsure' }; // unknown option = no answer
      if (options[index] === NONE_OPTION && !original.includes(NONE_OPTION)) return { confidence, by: raw.by, outcome: sure(confidence, 'none_fit') };
      // Map back to the caller's original (un-redacted, un-trimmed) option text.
      const choice = original.find((option) => option.trim().toLowerCase() === options[index].toLowerCase()) ?? options[index];
      return { choice, confidence, by: raw.by, outcome: sure(confidence, 'choice') };
    }
    if (request.type === 'predicate') return typeof raw.value === 'boolean' ? { value: raw.value, confidence, by: raw.by } : { confidence: 0, by: raw.by };
    return typeof raw.score === 'number' && Number.isFinite(raw.score) ? { score: raw.score, confidence, by: raw.by } : { confidence: 0, by: raw.by };
  }
}

/** `outcome` when the confidence reaches SURE_CONFIDENCE, else 'unsure'. */
function sure(confidence: number, outcome: Exclude<DecisionOutcome, 'unsure'>): DecisionOutcome {
  return confidence >= SURE_CONFIDENCE ? outcome : 'unsure';
}

/** What a choice answer means – the hub's own `outcome`, derived the same way for a service without it. */
export function outcomeOf(result: DecisionResult): DecisionOutcome {
  return result.outcome ?? (result.choice !== undefined ? sure(result.confidence, 'choice') : 'unsure');
}

/** The request's own deadline (timeoutMs) joined by its caller's stop – none without either; `clear` ends the timer. */
function deadlineOf(timeoutMs: number | undefined, stop: AbortSignal | undefined): { signal?: AbortSignal; clear: () => void } {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal: stop, clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`decision timed out after ${timeoutMs} ms`)), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return { signal: stop ? AbortSignal.any([controller.signal, stop]) : controller.signal, clear: () => clearTimeout(timer) };
}

/** The backend's answer, or a rejection as soon as the deadline passes (a backend that ignores its signal cannot hold the request). */
function untilAborted<T>(work: Promise<T>, deadline: AbortSignal | undefined): Promise<T> {
  if (!deadline) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(deadline.reason);
    if (deadline.aborted) return stop();
    deadline.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => deadline.removeEventListener('abort', stop));
  });
}
