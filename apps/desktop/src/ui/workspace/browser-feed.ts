// One shared live feed per agent browser for every view of it (Team's agent page, a browser to-do): the
// first view of an agent's browser calls browser.subscribe, the last one browser.unsubscribe. State and
// frames arrive as events (browser.view / browser.frame on topic browser:<agentId>, MP8) and reach only the
// views of that agent. A reconnect subscribes again (the runtime forgets a closed connection's watches). A
// new view gets the last state and frame at once.
// X02 pull mode (phones – `pulls()`; frames are never pushed to a device): one
// loop per browser with one browser.pull in flight; a reply in parts is joined from
// browser.pullPart (a part gone: the frame is dropped and pulled again); the next pull asks past
// the last state and frame. The loop ends when the last view goes (no unsubscribe call – the
// runtime's watch ends on its own; the entry and its frame go with it) or when a reconnect starts
// a new one; an error is shown once and the loop waits for the next reconnect.
// B-076: the feed is generic over its state and frame – a side-browser tab watched from another PC or the phone
// (RemoteWebTab.tsx) is a pull-only feed keyed by its PC and tab; with `retryMs` a failed pull is tried again after
// that time while the view stays (the other PC may come back), instead of waiting for a reconnect.
// Also the pure helpers for the agents' open browsers.
// Owns: the ref-counted subscriptions, the pull loops and the last state / frame per browser.
// Never: renders, polls on a timer, or keeps a subscription, loop or (pull mode) frame without a view.

import type { BrowserFrame, BrowserSessionInfo, BrowserViewState } from '../../shared/model/browser.ts';

/** What a feed needs of a state and a frame: when it was made (pulls ask past it); frames carry their picture. */
interface Stamped { at: number }
interface Pictured extends Stamped { data: string }

export interface FeedView<S, F> { state: S | null; frame: F | null; error: string | null }
export type BrowserFeedView = FeedView<BrowserViewState, BrowserFrame>;
export type BrowserFeedListener<S = BrowserViewState, F = BrowserFrame> = (view: FeedView<S, F>) => void;

export interface BrowserFeedDeps<S extends Stamped = BrowserViewState, F extends Pictured = BrowserFrame> {
  subscribe(agentId: string): Promise<{ state: NoInfer<S>; frame?: NoInfer<F> }>; // the types come from the pulls or the defaults
  unsubscribe(agentId: string): Promise<unknown>;
  /** Pushed states and frames; each reaches the views of its `agentId`. */
  onState(listener: (state: S) => void): () => void;
  onFrame(listener: (frame: F) => void): () => void;
  /** After every (re)connect. */
  onOpen(listener: () => void): () => void;
  errorText(error: unknown): string;
  /** X02: pull frames instead of subscribing (asked when a browser gets its first view). */
  pulls?(): boolean;
  pull?(agentId: string, after: { state?: number; frame?: number }): Promise<{ state: S; frame?: F; parts?: number }>;
  pullPart?(agentId: string, at: number, index: number): Promise<{ data: string }>;
  /** B-076: after a failed pull, try again this much later while a view stays (else: at the next reconnect). */
  retryMs?: number;
}

export interface BrowserFeed<S = BrowserViewState, F = BrowserFrame> {
  subscribe(agentId: string, listener: BrowserFeedListener<S, F>): () => void;
  /** Agents whose browser has at least one view (tests, diagnostics). */
  active(): string[];
}

interface Entry<S, F> {
  agentId: string;
  listeners: Set<BrowserFeedListener<S, F>>;
  view: FeedView<S, F>;
  /** Pull mode: the running loop's epoch (a reconnect starts the next) and whether one runs. */
  epoch: number;
  pulling: boolean;
}

const isGone = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'not_found';
/** The browser a pushed state or frame belongs to. */
const ownerOf = (item: unknown): string => String((item as { agentId?: unknown } | null)?.agentId ?? '');

