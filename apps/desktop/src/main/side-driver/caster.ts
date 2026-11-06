// A side tab watched from another of the person's PCs or from their phone (B-076, host ops sideCast / sideInput /
// sideNav): the page stays here – it loads, sends and keeps its logins only on this PC – and the watcher gets its
// picture and sends input back. `sideCast on` wakes the page through the workspace browser (sideContents: a page
// nobody here looks at moves to the off-screen host, where it paints) and runs a DevTools screencast on the tab's
// shared connection (TabCdp) with the settings of the agents' live view (runtime/browser/view.ts): JPEG quality 60,
// at most 1280 px on either side, every frame acknowledged at once, at most one per CAST_FRAME_GAP_MS passed on – the
// newest – with the page's address, title and history (`send`, host bridge message 'side-view'). Each renewal keeps
// the page awake; CAST_IDLE_MS without one, or `on: false`, ends the cast. While it runs the workspace browser keeps
// the page loaded (`watched`) and the page counts as focused (its caret shows); when it ends the page may leave the host
// again (`release` – it stays there while an agent used it lately). Input is the person's own: agents wait
// (SideTab.personAt, PERSON_PRIORITY_MS) and an agent's preview tab stays (`keep`). A dialog the page opens (alert,
// confirm …) travels with the page; the watcher answers it (sideNav `dialog`), and input waits for that answer.
// Owns: the casts, their throttle and end, and the checks of these three ops. Never: imports electron, runs any
// DevTools command a watcher names other than the three Input ones and the dialog's answer, or keeps a frame or what
// is typed.

import { browserUrl } from '../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { SideCastUpdate, SideCommand, SideDialog, SidePage } from '../../shared/model/side-view.ts';
import { TAB_ID } from './validate.ts';

/** At most one frame per this many ms goes to the runtime (2 per second, like the agents' live view). */
export const CAST_FRAME_GAP_MS = 500;
/** A cast nobody renewed this long ends (the runtime renews it with every pull). */
export const CAST_IDLE_MS = 60_000;
export const CAST_MAX_SIDE = 1280;
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: CAST_MAX_SIDE, maxHeight: CAST_MAX_SIDE, everyNthFrame: 1 };
/** The only DevTools commands a watcher's input becomes. */
export const CAST_INPUT_METHODS: ReadonlySet<string> = new Set(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
const MAX_COMMANDS = 8;
const MAX_PARAMS = 8192;
const CLOSED = 'This tab is not open on its PC any more.';
const IN_DIALOG = 'The page shows a dialog – answer it first.';
const NO_PAGE: SidePage = { url: '', title: '', back: false, forward: false, loading: false };

/** The part of a tab's WebContents a cast reads (navigationHistory: Electron's, missing in fakes). */
export interface CastContents {
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  getZoomFactor?(): number;
  readonly navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean };
}

/** A side tab as the driver keeps it (side-driver/tab.ts SideTab). */
export interface CastTab {
  readonly id: string;
  readonly contents: CastContents;
  readonly cdp: { send(method: string, params?: object): Promise<any>; on(method: string, listener: (params: any) => void): () => void };
  personAt: number;
  /** The page's open dialog (the tab's own DevTools events keep it). */
  dialog?: SideDialog;
}

export interface CasterDeps {
  /** The tab with its page awake (SideDriver.side); undefined when it is not open here. */
  tab(id: string): CastTab | undefined;
  /** The person used the tab: an agent's preview tab stays as a tab of its own. */
  keep?(id: string): void;
  /** Nobody watches the tab any more: its page leaves the off-screen host unless an agent used it lately. */
  release?(id: string): void;
  /** To the runtime (best effort, only while it is up). */
  send(update: SideCastUpdate): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface ScreencastFrame { data?: unknown; sessionId?: unknown; metadata?: Record<string, unknown> }

interface Cast {
  id: string;
  tab: CastTab;
  offs: Array<() => void>;
  lastAt: number;
  pending?: ScreencastFrame;
  timer?: unknown;
  idle?: unknown;
  starting: Promise<void>;
  error?: string;
  ended: boolean;
}

function bad(what: string): never {
  throw new WorkforceError('bad_request', `Invalid side view request (${what}).`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(what);
  return value as Record<string, unknown>;
}

function tabOf(o: Record<string, unknown>): string {
  if (typeof o.tab !== 'string' || !TAB_ID.test(o.tab)) bad('tab');
  return o.tab;
}

/** sideInput's commands: 1–8, each one of the three Input methods with plain params of at most 8 KB. */
export function castCommands(value: unknown): SideCommand[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMANDS) bad('commands');
  return value.map((item) => {
    const command = record(item, 'command');
    if (typeof command.method !== 'string' || !CAST_INPUT_METHODS.has(command.method)) bad('method');
    const params = record(command.params, 'params');
    if (JSON.stringify(params).length > MAX_PARAMS) bad('params');
    return { method: command.method, params };
  });
}

/** sideNav: exactly one of an http(s) address (made absolute like the address field does), back / forward / reload, or the dialog's answer. */
export function castNav(value: unknown): { tab: string; url?: string; action?: 'back' | 'forward' | 'reload'; dialog?: 'accept' | 'dismiss' } {
  const o = record(value, 'nav');
  const tab = tabOf(o);
  const given = (key: string) => o[key] !== undefined && o[key] !== null;
  const hasUrl = given('url');
  if ([hasUrl, given('action'), given('dialog')].filter(Boolean).length !== 1) bad('url, action or dialog');
  if (given('dialog')) {
    if (o.dialog !== 'accept' && o.dialog !== 'dismiss') bad('dialog');
    return { tab, dialog: o.dialog };
  }
  if (hasUrl) {
    if (typeof o.url !== 'string') bad('url');
    try { return { tab, url: new URL(browserUrl(o.url)).href }; } catch (error) {
      throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'Use an HTTP or HTTPS address.');
    }
  }
  if (o.action !== 'back' && o.action !== 'forward' && o.action !== 'reload') bad('action');
  return { tab, action: o.action };
}

