// AF-013: the approval requests that wait for the person. ask() publishes 'access.requested' and waits for
// answer() (the dialog's Allow once / Always for this agent / Deny), the turn's stop (signal) or the time limit; each
// end publishes 'access.resolved'. The same request asked again while it waits (an engine's retry) gets the same answer.
// Owns: the pending list, the waiting and the time limit. Never: judges, stores rules or decides on its own.

import type { AccessAnswer, AccessRequest } from '../../shared/model/access.ts';

/** An unanswered request ends after this (the step does not run). */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const MAX_PENDING = 100;

export type ApprovalOutcome = AccessAnswer | 'cancelled';

export interface ApprovalDeps {
  emit(event: 'access.requested', data: AccessRequest): void;
  emit(event: 'access.resolved', data: { id: string; answer: ApprovalOutcome }): void;
  now: () => number;
  id: () => string;
  timeoutMs?: number;
}

interface Waiting { request: AccessRequest; done: Promise<ApprovalOutcome>; resolve: (answer: ApprovalOutcome) => void }

export class ApprovalBroker {
  private readonly deps: ApprovalDeps;
  private readonly waiting = new Map<string, Waiting>();

  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  /** Waits for the person's answer; 'cancelled' when the turn stops, the time runs out or too many wait. */
  ask(request: Omit<AccessRequest, 'id' | 'at'>, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (signal?.aborted) return Promise.resolve('cancelled');
    const same = [...this.waiting.values()].find((entry) => entry.request.agentId === request.agentId && entry.request.runId === request.runId && entry.request.summary === request.summary);
    if (same) return same.done;
    if (this.waiting.size >= MAX_PENDING) return Promise.resolve('cancelled');
    const full: AccessRequest = { ...request, id: this.deps.id(), at: this.deps.now() };
    let resolve!: (answer: ApprovalOutcome) => void;
    const done = new Promise<ApprovalOutcome>((settle) => { resolve = settle; });
    const timer = setTimeout(() => this.finish(full.id, 'cancelled'), this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => this.finish(full.id, 'cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    this.waiting.set(full.id, {
      request: full, done,
      resolve: (answer) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(answer); },
    });
    this.deps.emit('access.requested', full);
    return done;
  }

  /** The person's answer; false when the request is no longer waiting. */
  answer(id: string, answer: AccessAnswer): boolean {
    return this.finish(id, answer);
  }

  /** The waiting requests, oldest first. */
  list(): AccessRequest[] {
    return [...this.waiting.values()].map((entry) => entry.request).sort((a, b) => a.at - b.at);
  }

  get(id: string): AccessRequest | undefined {
    return this.waiting.get(id)?.request;
  }

  private finish(id: string, answer: ApprovalOutcome): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    this.waiting.delete(id);
    entry.resolve(answer);
    this.deps.emit('access.resolved', { id, answer });
    return true;
  }
}
