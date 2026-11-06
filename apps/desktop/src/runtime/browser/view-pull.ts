// Frames for phones (browser.pull / browser.pullPart): devices never get pushed frames – a slow phone link would fill
// the socket. A device pulls one state or frame at a time instead: each pull holds a watch of the agent's browser
// (view.ts) and releases it PULL_GRACE_MS after it returned, so a chain of pulls keeps one screencast alive and a phone
// that stops pulling ends it. A pull answers at once with a newer state, or with a newer frame once the caller's last
// frame of that browser is DEVICE_FRAME_GAP_MS old (the owner: OWNER_FRAME_GAP_MS); else it waits for the browser's
// next state or frame event, the rest of the gap, `waitMs` or the caller's abort. A frame longer than `maxBytes` comes
// as part 0 and `parts`; the whole frame waits in a small cache for browser.pullPart.
// B-076: the loop itself is FramePulls, keyed by any string and woken by any change source, so a side-browser tab
// watched from another PC or a phone (side-view.ts) pulls the same way; BrowserPulls is it for agents' browsers.
// Owns: the pull loop, the per-caller frame gap and the part cache, bound per runtime services.
// Never: polls (change events and one-shot timers only), or keeps a listener, timer or watch after a pull ended.

import { WorkforceError } from '../../shared/errors.ts';
import {
  DEVICE_FRAME_GAP_MS, PULL_DEFAULT_BYTES, PULL_WAIT_MAX_MS,
  type BrowserFrame, type BrowserPartRequest, type BrowserPull, type BrowserPullRequest, type BrowserViewState,
} from '../../shared/model/browser.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { BrowserView } from './view.ts';

/** A pull's watch outlives it by this much (the caller's next pull follows at once). */
export const PULL_GRACE_MS = 10_000;
/** The owner's own gap (the same as the pushed frames, view.ts FRAME_GAP_MS). */
export const OWNER_FRAME_GAP_MS = 500;
/** The caller key of the owner (devices: their device id). */
export const OWNER_CALLER = 'owner';
const PART_ENTRIES = 16;
const PART_TTL_MS = 60_000;
const SENT_ENTRIES = 256;
const MIN_WAIT_MS = 1000;
const GONE = 'That picture is gone. Look again.';

export interface PullTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: PullTimers = {
  now: () => Date.now(),
  set: (fn, ms) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PullDeps {
  bus: Pick<RuntimeServices['bus'], 'on'>;
  timers?: PullTimers;
}

/** What one pull may get: a state and a frame, each stamped with when it was made. */
export interface Stamped { at: number }
export interface PulledFrame extends Stamped { data: string }

/** The live views a pull reads, by key: a watch held while it runs and the current state and frame. */
export interface PullSource<S extends Stamped, F extends PulledFrame> {
  watch(key: string): () => void;
  current(key: string): Promise<{ state: S; frame?: F }>;
}

/** The live view a pull needs (agents' browsers, keyed by agent id). */
export type PullViews = Pick<BrowserView, 'watch' | 'current'>;

/** One pull's wishes: past which state and frame, the reply's frame characters, the longest wait, the caller's gap. */
export interface PullOptions {
  after?: { state?: number; frame?: number };
  maxBytes?: number;
  waitMs?: number;
  gapMs: number;
}

/** Calls `wake` on the next change of `key`'s state or frame; returns the unsubscribe. */
export type PullChanges = (key: string, wake: () => void) => () => void;

interface Parts { at: number; data: string; size: number; expires: number }

export class FramePulls<S extends Stamped, F extends PulledFrame> {
  private readonly changes: PullChanges;
  private readonly timers: PullTimers;
  /** caller|key → when its last frame was answered. */
  private readonly sent = new Map<string, number>();
  /** caller|key → the whole frame its last pull answered in parts (oldest first). */
  private readonly parts = new Map<string, Parts>();

  constructor(changes: PullChanges, timers: PullTimers = REAL_TIMERS) {
    this.changes = changes;
    this.timers = timers;
  }

