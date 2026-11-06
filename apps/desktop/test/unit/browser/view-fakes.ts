// Fakes for the browser live view tests (view.test.ts, view-pull.test.ts, takeover.test.ts):
// a fake Playwright context whose pages hand out fake CDP sessions (screencast frames are pushed
// by the test, acks and commands are recorded), a recording bus, a vault redactor and manual timers.
// Owns: these fakes only. Never: a real browser, network or display.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService, type LaunchOptions } from '../../../src/runtime/browser/service.ts';
import type { CdpSessionLike, ContextLike, DownloadLike, LocatorLike, PageLike } from '../../../src/runtime/browser/page.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';

/** A tiny JPEG-looking base64 string (starts like every JPEG: FF D8 FF). */
export const JPEG = (n: number) => `/9j/${'A'.repeat(4 + n)}`;

export class FakeCdp implements CdpSessionLike {
  readonly page: FakePage;
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = false;
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();
  constructor(page: FakePage) { this.page = page; }
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    if (this.page.failCdp) throw new Error('Target closed');
    return method === 'Browser.getWindowForTarget' ? { windowId: 7, bounds: {} } : {};
  }
  on(event: string, listener: (payload: never) => void) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener); }
  off(event: string, listener: (payload: never) => void) { this.listeners.get(event)?.delete(listener); }
  async detach() { this.detached = true; }
  emit(event: string, payload: unknown) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload as never); }
  /** Chrome pushes one screencast frame. */
  frame(sessionId: number, data = JPEG(sessionId)) { this.emit('Page.screencastFrame', { data, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 720 } }); }
  methods() { return this.sent.map((entry) => entry.method); }
  acks() { return this.sent.filter((entry) => entry.method === 'Page.screencastFrameAck').map((entry) => entry.params?.sessionId); }
  listening(event: string) { return (this.listeners.get(event)?.size ?? 0) > 0; }
}

class FakeLocator implements LocatorLike {
  readonly page: FakePage;
  readonly selector: string;
  constructor(page: FakePage, selector: string) { this.page = page; this.selector = selector; }
  private async act(name: string, value?: unknown) { this.page.actions.push({ selector: this.selector, name, value }); await this.page.onAction(this.selector, name, value); }
  async click() { await this.act('click'); }
  async dblclick() { await this.act('dblclick'); }
  async fill(value: string) { await this.act('fill', value); }
  async pressSequentially(value: string) { await this.act('type', value); }
  async press(key: string) { await this.act('press', key); }
  async selectOption(values: string[]) { await this.act('select', values); return values; }
  async check() { await this.act('check'); }
  async uncheck() { await this.act('uncheck'); }
  async hover() { await this.act('hover'); }
  async scrollIntoViewIfNeeded() { await this.act('scroll'); }
  async setInputFiles(files: string[]) { await this.act('upload', files); }
  async innerText() { return ''; }
  first() { return this; }
  nth() { return this; }
}

export class FakePage implements PageLike {
  urlValue = 'about:blank';
  titleValue = '';
  closed = false;
  failCdp = false;
  fronted = 0;
  actions: Array<{ selector: string; name: string; value?: unknown }> = [];
  navigations: string[] = [];
  onAction: (selector: string, name: string, value?: unknown) => Promise<void> | void = () => {};
  url() { return this.urlValue; }
  async title() { return this.titleValue; }
  async goto(url: string) { this.navigations.push(url); this.urlValue = url; this.titleValue = new URL(url).hostname; }
  async goBack() { this.navigations.push('back'); }
  async goForward() { this.navigations.push('forward'); }
  async reload() { this.navigations.push('reload'); }
  async ariaSnapshot() { return '- button "Send" [ref=e2]'; }
  locator(selector: string) { return new FakeLocator(this, selector); }
  getByRole(role: string) { return new FakeLocator(this, `role=${role}`); }
  getByText(value: string) { return new FakeLocator(this, `text=${value}`); }
  getByLabel(value: string) { return new FakeLocator(this, `label=${value}`); }
  getByPlaceholder(value: string) { return new FakeLocator(this, `placeholder=${value}`); }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff]); }
  async waitForLoadState() {}
  async bringToFront() { this.fronted++; }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  keyboard = { press: async () => {} };
  mouse = { wheel: async () => {} };
  on(_event: 'download', _listener: (download: DownloadLike) => void) {}
}

export class FakeContext implements ContextLike {
  list: FakePage[] = [new FakePage()];
  cdps: FakeCdp[] = [];
  live = true; // has newCDPSession
  private closeListeners: Array<() => void> = [];
  private pageListeners: Array<(page: PageLike) => void> = [];
  pages() { return this.list; }
  async newPage() { const page = new FakePage(); this.list.push(page); for (const fn of this.pageListeners) fn(page); return page; }
  async close() { for (const fn of this.closeListeners) fn(); }
  on(event: 'close' | 'page', listener: never) {
    if (event === 'close') this.closeListeners.push(listener as () => void);
    else this.pageListeners.push(listener as (page: PageLike) => void);
  }
  setDefaultTimeout() {}
  newCDPSession = async (page: PageLike) => {
    if (!this.live) throw new Error('not chromium');
    const cdp = new FakeCdp(page as FakePage);
    this.cdps.push(cdp);
    return cdp;
  };
}

const roots: string[] = [];
export function cleanup(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A BrowserService on the fake context (settle 0) and what its launches got. */
export function fakeBrowser(options: { idleMs?: number } = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), 'wf-view-'));
  roots.push(data);
  const contexts: FakeContext[] = [];
  const launches: LaunchOptions[] = [];
  const browser = new BrowserService({
    paths: { data, workspace: path.join(data, 'work') }, log: new MemoryLogger(), channel: () => 'msedge', settleMs: 0, idleMs: options.idleMs,
    launcher: async (_dir, options) => { launches.push(options); const context = new FakeContext(); contexts.push(context); return context; },
  });
  return { browser, contexts, launches };
}

export interface BusEvent { event: string; data: unknown }

/** The vault's redaction (secrets/redact.ts) for known `values`: each becomes its handle secret://s<n>. */
export function fakeSecrets(...values: string[]) {
  return { redact: (text: string) => values.reduce((out, value, index) => out.split(value).join(`secret://s${index + 1}`), text) };
}

export function recordingBus() {
  const events: BusEvent[] = [];
  return {
    events,
    bus: { emit: (event: string, data: unknown) => { events.push({ event, data }); }, on: () => () => undefined, onAny: () => () => undefined },
    of: <T>(name: string) => events.filter((entry) => entry.event === name).map((entry) => entry.data as T),
  };
}

/** Manual one-shot timers and a settable clock. */
export function manualTimers() {
  let at = 1000;
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    now: () => at,
    advance: (ms: number) => { at += ms; },
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    pending: () => [...timers.values()].map((timer) => timer.ms),
    /** Runs every timer that is due now (all of them: the tests advance the clock first). */
    fire: () => { const due = [...timers.entries()]; timers.clear(); for (const [, timer] of due) timer.fn(); },
  };
}

/** Lets queued promise callbacks run. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));
