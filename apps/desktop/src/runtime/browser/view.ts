// The person's live view of agents' own browsers (Team › agent, a browser to-do): a CDP screencast (JPEG, at most
// 1280 px on either side, every frame acknowledged at once) runs only while someone watches and follows the agent's
// active tab; at most one frame per 500 ms is passed on, the newest. The person steers (view-steer.ts), types and
// clicks into the shown tab (view-input.ts) and takes the browser over – any input or Show window turns the
// takeover flag on (takeover.ts); Hand back ends it and wakes the agent. A click or Enter first keeps the password
// fields' values for the vault (the owner's 29.10.2026 wish). Addresses and titles pass the vault's redaction.
// startBrowserView binds this runtime's view to its services (rpc/handlers/browser.ts finds it with browserViewOf).
// Owns: per-agent watches, the screencast, throttling, the input path, the view state and the takeover's end.
// Never: keeps a screencast without a watcher, logs or keeps typed input, or lets watching count as use.

import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserFrame, BrowserInput, BrowserSessionInfo, BrowserSteer, BrowserTakeoverRequest, BrowserViewState } from '../../shared/model/browser.ts';
import type { BrowserChange, BrowserService, ViewSession } from './service.ts';
import { hostOf, passwordValues, titleWithin, type CdpSessionLike, type PageLike } from './page.ts';
import { NO_LIVE, steerBrowser } from './view-steer.ts';
import { frameMeta, sendInput, type FrameMeta } from './view-input.ts';
import { keepPasswords, wakeAfterTakeover } from './takeover.ts';

/** At most one frame per this many ms reaches the watchers (2 per second). */
export const FRAME_GAP_MS = 500;
/** Frames are JPEG, at most this many px on either side. */
export const MAX_SIDE = 1280;
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, everyNthFrame: 1 };
const MAX_TABS = 30;

export type ViewServices = Pick<RuntimeServices, 'bus' | 'log' | 'secrets'>;

export interface BrowserViewDeps {
  browser: BrowserService;
  services: () => ViewServices;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface ScreencastFrame { data?: unknown; sessionId?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown; offsetTop?: unknown; pageScaleFactor?: unknown } }

interface Watch {
  agentId: string;
  leases: number;
  page?: PageLike; // the page the screencast runs on
  tab?: string;
  cdp?: CdpSessionLike;
  detach?: () => void;
  failed?: PageLike; // the screencast could not start there: retried after the agent's next step or on another tab
  error?: string;
  chain: Promise<void>; // start / stop / state work, one at a time
  state: BrowserViewState;
  frame?: BrowserFrame;
  pending?: BrowserFrame; // the newest frame waiting for its slot
  timer?: unknown;
  lastAt: number;
  meta?: FrameMeta; // the viewport of the newest frame (maps the person's clicks)
  inputs?: Promise<void>; // the person's input, one at a time
}

/** Is this input of the person likely to send a form (a click, Enter)? */
const sendsForm = (input: BrowserInput) => (input.kind === 'mouse' && input.type === 'down') || (input.kind === 'key' && input.type === 'down' && input.key === 'Enter');

export class BrowserView {
  private readonly deps: BrowserViewDeps;
  private readonly watches = new Map<string, Watch>();

  constructor(deps: BrowserViewDeps) {
    this.deps = deps;
    deps.browser.onChange((agentId, why) => this.changed(agentId, why));
  }

  /** The open agent browsers here (the active tab's address and title, redacted). */
  async list(): Promise<BrowserSessionInfo[]> {
    const clean = (text: string) => this.deps.services().secrets.redact(text);
    return Promise.all(this.deps.browser.agents().map(async (agentId) => {
      const view = this.deps.browser.viewOf(agentId);
      return { agentId, tabs: view?.tabs.length ?? 0, url: clean(view?.active?.url() ?? ''), title: clean(view?.active ? await titleWithin(view.active) : '') };
    }));
  }