const finite = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The page as the watcher sees it named, with its open dialog. */
export function pageOf(contents: CastContents, dialog?: SideDialog): SidePage {
  if (contents.isDestroyed()) return NO_PAGE;
  const history = contents.navigationHistory;
  return {
    url: contents.getURL(), title: contents.getTitle(), back: Boolean(history?.canGoBack()), forward: Boolean(history?.canGoForward()), loading: contents.isLoading(),
    ...(dialog ? { dialog: { type: dialog.type, message: dialog.message } } : {}),
  };
}

/** A press that makes the tab the person's own (a click, a key, typed text) – moves and wheel turns do not. */
const isPress = (command: SideCommand): boolean => command.method === 'Input.insertText'
  || (command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed')
  || (command.method === 'Input.dispatchKeyEvent' && command.params.type !== 'keyUp');

export class SideCaster {
  private readonly deps: CasterDeps;
  private readonly casts = new Map<string, Cast>();

  constructor(deps: CasterDeps) {
    this.deps = deps;
  }

  /** Someone watches this tab now (the workspace browser keeps its page loaded). */
  watched(id: string): boolean { return this.casts.has(id); }

  /** sideCast: on – wake, start or renew; off – end now. */
  async cast(args: unknown): Promise<{ ok: true; page?: SidePage }> {
    const o = record(args, 'cast');
    const id = tabOf(o);
    if (typeof o.on !== 'boolean') bad('on');
    // Off with no cast left (its start failed and kept the page for the next try): the page may still leave now.
    if (!o.on) { const held = this.casts.has(id); this.stop(id); if (!held) this.deps.release?.(id); return { ok: true }; }
    const tab = this.deps.tab(id);
    if (!tab) { this.stop(id); throw new WorkforceError('not_found', CLOSED); }
    let cast = this.casts.get(id);
    if (cast && cast.tab !== tab) { this.stop(id, undefined, true); cast = undefined; } // its page was made anew: cast that one
    cast ??= this.start(id, tab);
    this.renew(cast);
    await cast.starting;
    if (cast.error) throw new WorkforceError('unavailable', cast.error);
    return { ok: true, page: pageOf(tab.contents, tab.dialog) };
  }

  /** sideInput: the watcher's input, as the person's own. */
  async input(args: unknown): Promise<{ ok: true }> {
    const o = record(args, 'input');
    const id = tabOf(o);
    const commands = castCommands(o.commands);
    const tab = this.deps.tab(id);
    if (!tab) throw new WorkforceError('not_found', CLOSED);
    if (tab.dialog) throw new WorkforceError('unavailable', IN_DIALOG); // the page takes no input until it is answered
    tab.personAt = this.now(); // the person goes first: an agent's next step there waits
    if (commands.some(isPress)) this.deps.keep?.(id);
    const cast = this.casts.get(id);
    if (cast) this.renew(cast);
    try {
      for (const command of commands) await tab.cdp.send(command.method, command.params);
    } catch {
      throw new WorkforceError('unavailable', 'The page did not take that input. Try again.'); // never the input itself
    }
    return { ok: true };
  }

  /** sideNav: a new address, back, forward, reload, or the answer to the page's dialog. */
  async nav(args: unknown): Promise<{ ok: true }> {
    const { tab: id, url, action, dialog } = castNav(args);
    const tab = this.deps.tab(id);
    if (!tab) throw new WorkforceError('not_found', CLOSED);
    tab.personAt = this.now();
    this.deps.keep?.(id);
    if (dialog) {
      if (!tab.dialog) return { ok: true }; // answered meanwhile (here, or by an agent)
      await tab.cdp.send('Page.handleJavaScriptDialog', { accept: dialog === 'accept' });
      tab.dialog = undefined;
      this.tell(id);
    } else if (tab.dialog) {
      throw new WorkforceError('unavailable', IN_DIALOG);
    } else if (url) {
      const out = await tab.cdp.send('Page.navigate', { url }) as { errorText?: string } | undefined;
      if (out?.errorText) throw new WorkforceError('unavailable', `The page could not be loaded (${out.errorText}).`);
    } else if (action === 'reload') {
      await tab.cdp.send('Page.reload');
    } else {
      const history = await tab.cdp.send('Page.getNavigationHistory') as { currentIndex?: number; entries?: Array<{ id: number }> };
      const entry = history.entries?.[finite(history.currentIndex) + (action === 'back' ? -1 : 1)];
      if (entry) await tab.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    return { ok: true };
  }

  /** Every cast ends (the runtime went away). */
  stopAll(): void {
    for (const id of [...this.casts.keys()]) this.stop(id);
  }

  // ------------------------------------------------------------------ internals

  private start(id: string, tab: CastTab): Cast {
    const cast: Cast = { id, tab, offs: [], lastAt: Number.NEGATIVE_INFINITY, starting: Promise.resolve(), ended: false };
    this.casts.set(id, cast);
    const page = () => this.tell(id, cast);
    cast.offs.push(
      tab.cdp.on('Page.screencastFrame', (event: ScreencastFrame) => this.frame(cast, event)),
      tab.cdp.on('Page.frameNavigated', (event: { frame?: { parentId?: string } }) => { if (!event?.frame?.parentId) page(); }),
      tab.cdp.on('Page.navigatedWithinDocument', page),
      tab.cdp.on('Page.loadEventFired', page),
      tab.cdp.on('Page.javascriptDialogOpening', page), // the tab's own listener (side-driver/tab.ts) noted it first
      tab.cdp.on('Page.javascriptDialogClosed', page),
    );
    cast.starting = (async () => {
      await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined); // the caret shows
      if (cast.ended) return;
      await tab.cdp.send('Page.startScreencast', SCREENCAST);
      if (cast.ended) await tab.cdp.send('Page.stopScreencast').catch(() => undefined); // stopped while it started
    })().catch((error: unknown) => {
      cast.error = error instanceof Error && error.message ? error.message.split('\n')[0]!.slice(0, 200) : 'The live picture could not start for this tab.';
      // The viewer tries again with its next pull: the page stays where it is (no host window made and destroyed each time).
      this.stop(id, cast, true);
    });
    return cast;
  }

  private renew(cast: Cast): void {
    this.clearTimer(cast.idle);
    cast.idle = this.setTimer(() => { if (this.casts.get(cast.id) === cast) this.stop(cast.id); }, CAST_IDLE_MS);
  }

  /** The page (and its dialog) to the runtime while the cast runs. */
  private tell(id: string, cast = this.casts.get(id)): void {
    if (cast && !cast.ended) this.deps.send({ tab: id, page: pageOf(cast.tab.contents, cast.tab.dialog), live: true });
  }

  /** `again`: a new cast of the tab follows at once, so its page stays where it paints. */
  private stop(id: string, only?: Cast, again = false): void {
    const cast = this.casts.get(id);
    if (!cast || (only && cast !== only)) return;
    this.casts.delete(id);
    cast.ended = true;
    for (const off of cast.offs) off();
    this.clearTimer(cast.timer);
    this.clearTimer(cast.idle);
    cast.pending = undefined;
    void cast.tab.cdp.send('Page.stopScreencast').catch(() => undefined);
    void cast.tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    if (!again) this.deps.release?.(id);
  }

  private frame(cast: Cast, event: ScreencastFrame): void {
    if (typeof event?.sessionId === 'number') void cast.tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    if (cast.ended || typeof event?.data !== 'string') return;
    const wait = cast.lastAt + CAST_FRAME_GAP_MS - this.now();
    if (cast.timer === undefined && wait <= 0) { this.pass(cast, event); return; }
    cast.pending = event; // the newest waits for the next slot
    if (cast.timer !== undefined) return;
    cast.timer = this.setTimer(() => {
      cast.timer = undefined;
      const next = cast.pending;
      cast.pending = undefined;
      if (next && !cast.ended) this.pass(cast, next);
    }, Math.max(wait, 0));
  }

  private pass(cast: Cast, event: ScreencastFrame): void {
    cast.lastAt = this.now();
    const m = event.metadata ?? {};
    const zoom = finite(cast.tab.contents.getZoomFactor?.(), 1);
    this.deps.send({
      tab: cast.id, page: pageOf(cast.tab.contents, cast.tab.dialog), live: true,
      frame: {
        data: event.data as string,
        meta: { deviceWidth: finite(m.deviceWidth), deviceHeight: finite(m.deviceHeight), offsetTop: finite(m.offsetTop), pageScaleFactor: finite(m.pageScaleFactor, 1), zoom: zoom > 0 ? zoom : 1 },
      },
    });
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  private clearTimer(handle: unknown): void {
    if (handle === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
