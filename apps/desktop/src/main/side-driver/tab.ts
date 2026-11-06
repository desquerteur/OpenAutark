// What the side driver knows about one side tab from its DevTools events – console and
// network buffers, an open page dialog, main-frame navigations (the document count refs belong to),
// loading, and the person's own input reported from the driver's isolated world. The agents' own mouse
// and key events reach that listener too (they are trusted input): points and keys the driver just
// dispatched are told apart and never count as the person's.
// Owns: the per-tab state and the person/agent input split. Never: decides what an agent may do (driver.ts).

import type { PointerAction } from '../../shared/model/pointers.ts';
import type { Point } from '../../shared/model/pointer-motion.ts';
import { BINDING, TabCdp, type ContentsLike } from './cdp.ts';
import { ConsoleLog, NetworkLog } from './logs.ts';
import type { RefInfo } from './snapshot.ts';

/** The person's report from the page: input kind, viewport CSS px (top frame only), the control under it. */
export interface PersonInput { action: PointerAction; x?: number; y?: number; target?: { role?: string; name?: string }; frame: boolean }

const OWN_POINT_MS = 1500;
const OWN_KEY_MS = 800;
const CONSOLE_RELEASE_EVERY = 100;

export class SideTab {
  readonly id: string;
  readonly cdp: TabCdp;
  readonly console = new ConsoleLog();
  readonly network = new NetworkLog();
  /** Counts main-frame documents: refs and looks belong to one. */
  doc = 0;
  /** A main-frame load runs; `domReady`: its document is parsed (DOMContentLoaded, load, or loading stopped). */
  navigating = false;
  domReady = false;
  dialog?: { type: string; message: string };
  /** When the person last used this tab (epoch ms; 0 = never since attach). */
  personAt = 0;
  /** What the latest snapshot or find said about each ref (role and name). */
  refs = new Map<string, RefInfo>();
  /** Each agent's cursor position here. */
  readonly cursors = new Map<string, Point>();
  private ownPoints: Array<{ x: number; y: number; at: number }> = [];
  private ownLast?: Point;
  private ownKeyAt = 0;
  private ownAt = 0;
  private readonly now: () => number;
  private readonly waiters = new Set<() => void>();
  private readonly mutations = new Set<() => void>();
  private onPerson: (input: PersonInput) => void;

