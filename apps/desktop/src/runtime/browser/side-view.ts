// A side-browser tab of this PC watched from another of the person's PCs or from their phone (B-076): one entry per
// tab while pulls hold it. Every pull renews the cast in main (host sideCast on – at most once per RENEW_MS; the last
// release turns it off), which keeps the page awake and painting; main's frames and page changes arrive as 'side-view'
// messages (entry-electron.ts → update). Pulls are FramePulls (view-pull.ts) keyed by tab: the owner here and a linked
// PC passing on its owner get a frame every OWNER_FRAME_GAP_MS at most, a phone every DEVICE_FRAME_GAP_MS. The
// watcher's input is mapped onto the newest frame's viewport (view-input.ts, the tab's zoom applied) and goes to main
// as DevTools Input commands, one input at a time per tab. A dialog the page opens (alert, confirm …) is part of the
// state (`dialog`) and the watcher answers it through nav. Also the param checks the RPC handlers and the mesh share.
// Owns: the entries, their state and newest frame, the renewals and the input order. Never: polls, keeps a frame of a
// tab nobody watches, or logs or keeps what is typed.

import { WorkforceError } from '../../shared/errors.ts';
import { DEVICE_FRAME_GAP_MS, PULL_DEFAULT_BYTES, PULL_MAX_BYTES, PULL_MIN_BYTES, PULL_WAIT_MAX_MS, type BrowserInput } from '../../shared/model/browser.ts';
import { SIDE_TAB_ID, type SideCastUpdate, type SideDialog, type SideFrame, type SideFrameMeta, type SidePage, type SidePull, type SideViewState } from '../../shared/model/side-view.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Host } from '../host.ts';
import { input as paramsOf, num, obj, onlyKeys, optNum, type Obj } from '../rpc/params.ts';
import { frameMeta, inputCommands, type FrameMeta } from './view-input.ts';
import { FramePulls, OWNER_CALLER, OWNER_FRAME_GAP_MS, type PullTimers } from './view-pull.ts';

/** A pull renews the cast at most this often (each renewal wakes the page in main). */
export const RENEW_MS = 2000;
const NO_HOST = 'Websites of the side browser run only where the app window can open.';
const MAX_AT = Number.MAX_SAFE_INTEGER;

export interface SideViewDeps {
  /** Main's side view ops; undefined on a headless host. */
  host(): Host['sideView'];
  /** This PC's name (the watcher's mark: "on office-pc"). */
  pc(): string;
  timers?: PullTimers;
}

interface Entry {
  tab: string;
  leases: number;
  state: SideViewState;
  frame?: SideFrame;
  meta?: FrameMeta;
  renewedAt: number;
  /** The first renewal's answer: the first pull waits for it, so it has the page or the reason. */
  ready?: Promise<void>;
  inputs: Promise<void>;
  wakes: Set<() => void>;
}

/** The watcher's caller key and frame gap: here 'owner' or a phone's id; from a linked PC its id with its caller there (`via`). */
export function sideCaller(local: string, via?: string): { caller: string; gapMs: number } {
  const who = via ?? local;
  return { caller: via === undefined ? local : `${local}/${via}`, gapMs: who === OWNER_CALLER ? OWNER_FRAME_GAP_MS : DEVICE_FRAME_GAP_MS };
}

/** A frame's viewport for the click mapping, in the page's CSS pixels (a zoomed tab's are larger than its DIP). */
export function sideMeta(meta: SideFrameMeta): FrameMeta | undefined {
  const base = frameMeta(meta);
  const zoom = Number.isFinite(meta.zoom) && meta.zoom > 0 ? meta.zoom : 1;
  return base && { width: base.width / zoom, height: base.height / zoom, offsetTop: base.offsetTop / zoom, scale: base.scale };
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'The live picture of this tab could not start.');
/** The page's open dialog as main named it (type and a short message), else none. */
export function dialogOf(value: unknown): SideDialog | undefined {
  const dialog = value as Partial<SideDialog> | null | undefined;
  return dialog && typeof dialog === 'object' && typeof dialog.type === 'string' ? { type: text(dialog.type, 20), message: text(dialog.message, 300) } : undefined;
}

export class SideViews {
  private readonly deps: SideViewDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly pulls: FramePulls<SideViewState, SideFrame>;
  private readonly timers: Pick<PullTimers, 'now'>;
  private last = 0;

  constructor(deps: SideViewDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? { now: () => Date.now() };
    this.pulls = new FramePulls((tab, wake) => this.onChange(tab, wake), deps.timers);
  }