export function createBrowserFeed<S extends Stamped = BrowserViewState, F extends Pictured = BrowserFrame>(deps: BrowserFeedDeps<S, F>): BrowserFeed<S, F> {
  type View = FeedView<S, F>;
  const entries = new Map<string, Entry<S, F>>();
  let wired = false;
  const pulling = () => Boolean(deps.pulls?.() && deps.pull && deps.pullPart);

  const publish = (entry: Entry<S, F>, next: Partial<View>) => {
    const view = { ...entry.view, ...next };
    entry.view = view;
    for (const listener of [...entry.listeners]) {
      try { listener(view); } catch (error) { console.error('[browser] view listener failed', error); }
    }
  };

  /** A reply's frame with its parts joined; null when a part is gone (the next pull brings it again). */
  const joined = async (entry: Entry<S, F>, reply: { frame?: F; parts?: number }): Promise<F | null> => {
    const frame = reply.frame;
    if (!frame) return null;
    let data = frame.data;
    for (let index = 1; index < (reply.parts ?? 1); index++) {
      try { data += (await deps.pullPart!(entry.agentId, frame.at, index)).data; } catch (error) {
        if (isGone(error)) return null;
        throw error;
      }
    }
    return data === frame.data ? frame : { ...frame, data };
  };

  /** One pull at a time while the browser has a view and no reconnect started a newer loop. */
  const loop = async (entry: Entry<S, F>, epoch: number) => {
    entry.pulling = true;
    const after: { state?: number; frame?: number } = {};
    const current = () => entry.epoch === epoch;
    try {
      while (entry.listeners.size && current()) {
        let reply: { state: S; frame?: F; parts?: number };
        let frame: F | null;
        try {
          reply = await deps.pull!(entry.agentId, { ...after });
          frame = current() ? await joined(entry, reply) : null;
        } catch (error) {
          if (current() && entry.listeners.size) publish(entry, { error: deps.errorText(error) });
          if (!deps.retryMs) return;
          await new Promise((resolve) => setTimeout(resolve, deps.retryMs)); // one wait, then the loop asks again while a view stays
          continue;
        }
        if (!current()) return;
        const same = !frame && !entry.view.error && entry.view.state?.at === reply.state.at; // a wait that ran out
        after.state = reply.state.at;
        if (frame) after.frame = frame.at;
        if (entry.listeners.size && !same) publish(entry, frame ? { state: reply.state, frame, error: null } : { state: reply.state, error: null });
      }
    } finally {
      if (current()) { entry.pulling = false; forget(entry); }
    }
  };

  /** Pull mode: an entry no view shows and no loop serves goes with its frame (a remote tab's key is one per tab on its PC). */
  const forget = (entry: Entry<S, F>) => {
    if (!entry.listeners.size && !entry.pulling && entries.get(entry.agentId) === entry) entries.delete(entry.agentId);
  };

  const join = (entry: Entry<S, F>, fresh = false) => {
    if (pulling()) {
      if (fresh) entry.epoch++;
      if (fresh || !entry.pulling) void loop(entry, entry.epoch);
      return;
    }
    deps.subscribe(entry.agentId).then(
      (result) => { if (entry.listeners.size) publish(entry, { state: result.state, frame: result.frame ?? entry.view.frame, error: null }); },
      (error: unknown) => { if (entry.listeners.size) publish(entry, { error: deps.errorText(error) }); },
    );
  };

  const wire = () => {
    if (wired) return;
    wired = true;
    deps.onState((state) => {
      const entry = entries.get(ownerOf(state));
      if (entry?.listeners.size) publish(entry, { state, error: null });
    });
    deps.onFrame((frame) => {
      const entry = entries.get(ownerOf(frame));
      if (entry?.listeners.size) publish(entry, { frame });
    });
    deps.onOpen(() => { for (const entry of entries.values()) if (entry.listeners.size) join(entry, true); });
  };

  return {
    subscribe(agentId, listener) {
      wire();
      let entry = entries.get(agentId);
      if (!entry) {
        entry = { agentId, listeners: new Set(), view: { state: null, frame: null, error: null }, epoch: 0, pulling: false };
        entries.set(agentId, entry);
      }
      const own = entry;
      const first = own.listeners.size === 0;
      own.listeners.add(listener);
      if (own.view.state || own.view.frame || own.view.error) listener(own.view);
      if (first) join(own);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        own.listeners.delete(listener);
        if (own.listeners.size) return;
        // Last view gone: the runtime stops the screencast; the last frame stays for a quick re-open.
        // Pull mode: the loop ends after its pull and the runtime's watch after its grace – nothing to call; the entry
        // goes once no loop serves it (a view coming back meanwhile reuses the running pull).
        if (!pulling()) void deps.unsubscribe(own.agentId).catch(() => undefined);
        else forget(own);
      };
    },
    active() {
      return [...entries.entries()].filter(([, entry]) => entry.listeners.size > 0).map(([key]) => key);
    },
  };
}

/** The open browsers of these agents. */
export function agentBrowsers(sessions: readonly BrowserSessionInfo[], agentIds: readonly string[]): BrowserSessionInfo[] {
  const wanted = new Set(agentIds);
  return sessions.filter((entry) => wanted.has(entry.agentId));
}

/**
 * The session list after browser.sessions (the open agents now): closed ones drop out, newly opened ones
 * appear (address and title follow with the next list).
 */
export function mergeLocal(sessions: readonly BrowserSessionInfo[], open: readonly string[]): BrowserSessionInfo[] {
  const still = sessions.filter((entry) => open.includes(entry.agentId));
  const known = new Set(still.map((entry) => entry.agentId));
  return [...still, ...open.filter((agentId) => !known.has(agentId)).map((agentId) => ({ agentId, tabs: 0, url: '', title: '' }))];
}

/** The <img> source of a frame. */
export function frameSrc(frame: Pick<BrowserFrame, 'data'>): string {
  return `data:image/jpeg;base64,${frame.data}`;
}
