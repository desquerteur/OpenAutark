// Main's handle on the desktop renderer (the one app window, which may come and go).
// Owns: sending pushes only to a live, loaded page; queueing pushes that must survive a window
// being (re)created (navigate after a notification click); the prepare-restart request/ack
// (drafts flushed before an update or quit); the renderer's "safe to restart" flag.
// Never: talks RPC or holds app data – it only moves IPC messages.

import { IPC } from '../shared/api/desktop.ts';

export interface ContentsLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface RendererLinkOptions {
  /** The renderer's restart readiness changed (re-evaluate the update gate). */
  onReadyChange?(): void;
  /** The page finished loading (push the current runtime/update state). */
  onLoaded?(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface PendingAck { resolve(ok: boolean): void; timer: unknown }

const MAX_QUEUED = 20;

export class RendererLink {
  private readonly options: RendererLinkOptions;
  private contents: ContentsLike | null = null;
  private loaded = false;
  private ready = false;
  private nextRequest = 1;
  private readonly acks = new Map<number, PendingAck>();
  private queued: Array<{ channel: string; args: unknown[] }> = [];

  constructor(options: RendererLinkOptions = {}) {
    this.options = options;
  }

  /** webContents id of the current window (the IPC trust anchor), null without a window. */
  get contentsId(): number | null {
    return this.alive() ? this.contents!.id : null;
  }

  get isLoaded(): boolean { return this.alive() && this.loaded; }

  /** No window means no unsaved UI state: restart-safe. A loading page is not (yet) ready. */
  get rendererReady(): boolean {
    return this.alive() ? this.loaded && this.ready : true;
  }

  /** A new window (its page starts loading). */
  attach(contents: ContentsLike): void {
    this.detach();
    this.contents = contents;
    this.loaded = false;
    this.ready = false;
  }

  /** The window is gone: pending acks resolve true (nothing left to flush). */
  detach(): void {
    const had = this.contents !== null;
    this.contents = null;
    this.loaded = false;
    this.ready = false;
    if (had) this.options.onReadyChange?.(); // no window = restart-safe now
    for (const [id, ack] of this.acks) {
      this.acks.delete(id);
      this.clearTimer(ack.timer);
      ack.resolve(true);
    }
  }

  /** did-navigate (main frame) or a renderer crash: the page state and its readiness are gone. */
  loading(): void {
    this.loaded = false;
    this.setReady(false);
  }

  /** did-finish-load: the page's listeners exist now; deliver queued pushes. */
  finishedLoading(): void {
    if (!this.alive()) return;
    this.loaded = true;
    const queued = this.queued;
    this.queued = [];
    this.options.onLoaded?.();
    for (const entry of queued) this.send(entry.channel, ...entry.args);
  }

  setReady(ready: boolean): void {
    const next = ready === true && this.alive();
    if (next === this.ready) return;
    this.ready = next;
    this.options.onReadyChange?.();
  }

  /** Push to the page if it is there; dropped otherwise (state is re-read on load). */
  send(channel: string, ...args: unknown[]): void {
    if (!this.alive()) return;
    try { this.contents!.send(channel, ...args); } catch { /* window closing */ }
  }

  /** Push that must reach a page that may still be loading (or about to be created). */
  sendWhenLoaded(channel: string, ...args: unknown[]): void {
    if (this.isLoaded) { this.send(channel, ...args); return; }
    this.queued.push({ channel, args });
    if (this.queued.length > MAX_QUEUED) this.queued = this.queued.slice(-MAX_QUEUED);
  }

  /**
   * Asks the page to save drafts before a restart/quit. True when it confirmed, when there is
   * no page, or while it is still loading (nothing typed yet); false on refusal or timeout.
   */
  prepareRestart(timeoutMs: number): Promise<boolean> {
    if (!this.alive() || !this.loaded) return Promise.resolve(true);
    const id = this.nextRequest++;
    return new Promise(resolve => {
      const timer = this.setTimer(() => {
        if (this.acks.delete(id)) resolve(false);
      }, timeoutMs);
      this.acks.set(id, { resolve, timer });
      this.send(IPC.prepareRestart, id);
    });
  }

  /** prepareRestartAck from the page. */
  ack(id: number, ok: boolean): void {
    const pending = this.acks.get(id);
    if (!pending) return;
    this.acks.delete(id);
    this.clearTimer(pending.timer);
    pending.resolve(ok === true);
  }

  private alive(): boolean {
    return this.contents !== null && !this.contents.isDestroyed();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