  /** One pull of `caller` (sideCaller) for the tab. */
  pull(who: { caller: string; gapMs: number }, request: SidePullParams, signal: AbortSignal): Promise<SidePull> {
    return this.pulls.pull(who.caller, request.tab, this, { after: request.after, maxBytes: request.maxBytes, waitMs: request.waitMs, gapMs: who.gapMs }, signal);
  }

  part(caller: string, tab: string, at: number, index: number): { data: string } {
    return this.pulls.part(caller, tab, at, index);
  }

  /** Holds the tab's cast (FramePulls calls it per pull); returns the release. */
  watch(tab: string): () => void {
    let entry = this.entries.get(tab);
    if (!entry) {
      entry = { tab, leases: 0, state: this.blank(tab), renewedAt: Number.NEGATIVE_INFINITY, inputs: Promise.resolve(), wakes: new Set() };
      this.entries.set(tab, entry);
    }
    const own = entry;
    own.leases++;
    this.renew(own);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--own.leases > 0) return;
      if (this.entries.get(tab) === own) this.entries.delete(tab);
      void this.deps.host()?.cast({ tab, on: false }).catch(() => undefined);
    };
  }

  async current(tab: string): Promise<{ state: SideViewState; frame?: SideFrame }> {
    const entry = this.entries.get(tab);
    if (!entry) return { state: this.blank(tab) };
    await entry.ready;
    return { state: entry.state, frame: entry.frame };
  }

  /** Main's frame or page change of a cast tab (dropped when nobody here watches it any more). */
  update(update: SideCastUpdate): void {
    const entry = this.entries.get(update.tab);
    if (!entry) return;
    const page: Partial<SidePage> = update.page ?? {};
    this.set(entry, {
      url: text(page.url, 8192), title: text(page.title, 500), back: page.back === true, forward: page.forward === true, loading: page.loading === true,
      dialog: dialogOf(page.dialog), open: true, live: update.live === true, error: update.error ? text(update.error, 300) : undefined,
    }, false);
    const meta = update.frame && typeof update.frame.data === 'string' ? sideMeta(update.frame.meta ?? ({} as SideFrameMeta)) : undefined;
    if (meta && update.frame) {
      entry.meta = meta;
      const size = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
      entry.frame = { tab: entry.tab, data: update.frame.data, width: size(update.frame.meta.deviceWidth), height: size(update.frame.meta.deviceHeight), at: this.stamp() };
    }
    this.wake(entry);
  }

  /** The watcher's input on the tab's newest frame, after the ones before it. */
  async input(tab: string, input: BrowserInput): Promise<void> {
    const host = this.deps.host();
    if (!host) throw new WorkforceError('unavailable', NO_HOST);
    const entry = this.entries.get(tab);
    const commands = inputCommands(input, entry?.meta); // a click needs a picture to land on
    const send = () => host.input({ tab, commands }).then(() => undefined);
    if (!entry) return send();
    const next = entry.inputs.catch(() => undefined).then(send);
    entry.inputs = next;
    await next;
  }

  /** A new address, back, forward, reload or the answer to the page's dialog on the tab. */
  async nav(tab: string, nav: SideNavParams): Promise<void> {
    const host = this.deps.host();
    if (!host) throw new WorkforceError('unavailable', NO_HOST);
    await host.nav({ tab, ...nav });
  }

  // ------------------------------------------------------------------ internals

  private renew(entry: Entry): void {
    const now = this.timers.now();
    if (now - entry.renewedAt < RENEW_MS) return;
    entry.renewedAt = now;
    const host = this.deps.host();
    const run = !host
      ? Promise.resolve(this.set(entry, { open: false, live: false, error: NO_HOST }))
      : host.cast({ tab: entry.tab, on: true }).then(
        (result) => this.set(entry, { ...(result.page ?? {}), dialog: dialogOf(result.page?.dialog), open: true, live: true, error: undefined }),
        (error: unknown) => this.set(entry, { open: (error as { code?: unknown })?.code !== 'not_found', live: false, error: messageOf(error) }),
      );
    entry.ready ??= run;
  }

  /** The state with `patch`; a new `at` (and a wake) only when something changed. */
  private set(entry: Entry, patch: Partial<SideViewState>, wake = true): void {
    const next: SideViewState = { ...entry.state, ...patch };
    if (next.error === undefined) delete next.error;
    if (next.dialog === undefined) delete next.dialog;
    if (JSON.stringify({ ...next, at: 0 }) === JSON.stringify({ ...entry.state, at: 0 })) return;
    entry.state = { ...next, at: this.stamp() };
    if (wake) this.wake(entry);
  }

  private wake(entry: Entry): void {
    for (const wake of [...entry.wakes]) wake();
  }

  private onChange(tab: string, wake: () => void): () => void {
    const entry = this.entries.get(tab);
    if (!entry) return () => {};
    entry.wakes.add(wake);
    return () => { entry.wakes.delete(wake); };
  }

  private blank(tab: string): SideViewState {
    let pc = '';
    try { pc = this.deps.pc(); } catch { pc = ''; }
    return { tab, pc, open: true, live: false, url: '', title: '', back: false, forward: false, loading: false, at: 0 };
  }

  /** Strictly rising stamps, so a pull never misses a change made in the same millisecond. */
  private stamp(): number {
    this.last = Math.max(this.timers.now(), this.last + 1);
    return this.last;
  }
}