  constructor(id: string, contents: ContentsLike, options: { now: () => number; person: (tab: SideTab, input: PersonInput) => void }) {
    this.id = id;
    this.now = options.now;
    this.onPerson = (input) => options.person(this, input);
    const cdp = (this.cdp = new TabCdp(contents));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      this.console.api(p);
      // Console arguments stay alive in the page until released: let go of them now and then.
      if (this.console.count % CONSOLE_RELEASE_EVERY === 0) void cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'console' }).catch(() => {});
    });
    cdp.on('Runtime.exceptionThrown', (p) => this.console.exception(p));
    cdp.on('Log.entryAdded', (p) => this.console.entry(p));
    cdp.on('Network.requestWillBeSent', (p) => { this.network.sent(p); this.kick(); });
    cdp.on('Network.responseReceived', (p) => this.network.response(p));
    cdp.on('Network.loadingFinished', (p) => { this.network.finished(p); this.kick(); });
    cdp.on('Network.loadingFailed', (p) => { this.network.failed(p); this.kick(); });
    cdp.on('Page.javascriptDialogOpening', (p) => { this.dialog = { type: String(p.type ?? 'alert'), message: String(p.message ?? '').slice(0, 300) }; this.kick(); });
    cdp.on('Page.javascriptDialogClosed', () => { this.dialog = undefined; this.kick(); });
    const parsed = () => { this.navigating = false; this.domReady = true; this.kick(); };
    cdp.on('Page.frameStartedLoading', (p) => { if (p.frameId === cdp.mainFrame) { this.navigating = true; this.domReady = false; this.kick(); } });
    cdp.on('Page.frameStoppedLoading', (p) => { if (p.frameId === cdp.mainFrame) parsed(); });
    cdp.on('Page.domContentEventFired', parsed);
    cdp.on('Page.loadEventFired', parsed);
    cdp.on('Page.frameNavigated', (p) => {
      if (p.frame?.parentId) return;
      this.doc += 1;
      this.domReady = false;
      this.refs.clear();
      this.dialog = undefined;
      this.console.navigated(String(p.frame?.url ?? ''));
      this.kick();
    });
    cdp.on('Page.navigatedWithinDocument', (p) => { if (p.frameId === cdp.mainFrame) this.kick(); });
    cdp.on('Runtime.bindingCalled', (p) => this.binding(p));
  }

  get contents(): ContentsLike { return this.cdp.contents; }

  /** Something happened in the page (wakes waits). */
  private kick(): void { for (const wake of [...this.waiters]) wake(); }

  /** Calls `wake` on every page event (navigation, load, dialog, network, document change) until unsubscribed. */
  onEvent(wake: () => void): () => void { this.waiters.add(wake); return () => { this.waiters.delete(wake); }; }

  /** Calls `wake` on each document change the page reports (only while a wait watches). */
  onMutation(wake: () => void): () => void { this.mutations.add(wake); return () => { this.mutations.delete(wake); }; }

  private binding(p: { name?: string; payload?: string; executionContextId?: number }): void {
    if (p.name !== BINDING || typeof p.payload !== 'string' || p.payload.length > 4000) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(p.payload) as Record<string, unknown>; } catch { return; }
    if (data.k === 'mut') { for (const wake of [...this.mutations]) wake(); this.kick(); return; }
    if (data.k !== 'in') return;
    const action = data.e === 'click' || data.e === 'type' || data.e === 'scroll' ? data.e : 'move';
    const top = typeof p.executionContextId === 'number' && this.cdp.isTopWorld(p.executionContextId) && data.frame !== 1;
    const x = typeof data.x === 'number' && Number.isFinite(data.x) ? data.x : undefined;
    const y = typeof data.y === 'number' && Number.isFinite(data.y) ? data.y : undefined;
    const key = typeof data.key === 'string' ? data.key : undefined;
    if (this.own(action, top ? x : undefined, top ? y : undefined, key)) return;
    this.personAt = this.now();
    const raw = data.target as { role?: unknown; name?: unknown } | undefined;
    const target = raw && typeof raw === 'object'
      ? { ...(typeof raw.role === 'string' && raw.role ? { role: raw.role.slice(0, 40) } : {}), ...(typeof raw.name === 'string' && raw.name ? { name: raw.name.slice(0, 80) } : {}) }
      : undefined;
    this.onPerson({ action, frame: !top, ...(top && x !== undefined && y !== undefined ? { x, y } : {}), ...(target && (target.role || target.name) ? { target } : {}) });
  }

  /** Was this input the driver's own (a point it dispatched, a key it pressed)? */
  private own(action: PointerAction, x: number | undefined, y: number | undefined, key: string | undefined): boolean {
    const now = this.now();
    if (action === 'type') return now - this.ownKeyAt < OWN_KEY_MS && key !== undefined;
    if (x === undefined || y === undefined) return now - this.ownAt < 1000;
    if (this.ownLast && Math.abs(this.ownLast.x - x) <= 1.5 && Math.abs(this.ownLast.y - y) <= 1.5) return true;
    return this.ownPoints.some((p) => now - p.at < OWN_POINT_MS && Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3);
  }

  /** The driver dispatches a mouse event at this point. */
  agentPoint(x: number, y: number): void {
    const now = this.now();
    this.ownAt = now;
    this.ownLast = { x, y };
    this.ownPoints.push({ x, y, at: now });
    if (this.ownPoints.length > 120) this.ownPoints = this.ownPoints.filter((p) => now - p.at < OWN_POINT_MS).slice(-120);
  }

  /** The driver dispatches a key. */
  agentKey(): void { this.ownKeyAt = this.now(); this.ownAt = this.ownKeyAt; }

  private watching = 0;
  private watchedDoc = -1;

  /** Document changes are reported while at least one wait watches (re-armed on a new document). */
  async watch(on: boolean): Promise<void> {
    this.watching = Math.max(0, this.watching + (on ? 1 : -1));
    await this.rewatch();
  }

  /** After a navigation the new document starts unwatched: switch it on again while someone waits. */
  async rewatch(): Promise<void> {
    const want = this.watching > 0;
    if (want && this.watchedDoc === this.doc) return;
    this.watchedDoc = want ? this.doc : -1;
    await this.cdp.inWorld(`__wfSide.watch(${want})`).catch(() => { this.watchedDoc = -1; });
  }

  /** Did the person use this tab within `ms`? */
  personActive(ms = 2000): boolean { return this.personAt > 0 && this.now() - this.personAt < ms; }

  dispose(): void {
    this.waiters.clear();
    this.mutations.clear();
    this.cdp.dispose();
  }
}
