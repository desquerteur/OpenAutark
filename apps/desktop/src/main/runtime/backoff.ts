// Restart backoff for supervised processes: 1 s, 2 s, 4 s … capped at 30 s; reset after the
// process stayed up long enough. Owns: the delay sequence only. Never: timers or processes.

export interface BackoffOptions {
  initialMs?: number; // default 1000
  maxMs?: number; // default 30000
  /** Uptime after which the next crash starts again at initialMs (default 60 s). */
  stableMs?: number;
}

export class Backoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly stableMs: number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.initialMs = options.initialMs ?? 1000;
    this.maxMs = options.maxMs ?? 30_000;
    this.stableMs = options.stableMs ?? 60_000;
  }

  /** Delay before the next restart, given how long the process was up. */
  next(uptimeMs: number): number {
    if (uptimeMs >= this.stableMs) this.attempt = 0;
    const delay = Math.min(this.maxMs, this.initialMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return delay;
  }

  reset(): void { this.attempt = 0; }
}