  /** Starts watching an agent's browser; returns the release. Frames flow while at least one watch holds. */
  watch(agentId: string): () => void {
    let watch = this.watches.get(agentId);
    if (!watch) {
      watch = { agentId, leases: 0, chain: Promise.resolve(), state: { agentId, open: false, tabs: [], live: false, at: 0 }, lastAt: 0 };
      this.watches.set(agentId, watch);
    }
    const own = watch;
    own.leases++;
    this.sync(own);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--own.leases === 0) this.sync(own);
    };
  }

  /** The current state and last frame (after pending start / stop work). */
  async current(agentId: string): Promise<{ state: BrowserViewState; frame?: BrowserFrame }> {
    const watch = this.watches.get(agentId);
    if (!watch) return { state: await this.build(agentId, this.deps.browser.viewOf(agentId)) };
    await watch.chain;
    return { state: watch.state, frame: watch.frame };
  }

  /** The person steers the agent's browser (one of tab, url, action, window); returns the new state. */
  async steer(agentId: string, input: BrowserSteer): Promise<BrowserViewState> {
    const view = this.deps.browser.viewOf(agentId);
    if (!view) throw new WorkforceError('not_found', 'No browser is open for this agent.');
    try {
      await steerBrowser(agentId, view, input, this.log());
      if (input.window === 'show') this.deps.browser.takeovers.start(agentId); // the real window is the person's now
    } finally {
      const watch = this.watches.get(agentId);
      if (watch) this.sync(watch);
    }
    return (await this.current(agentId)).state;
  }

  /** The person's input on the shown tab `tab`: turns the takeover on and goes to the page through the screencast's session. */
  async input(agentId: string, tab: string, input: BrowserInput): Promise<void> {
    const watch = this.watches.get(agentId);
    if (watch) await watch.chain;
    const view = this.deps.browser.viewOf(agentId);
    if (!view) throw new WorkforceError('not_found', 'No browser is open for this agent.');
    const { cdp, page } = watch ?? {};
    if (!watch || !cdp || !page) throw new WorkforceError('unavailable', 'The live view of this browser is not running. Open it again.');
    if (watch.tab !== tab || page !== view.active) throw new WorkforceError('conflict', 'The browser shows another tab now. Look again, then click or type.');
    const takeovers = this.deps.browser.takeovers;
    if (takeovers.start(agentId)) this.sync(watch);
    if (sendsForm(input)) takeovers.keep(agentId, hostOf(page.url()), await passwordValues(page)); // before the field empties
    view.steer(page);
    const meta = watch.meta;
    const next = (watch.inputs ?? Promise.resolve()).catch(() => undefined).then(() => sendInput(cdp, input, meta));
    watch.inputs = next;
    await next;
  }

  /** Take over (`url` opens a closed browser there) or hand back (the agent is woken unless `wake` is false). */
  async takeover(agentId: string, request: BrowserTakeoverRequest): Promise<BrowserViewState> {
    const { browser } = this.deps;
    if (request.on) {
      if (!browser.isOpen(agentId)) {
        if (!request.url) throw new WorkforceError('not_found', 'No browser is open for this agent.');
        await browser.openForPerson(agentId, request.url);
      }
      browser.takeovers.start(agentId);
    } else {
      browser.takeovers.end(agentId, request.wake !== false);
    }
    const watch = this.watches.get(agentId);
    if (watch) this.sync(watch);
    return (await this.current(agentId)).state;
  }

  // ------------------------------------------------------------------ internals

  private changed(agentId: string, why: BrowserChange): void {
    if (why === 'open' || why === 'close') this.deps.services().bus.emit('browser.sessions', { open: this.deps.browser.agents() });
    const watch = this.watches.get(agentId);
    if (!watch) return;
    watch.failed = undefined; // a failed start is tried again after the agent's next step, never in a loop
    this.sync(watch);
  }

  private sync(watch: Watch): void {
    watch.chain = watch.chain.then(() => this.apply(watch)).catch((error: unknown) => {
      this.log()?.debug('browser view update failed', { agentId: watch.agentId, error: String(error) });
    });
  }

  private async apply(watch: Watch): Promise<void> {
    const view = this.deps.browser.viewOf(watch.agentId);
    const target = watch.leases > 0 ? view?.active : undefined;
    if (watch.page !== target) {
      await this.stop(watch);
      if (target && view && watch.failed !== target) await this.start(watch, view, target);
    }
    if (watch.leases === 0 && !watch.cdp) {
      if (this.watches.get(watch.agentId) === watch) this.watches.delete(watch.agentId);
      return;
    }
    const state = await this.build(watch.agentId, view, watch);
    if (watch.state.at !== 0 && JSON.stringify({ ...state, at: 0 }) === JSON.stringify({ ...watch.state, at: 0 })) return;
    watch.state = state;
    this.deps.services().bus.emit('browser.view', state);
  }

  private async build(agentId: string, view: ViewSession | undefined, watch?: Watch): Promise<BrowserViewState> {
    const at = this.now();
    if (!view) return { agentId, open: false, tabs: [], live: false, at };
    const clean = (text: string) => this.deps.services().secrets.redact(text);
    const tabs = await Promise.all(view.tabs.slice(0, MAX_TABS).map(async ({ page, tab }) => ({ tab, url: clean(page.url()), title: clean(await titleWithin(page)), active: page === view.active })));
    const state: BrowserViewState = { agentId, open: true, tabs, tab: view.tabs.find((entry) => entry.page === view.active)?.tab, live: Boolean(watch?.cdp), at };
    if (view.shown) state.shown = true;
    if (watch?.error) state.error = watch.error;
    const takeover = this.deps.browser.takeovers.state(agentId);
    if (takeover) state.takeover = takeover;
    return state;
  }

  private async start(watch: Watch, view: ViewSession, page: PageLike): Promise<void> {
    if (!view.context.newCDPSession) { watch.failed = page; watch.error = NO_LIVE; return; }
    try {
      const cdp = await view.context.newCDPSession(page);
      const onFrame = (event: ScreencastFrame) => this.onFrame(watch, cdp, event);
      const onNavigated = (event: { frame?: { parentId?: string } }) => { if (!event?.frame?.parentId) this.sync(watch); };
      cdp.on('Page.screencastFrame', onFrame);
      cdp.on('Page.frameNavigated', onNavigated);
      Object.assign(watch, { cdp, page, tab: view.tabs.find((entry) => entry.page === page)?.tab, failed: undefined, error: undefined, detach: () => { cdp.off('Page.screencastFrame', onFrame); cdp.off('Page.frameNavigated', onNavigated); } });
      await cdp.send('Page.enable');
      await cdp.send('Page.startScreencast', SCREENCAST);
    } catch (error) {
      this.log()?.debug('browser live view could not start', { agentId: watch.agentId, error: String(error).split('\n')[0] });
      await this.stop(watch);
      watch.failed = page;
      watch.error = 'The live view could not start for this tab.';
    }
  }

  private async stop(watch: Watch): Promise<void> {
    const cdp = watch.cdp;
    watch.detach?.();
    Object.assign(watch, { cdp: undefined, page: undefined, tab: undefined, detach: undefined, pending: undefined, meta: undefined, inputs: undefined });
    if (watch.timer !== undefined) { this.clearTimer(watch.timer); watch.timer = undefined; }
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  private onFrame(watch: Watch, cdp: CdpSessionLike, event: ScreencastFrame): void {
    if (typeof event?.sessionId === 'number') void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    if (watch.cdp !== cdp || typeof event.data !== 'string' || !watch.tab) return;
    watch.meta = frameMeta(event.metadata) ?? watch.meta;
    const size = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
    this.offer(watch, { agentId: watch.agentId, tab: watch.tab, data: event.data, width: size(event.metadata?.deviceWidth), height: size(event.metadata?.deviceHeight), at: this.now() });
  }

  /** Passes `frame` on now, or keeps it as the newest for the next slot (≤ 1 per FRAME_GAP_MS). */
  private offer(watch: Watch, frame: BrowserFrame): void {
    const wait = watch.lastAt + FRAME_GAP_MS - this.now();
    if (watch.timer === undefined && wait <= 0) { this.pass(watch, frame); return; }
    watch.pending = frame;
    if (watch.timer !== undefined) return;
    watch.timer = this.setTimer(() => {
      watch.timer = undefined;
      const next = watch.pending;
      watch.pending = undefined;
      if (next && watch.page) this.pass(watch, next);
    }, Math.max(wait, 0));
  }

  private pass(watch: Watch, frame: BrowserFrame): void {
    watch.frame = frame;
    watch.lastAt = this.now();
    this.deps.services().bus.emit('browser.frame', frame);
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms).unref();
  }

  private clearTimer(handle: unknown): void {
    if (handle !== undefined) (this.deps.clearTimer ?? ((value: unknown) => clearTimeout(value as ReturnType<typeof setTimeout>)))(handle);
  }

  private log(): ViewServices['log'] | undefined {
    try { return this.deps.services().log; } catch { return undefined; }
  }
}

// ------------------------------------------------------------------ per runtime

const bound = new WeakMap<object, BrowserView>();

/** This runtime's live view (rpc/handlers/browser.ts); unavailable until startBrowserView ran. */
export function browserViewOf(services: object): BrowserView {
  const view = bound.get(services);
  if (!view) throw new WorkforceError('unavailable', 'The browser live view is not available in this runtime.');
  return view;
}

/** Creates the live view for `browser`, binds it to the runtime's services and wires the takeover's end (vault, wake). */
export function startBrowserView(services: () => RuntimeServices, browser: BrowserService): BrowserView {
  const view = new BrowserView({ browser, services });
  bound.set(services(), view);
  browser.takeovers.onEnd((event) => {
    const s = services();
    void keepPasswords(s, event.agentId, event.passwords)
      .catch((error: unknown) => { s.log.warn('passwords from a browser takeover not kept', { agentId: event.agentId, error: String(error).split('\n')[0] }); return 0; })
      .then((kept) => wakeAfterTakeover(s, event, kept));
  });
  return view;
}