  /** One pull of `caller` for `key`. */
  async pull(caller: string, key: string, source: PullSource<S, F>, options: PullOptions, signal: AbortSignal): Promise<{ state: S; frame?: F; parts?: number }> {
    const slot = `${caller}|${key}`;
    const waitMs = Math.min(PULL_WAIT_MAX_MS, Math.max(MIN_WAIT_MS, options.waitMs ?? PULL_WAIT_MAX_MS));
    const maxBytes = options.maxBytes ?? PULL_DEFAULT_BYTES;
    const after = { state: options.after?.state ?? Number.NEGATIVE_INFINITY, frame: options.after?.frame ?? Number.NEGATIVE_INFINITY };
    const release = source.watch(key);
    const deadline = this.timers.now() + waitMs;
    try {
      for (;;) {
        const { state, frame } = await source.current(key);
        const fresh = frame && frame.at > after.frame ? frame : undefined;
        const due = fresh ? (this.sent.get(slot) ?? Number.NEGATIVE_INFINITY) + options.gapMs - this.timers.now() : Number.POSITIVE_INFINITY;
        if (fresh && due <= 0) return this.answer(slot, state, fresh, maxBytes);
        const left = deadline - this.timers.now();
        if (state.at > after.state || signal.aborted || left <= 0) return this.answer(slot, state, undefined, maxBytes);
        await this.change(key, Math.min(left, due), signal);
      }
    } finally {
      this.timers.set(release, PULL_GRACE_MS);
    }
  }

  /** Part `index` of the frame (`at`) the caller's last pull of `key` answered in parts. */
  part(caller: string, key: string, at: number, index: number): { data: string } {
    const slot = `${caller}|${key}`;
    const entry = this.parts.get(slot);
    if (entry && entry.expires <= this.timers.now()) this.parts.delete(slot);
    const count = entry ? Math.ceil(entry.data.length / entry.size) : 0;
    if (!entry || !this.parts.has(slot) || entry.at !== at || index < 0 || index >= count) throw new WorkforceError('not_found', GONE);
    return { data: entry.data.slice(index * entry.size, (index + 1) * entry.size) };
  }

  // ------------------------------------------------------------------ internals

  private answer(slot: string, state: S, frame: F | undefined, maxBytes: number): { state: S; frame?: F; parts?: number } {
    this.parts.delete(slot); // the caller's next pull replaces what waited for it
    if (!frame) return { state };
    this.sent.delete(slot);
    this.sent.set(slot, this.timers.now());
    if (this.sent.size > SENT_ENTRIES) this.sent.delete(this.sent.keys().next().value!);
    if (frame.data.length <= maxBytes) return { state, frame };
    this.parts.set(slot, { at: frame.at, data: frame.data, size: maxBytes, expires: this.timers.now() + PART_TTL_MS });
    while (this.parts.size > PART_ENTRIES) this.parts.delete(this.parts.keys().next().value!);
    return { state, frame: { ...frame, data: frame.data.slice(0, maxBytes) }, parts: Math.ceil(frame.data.length / maxBytes) };
  }

  /** Resolves on the key's next change, after `ms`, or when `signal` aborts – leaving nothing behind. */
  private change(key: string, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let off = () => {};
      let timer: unknown;
      const done = () => {
        if (settled) return;
        settled = true;
        off();
        this.timers.clear(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      off = this.changes(key, done);
      timer = this.timers.set(done, Math.max(0, ms));
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}

/** Agents' browsers: keyed by agent id, woken by the bus's browser.view / browser.frame. */
export class BrowserPulls {
  private readonly frames: FramePulls<BrowserViewState, BrowserFrame>;

  constructor(deps: PullDeps) {
    const { bus } = deps;
    this.frames = new FramePulls((agentId, wake) => {
      const mine = (data: { agentId: string }) => { if (data.agentId === agentId) wake(); };
      const offs = [bus.on('browser.view', mine), bus.on('browser.frame', mine)];
      return () => { for (const off of offs) off(); };
    }, deps.timers);
  }

  /** One pull of `caller` ('owner' or its device id). */
  pull(caller: string, views: PullViews, request: BrowserPullRequest, signal: AbortSignal): Promise<BrowserPull> {
    const gapMs = caller === OWNER_CALLER ? OWNER_FRAME_GAP_MS : DEVICE_FRAME_GAP_MS;
    return this.frames.pull(caller, request.agentId, views, { after: request.after, maxBytes: request.maxBytes, waitMs: request.waitMs, gapMs }, signal);
  }

  /** Part `index` of the frame (`at`) the caller's last pull of that browser answered in parts. */
  part(caller: string, request: BrowserPartRequest): { data: string } {
    return this.frames.part(caller, request.agentId, request.at, request.index);
  }
}

// ------------------------------------------------------------------ per runtime

const bound = new WeakMap<object, BrowserPulls>();

/** This runtime's pulls (created on first use, keyed by its RuntimeServices). */
export function pullsOf(services: Pick<RuntimeServices, 'bus'>): BrowserPulls {
  let pulls = bound.get(services);
  if (!pulls) {
    pulls = new BrowserPulls({ bus: services.bus });
    bound.set(services, pulls);
  }
  return pulls;
}