// ------------------------------------------------------------------ params (RPC handlers and mesh methods)

export interface SidePullParams { tab: string; after?: { state?: number; frame?: number }; maxBytes?: number; waitMs?: number }

export function sideTab(o: Obj): string {
  if (typeof o.tab !== 'string' || !SIDE_TAB_ID.test(o.tab)) throw new WorkforceError('bad_request', 'tab must be a side-browser tab id (web-…).', { details: { param: 'tab' } });
  return o.tab;
}

/** {tab, after?: {state?, frame?}, maxBytes?, waitMs?} plus `extra` keys the caller reads itself. */
export function sidePullOf(params: unknown, extra: readonly string[] = []): { o: Obj; request: SidePullParams } {
  const o = paramsOf(params);
  onlyKeys(o, ['tab', 'after', 'maxBytes', 'waitMs', ...extra]);
  const request: SidePullParams = { tab: sideTab(o) };
  if (o.after !== undefined && o.after !== null) {
    const after = obj(o, 'after');
    onlyKeys(after, ['state', 'frame'], 'after');
    request.after = { state: optNum(after, 'state', { min: 0, max: MAX_AT }), frame: optNum(after, 'frame', { min: 0, max: MAX_AT }) };
  }
  request.maxBytes = optNum(o, 'maxBytes', { min: PULL_MIN_BYTES, max: PULL_MAX_BYTES }) ?? PULL_DEFAULT_BYTES;
  request.waitMs = optNum(o, 'waitMs', { min: 1000, max: PULL_WAIT_MAX_MS });
  return { o, request };
}

/** {tab, at, index} plus `extra` keys. */
export function sidePartOf(params: unknown, extra: readonly string[] = []): { o: Obj; tab: string; at: number; index: number } {
  const o = paramsOf(params);
  onlyKeys(o, ['tab', 'at', 'index', ...extra]);
  return { o, tab: sideTab(o), at: num(o, 'at', { min: 0, max: MAX_AT }), index: num(o, 'index', { min: 0, max: 1000 }) };
}

export interface SideNavParams { url?: string; action?: 'back' | 'forward' | 'reload'; dialog?: 'accept' | 'dismiss' }

/** Exactly one of url (an address, up to 2000 characters, one line), action (back, forward, reload) or dialog (accept, dismiss). */
export function sideNavOf(o: Obj): SideNavParams {
  const given = ['url', 'action', 'dialog'].filter((key) => o[key] !== undefined && o[key] !== null);
  if (given.length !== 1) throw new WorkforceError('bad_request', 'Give exactly one of url, action or dialog.');
  if (typeof o.url === 'string' && o.url.trim() && o.url.length <= 2000 && !/[\r\n]/.test(o.url)) return { url: o.url.trim() };
  if (o.action === 'back' || o.action === 'forward' || o.action === 'reload') return { action: o.action };
  if (o.dialog === 'accept' || o.dialog === 'dismiss') return { dialog: o.dialog };
  throw new WorkforceError('bad_request', 'url is a web address, action back, forward or reload, dialog accept or dismiss.');
}

// ------------------------------------------------------------------ per runtime

const bound = new WeakMap<object, SideViews>();

/** This runtime's side views (created on first use, keyed by its RuntimeServices). */
export function sideViewOf(services: Pick<RuntimeServices, 'host' | 'devices'>): SideViews {
  let views = bound.get(services);
  if (!views) {
    views = new SideViews({ host: () => services.host.sideView, pc: () => services.devices.self().name });
    bound.set(services, views);
  }
  return views;
}
