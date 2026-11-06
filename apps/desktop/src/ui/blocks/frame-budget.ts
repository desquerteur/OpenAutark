// Live-frame budget for ```app mini-tools (web-genui §7.10): at most N sandboxed iframes are
// alive at once. A frame asks for a slot when it scrolls into view and gives it back when it
// leaves; when all slots are taken, the least recently activated unpinned frame is evicted
// (it shows a placeholder of its last height until it gets a slot again).
// Owns: slot bookkeeping and live-state notifications. Never: touches the DOM (pure, tested).

export type LiveListener = (live: boolean) => void;

export class FrameBudget {
  private readonly limit: number;
  /** Live frame ids, least recently activated first. */
  private live: string[] = [];
  private readonly pinned = new Set<string>();
  private readonly listeners = new Map<string, LiveListener>();

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Registers a frame; returns the unregister function (which also frees its slot). */
  register(id: string, listener: LiveListener): () => void {
    this.listeners.set(id, listener);
    return () => {
      if (this.listeners.get(id) !== listener) return;
      this.listeners.delete(id);
      this.pinned.delete(id);
      this.live = this.live.filter((entry) => entry !== id);
    };
  }

  /** Grants a slot (evicting the oldest unpinned frame if needed). False when every slot is pinned. */
  acquire(id: string): boolean {
    const index = this.live.indexOf(id);
    if (index !== -1) {
      this.live.splice(index, 1);
      this.live.push(id);
      return true;
    }
    if (this.live.length >= this.limit) {
      const victim = this.live.find((entry) => !this.pinned.has(entry));
      if (victim === undefined) return false;
      this.live = this.live.filter((entry) => entry !== victim);
      this.notify(victim, false);
    }
    this.live.push(id);
    this.notify(id, true);
    return true;
  }

  /** Frees the frame's slot (it scrolled away or was closed). Pinned frames keep theirs. */
  release(id: string): void {
    if (this.pinned.has(id) || !this.live.includes(id)) return;
    this.live = this.live.filter((entry) => entry !== id);
    this.notify(id, false);
  }

  /** A pinned frame (e.g. fullscreen) is never evicted. */
  pin(id: string, on: boolean): void {
    if (on) this.pinned.add(id);
    else this.pinned.delete(id);
  }

  isLive(id: string): boolean {
    return this.live.includes(id);
  }

  liveIds(): string[] {
    return [...this.live];
  }

  private notify(id: string, live: boolean): void {
    const listener = this.listeners.get(id);
    if (!listener) return;
    try { listener(live); } catch { /* a broken frame must not break the budget */ }
  }
}
