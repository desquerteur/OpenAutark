// One long-poll loop per Telegram bot: getUpdates (timeout 50 s) with an offset cursor, a first
// start that skips the backlog, exponential backoff 1 s … 5 min on errors (retry_after on 429)
// and a clean stop through an AbortController.
// Owns: the loop and its single in-flight request. Never: polls on a timer (the next request
// starts only when the previous one returned), interprets updates (the service does), logs the
// token, or keeps retrying after Telegram rejected the token.

import type { Clock, Logger } from '../contracts.ts';
import { TelegramError, scrub } from './telegram-api.ts';
import type { TelegramApi, TgUpdate } from './telegram-api.ts';

export const LONG_POLL_SECONDS = 50;
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Waits `ms`, or less when the signal aborts. Injectable for tests. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

/** 1 s, 2 s, 4 s … capped at 5 min. */
export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

export interface PollerState {
  status: 'connected' | 'error';
  error?: string;
  /** The loop ended for good (token rejected). */
  final?: boolean;
}

export interface PollerOptions {
  api: TelegramApi;
  token: string;
  /** Next update offset; undefined = first start (the backlog is skipped). */
  offset?: number;
  clock: Clock;
  log: Logger;
  sleep: Sleep;
  /** Handles one batch; the cursor moves past it afterwards (at-least-once delivery). */
  onUpdates(updates: TgUpdate[]): Promise<void> | void;
  onOffset(offset: number): void;
  onState(state: PollerState): void;
}

export class TelegramPoller {
  private readonly o: PollerOptions;
  private readonly controller = new AbortController();
  private running?: Promise<void>;
  private next?: number;

  constructor(options: PollerOptions) {
    this.o = options;
    this.next = options.offset;
  }

  get offset(): number | undefined {
    return this.next;
  }

  start(): void {
    this.running ??= this.loop();
  }

  /** Aborts the in-flight request and any backoff wait. */
  stop(): void {
    this.controller.abort();
  }

  /** Resolves when the loop has ended (after stop() or a rejected token). */
  done(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (this.next === undefined) await this.skipBacklog(signal);
        else await this.poll(signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        const failure = error instanceof TelegramError ? error : undefined;
        if (failure?.kind === 'unauthorized') {
          this.o.log.warn('telegram bridge stopped: token rejected', { detail: failure.detail });
          this.o.onState({ status: 'error', error: `${failure.message} Connect again with a new token.`, final: true });
          break;
        }
        failures++;
        const wait = failure?.retryAfterMs ?? backoffMs(failures);
        this.o.log.warn('telegram poll failed', { kind: failure?.kind ?? 'internal', detail: failure?.detail ?? scrub(String(error), this.o.token), retryInMs: wait });
        this.o.onState({ status: 'error', error: `${failure?.message ?? 'Reading Telegram updates failed.'} Retrying.` });
        await this.o.sleep(wait, signal);
      }
    }
  }

  /** First start: confirms everything sent before the link, so old messages do not flood in. */
  private async skipBacklog(signal: AbortSignal): Promise<void> {
    const updates = await this.o.api.getUpdates(this.o.token, { offset: -1, timeout: 0 }, signal);
    if (signal.aborted) return;
    this.next = updates.length ? Math.max(...updates.map((update) => update.update_id)) + 1 : 0;
    this.o.onOffset(this.next);
    this.o.onState({ status: 'connected' });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const started = this.o.clock.now();
    const updates = await this.o.api.getUpdates(this.o.token, { offset: this.next || undefined, timeout: LONG_POLL_SECONDS }, signal);
    if (signal.aborted) return;
    this.o.onState({ status: 'connected' });
    if (!updates.length) {
      // A long poll that comes back empty at once (proxy, server hiccup) must not spin.
      if (this.o.clock.now() - started < MIN_BACKOFF_MS) await this.o.sleep(MIN_BACKOFF_MS, signal);
      return;
    }
    try {
      await this.o.onUpdates(updates);
    } catch (error) {
      // A handler bug must not replay the same batch forever; the batch is skipped and logged.
      this.o.log.error('telegram updates could not be handled', { error: scrub(String(error), this.o.token) });
    }
    this.next = Math.max(...updates.map((update) => update.update_id)) + 1;
    this.o.onOffset(this.next);
  }
}
