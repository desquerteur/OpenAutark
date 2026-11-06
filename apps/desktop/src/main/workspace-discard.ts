// The memory saver (for an 8-GB laptop, like Chrome's): a personal tab hidden for `after`
// (DISCARD_AFTER_MS, 20 min) gives its page up – workspace-browser.ts closes its renderer and keeps
// its address and title; it loads again when it is shown. `keep` names tabs that stay (the
// browser keeps the tab shown last, one playing sound or muted, one with DevTools open, or downloading): such a tab is looked at again `after` later. One timer, for the next tab due – no
// polling, none while no tab is hidden.
// Owns: when a hidden tab is due. Never: imports electron or touches a page itself.

export const DISCARD_AFTER_MS = 20 * 60_000;

/** The time a hidden tab keeps its page: `ms` when given, else 20 min – a test profile (WORKFORCE_TEST_DATA) may shorten it with WORKFORCE_TAB_DISCARD_MS (≥ 100), a real profile never. */
export function discardAfter(ms?: number, env: Record<string, string | undefined> = process.env): number {
  const test = Number(env.WORKFORCE_TAB_DISCARD_MS);
  return ms ?? (env.WORKFORCE_TEST_DATA && test >= 100 ? test : DISCARD_AFTER_MS);
}

export interface DiscardDeps {
  after: number;
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** The tab must stay loaded now. */
  keep(id: string): boolean;
  discard(id: string): void;
}

export class DiscardTimer {
  private readonly since = new Map<string, number>();
  private readonly deps: DiscardDeps;
  private timer: unknown = null;

  constructor(deps: DiscardDeps) { this.deps = deps; }

  /** The tab is out of sight (its time starts unless it already runs). */
  hidden(id: string): void {
    if (this.since.has(id)) return;
    this.since.set(id, this.deps.now());
    this.schedule();
  }

  /** The tab is shown (or gone): it is not due. */
  shown(id: string): void {
    if (!this.since.delete(id)) return;
    this.schedule();
  }

  /** Tabs being timed (tests, diagnostics). */
  timed(): string[] { return [...this.since.keys()]; }

  stop(): void {
    this.since.clear();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) { this.deps.clear(this.timer); this.timer = null; }
    if (!this.since.size) return;
    const next = Math.min(...this.since.values()) + this.deps.after;
    this.timer = this.deps.set(() => { this.timer = null; this.run(); }, Math.max(0, next - this.deps.now()));
  }

  private run(): void {
    const now = this.deps.now();
    for (const [id, since] of [...this.since]) {
      if (now - since < this.deps.after) continue;
      if (this.deps.keep(id)) { this.since.set(id, now); continue; }
      this.since.delete(id);
      try { this.deps.discard(id); } catch { /* the tab went meanwhile */ }
    }
    this.schedule();
  }
}
