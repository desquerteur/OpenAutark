// The page side of joining with an invite (pwa/join.ts – an employee's phone or browser): one long
// request at a time and only while the page is visible, the next one after an open answer, the token
// handed to `paired` once, declined/expired states, a reload resuming the stored ticket, retries after
// a failed request and never a spin on an early 'pending'.
// Owns: the waiting state and its loop (createAccessFlow takes its environment, so it is unit-tested
// without a browser). Never: polls on a timer, logs or shows the ticket or token, or runs on the desktop.

import { signal } from '@preact/signals';
import type { AccessTicket, AccessWait } from '../../shared/api/methods.ts';
import { RpcError, errorText } from '../lib/rpc.ts';

export type AccessState =
  | { step: 'idle' }
  | { step: 'asking' }
  | { step: 'waiting'; code: string; expiresAt: number; proven?: boolean }
  | { step: 'accepted'; access: 'full' | 'todo' }
  | { step: 'denied'; reason?: string }
  | { step: 'expired' }
  | { step: 'failed'; message: string };

/** What the flow needs from the page (the browser's in `pageAccess`, fakes in tests). */
export interface AccessEnv {
  request(name: string, proof?: AccessProof): Promise<AccessTicket>;
  wait(ticket: string, signal: AbortSignal): Promise<AccessWait>;
  name(): string;
  now(): number;
  visible(): boolean;
  /** Calls `change` on every visibility change; returns the unsubscribe. */
  watchVisibility(change: () => void): () => void;
  /** This tab's stored request (sessionStorage). */
  load(): string | null;
  save(value: string | null): void;
  /** Stores the token and opens the app paired (reload on the same route). */
  paired(token: string): void;
  /** One-shot retry after a failed request; returns the cancel. */
  later(fn: () => void, ms: number): () => void;
  /** The ticket of an invite address this page was opened with (taken out of the URL), once. */
  takeTicket?(): string | undefined;
}

/** What proves the device was invited: the invite's ticket or its typed code. */
export type AccessProof = { ticket: string } | { code: string };

const RETRY_MS = 3000;
/** Failed requests in a row before the page stops trying (the PC is away). */
const MAX_FAILURES = 5;
/** The PC decides when a request ends; this tab only drops a stored one that is clearly stale (clock skew). */
const STALE_MS = 10 * 60_000;

function parseTicket(raw: string | null): AccessTicket | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AccessTicket>;
    return typeof value.ticket === 'string' && typeof value.code === 'string' && typeof value.expiresAt === 'number' && typeof value.id === 'string' ? value as AccessTicket : null;
  } catch {
    return null;
  }
}

export function createAccessFlow(env: AccessEnv) {
  const state = signal<AccessState>({ step: 'idle' });
  let current: AccessTicket | null = null;
  let inflight: AbortController | null = null;
  let cancelRetry: (() => void) | null = null;
  let unwatch: (() => void) | null = null;
  let failures = 0;

  const end = (next: AccessState) => {
    current = null;
    env.save(null);
    inflight?.abort();
    inflight = null;
    cancelRetry?.();
    cancelRetry = null;
    unwatch?.();
    unwatch = null;
    state.value = next;
  };

  const step = async (): Promise<void> => {
    const ticket = current;
    if (!ticket || inflight || cancelRetry || !env.visible()) return;
    const controller = new AbortController();
    inflight = controller;
    const started = env.now();
    let outcome: AccessWait;
    try {
      outcome = await env.wait(ticket.ticket, controller.signal);
    } catch (error) {
      if (inflight === controller) inflight = null;
      if (controller.signal.aborted || current !== ticket) return; // hidden: sent again when visible
      if (++failures >= MAX_FAILURES) { end({ step: 'failed', message: 'This PC cannot be reached right now.' }); return; }
      const delay = error instanceof RpcError && error.data.retryAfterMs ? Math.min(error.data.retryAfterMs, 60_000) : RETRY_MS * failures;
      cancelRetry = env.later(() => { cancelRetry = null; void step(); }, delay);
      return;
    }
    if (inflight === controller) inflight = null;
    if (current !== ticket) return;
    failures = 0;
    if (outcome.status === 'accepted') {
      end({ step: 'accepted', access: outcome.access });
      env.paired(outcome.token);
    } else if (outcome.status === 'denied') {
      end({ step: 'denied', reason: outcome.reason });
    } else if (outcome.status === 'expired') {
      end({ step: 'expired' });
    } else if (env.now() - started < 1000) {
      cancelRetry = env.later(() => { cancelRetry = null; void step(); }, RETRY_MS); // an early 'pending' never spins
    } else {
      void step(); // still open: the next long request
    }
  };

  const begin = (ticket: AccessTicket) => {
    current = ticket;
    failures = 0;
    env.save(JSON.stringify(ticket));
    state.value = { step: 'waiting', code: ticket.code, expiresAt: ticket.expiresAt, ...(ticket.proven ? { proven: true } : {}) };
    unwatch ??= env.watchVisibility(() => {
      if (env.visible()) void step();
      else inflight?.abort();
    });
    void step();
  };

  /** Asks to join (once at a time); `proof` – the invite's ticket or the typed code. */
  const ask = async (proof?: AccessProof): Promise<void> => {
    const now = state.peek().step;
    if (now === 'asking' || now === 'waiting') return;
    state.value = { step: 'asking' };
    try {
      begin(await env.request(env.name(), proof));
    } catch (error) {
      state.value = { step: 'failed', message: errorText(error) };
    }
  };

  return {
    state,
    ask,
    /** Keeps waiting on a request this tab made before a reload; an invite address asks with its ticket. */
    resume(): void {
      const scanned = env.takeTicket?.();
      if (scanned && !current) { void ask({ ticket: scanned }); return; }
      const ticket = parseTicket(env.load());
      if (!ticket || ticket.expiresAt + STALE_MS <= env.now()) { env.save(null); return; }
      if (!current) begin(ticket);
    },
    /** Stops waiting here (the PC lets the request expire). */
    cancel(): void {
      end({ step: 'idle' });
    },
  };
}

export type AccessFlow = ReturnType<typeof createAccessFlow>;
