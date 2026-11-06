// Fakes for the browser tool tests (tools, batch, inspect, pointers): a scriptable Playwright page – its snapshot
// changes on actions, it emits console / request events, evaluate() is driven by the test (a MutationObserver
// stand-in), boxes and mouse moves are recorded – a BrowserService on it, and a tool context with a recording pointer
// hub, a vault whose use(id) answers "value-of-<id>", recorded wakes and an optional side browser host.
// Owns: these fakes only. Never: a real browser, network or display.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService, type LaunchOptions } from '../../../src/runtime/browser/service.ts';
import type { ContextLike, LocatorLike, PageLike } from '../../../src/runtime/browser/page.ts';
import { PointerHub } from '../../../src/runtime/pointers/hub.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { SideBrowserCall, SideBrowserResult } from '../../../src/shared/model/side-browser.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';

export class ScriptLocator implements LocatorLike {
  readonly page: ScriptPage;
  readonly selector: string;
  constructor(page: ScriptPage, selector: string) { this.page = page; this.selector = selector; }
  private async act(name: string, value?: unknown, options?: unknown) { this.page.actions.push({ selector: this.selector, name, value, options }); await this.page.onAction(this.selector, name, value); }
  async click(options?: { button?: string; delay?: number }) { await this.act(options?.button === 'right' ? 'right_click' : 'click', undefined, options); }
  async dblclick() { await this.act('dblclick'); }
  async fill(value: string) { await this.act('fill', value); }
  async pressSequentially(text: string) { await this.act('type', text); }
  async press(key: string) { await this.act('press', key); }
  async selectOption(values: string[]) { await this.act('select', values); return values; }
  async check() { await this.act('check'); }
  async uncheck() { await this.act('uncheck'); }
  async hover() { await this.act('hover'); }
  async scrollIntoViewIfNeeded() { this.page.scrolled.push(this.selector); }
  async setInputFiles(files: string[]) { await this.act('upload', files); }
  async innerText() { return this.page.bodyText; }
  async boundingBox() { return this.page.boxes.get(this.selector) ?? null; }
  first() { return this; }
  nth() { return this; }
}

type Listener = (payload: never) => void;

export class ScriptPage implements PageLike {
  urlValue = 'about:blank';
  titleValue = '';
  snapshot = '- document';
  bodyText = '';
  closed = false;
  actions: Array<{ selector: string; name: string; value?: unknown; options?: unknown }> = [];
  scrolled: string[] = [];
  moves: Array<{ x: number; y: number }> = [];
  boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  listeners = new Map<string, Listener[]>();
  /** Runs on every element action (the test changes the page there). */
  onAction: (selector: string, name: string, value?: unknown) => Promise<void> | void = () => {};
  /** evaluate(): the test decides (default: the expression's text back). */
  onEvaluate: (expression: string) => Promise<unknown> = async (expression) => expression;
  evaluated: string[] = [];
  loadStates: string[] = [];
  onLoadState: (state: string) => Promise<void> = async () => {};
  url() { return this.urlValue; }
  async title() { return this.titleValue; }
  async goto(url: string) { this.urlValue = url; this.titleValue = 'Example'; }
  async goBack() {} async goForward() {} async reload() {}
  async ariaSnapshot() { return this.snapshot; }
  locator(selector: string) { return new ScriptLocator(this, selector); }
  getByRole(role: string, options?: { name?: string }) { return new ScriptLocator(this, `role=${role}${options?.name ? `[name="${options.name}"]` : ''}`); }
  getByText(text: string) { return new ScriptLocator(this, `text=${text}`); }
  getByLabel(text: string) { return new ScriptLocator(this, `label=${text}`); }
  getByPlaceholder(text: string) { return new ScriptLocator(this, `placeholder=${text}`); }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff]); }
  async waitForLoadState(state?: string) { this.loadStates.push(state ?? 'load'); await this.onLoadState(state ?? 'load'); }
  async bringToFront() {}
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  keyboard = { press: async (key: string) => { this.actions.push({ selector: 'keyboard', name: 'press', value: key }); } };
  mouse = {
    wheel: async (_x: number, y: number) => { this.actions.push({ selector: 'mouse', name: 'wheel', value: y }); },
    move: async (x: number, y: number) => { this.moves.push({ x, y }); },
  };
  on(event: string, listener: Listener) { (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(listener); }
  emit(event: string, payload: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(payload as never); }
  async evaluate(expression: string) { this.evaluated.push(expression); return this.onEvaluate(expression); }
  waitForURL?: PageLike['waitForURL'];
  viewportSize() { return { width: 1000, height: 600 }; }
}

export class ScriptContext implements ContextLike {
  list: ScriptPage[] = [new ScriptPage()];
  closed = false;
  private closeListeners: Array<() => void> = [];
  private pageListeners: Array<(page: PageLike) => void> = [];
  pages() { return this.list; }
  async newPage() { const page = new ScriptPage(); this.list.push(page); for (const fn of this.pageListeners) fn(page); return page; }
  async close() { this.closed = true; for (const fn of this.closeListeners) fn(); }
  on(event: 'close' | 'page', listener: never) {
    if (event === 'close') this.closeListeners.push(listener as () => void);
    else this.pageListeners.push(listener as (page: PageLike) => void);
  }
  setDefaultTimeout() {}
}

const roots: string[] = [];
export function cleanupB055(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A BrowserService on script contexts (settle 0); `launches` records each profile folder. */
export function scriptBrowser() {
  const data = mkdtempSync(path.join(os.tmpdir(), 'wf-b055-'));
  roots.push(data);
  const contexts: ScriptContext[] = [];
  const launches: Array<{ dir: string; options: LaunchOptions }> = [];
  const browser = new BrowserService({
    paths: { data, workspace: path.join(data, 'work') }, log: new MemoryLogger(), channel: () => 'msedge', settleMs: 0,
    launcher: async (dir, options) => { launches.push({ dir, options }); const context = new ScriptContext(); contexts.push(context); return context; },
  });
  return { browser, contexts, launches, data, page: (n = 0) => contexts[n]!.list[0]! };
}

export interface Notified { kind: string; title: string; body: string; conversationId?: string }

/** A tool context on this PC with a pointer hub, notifications and (optionally) the side browser host op. */
export function toolCtx(options: { conversationId?: string; side?: (call: SideBrowserCall) => Promise<SideBrowserResult>; deviceId?: string; fromPc?: string; now?: () => number } = {}) {
  const notified: Notified[] = [];
  const sideCalls: SideBrowserCall[] = [];
  const woken: unknown[] = [];
  let at = 1_000_000;
  const now = options.now ?? (() => at);
  const pointers = new PointerHub({ now });
  const services = {
    devices: { self: () => ({ id: 'pc_here', name: 'Tower' }) },
    host: options.side ? { sideBrowser: (call: SideBrowserCall) => { sideCalls.push(call); return options.side!(call); } } : {},
    pointers,
    notifications: { notify: (input: Notified) => { notified.push(input); } },
    clock: { now },
    secrets: { redact: (text: string) => text, use: async (id: string) => `value-of-${id}` },
    wakes: { wake: (request: unknown) => { woken.push(request); } },
  } as unknown as RuntimeServices;
  const ctx = {
    agent: { id: 'ag_ada', name: 'Ada' }, runId: 'run_1', mode: 'browser', services, signal: new AbortController().signal, status: () => undefined,
    ...('conversationId' in options ? (options.conversationId ? { conversationId: options.conversationId } : {}) : { conversationId: 'ch_1' }),
    ...(options.deviceId ? { deviceId: options.deviceId } : {}), ...(options.fromPc ? { fromPc: options.fromPc } : {}),
  } as unknown as ToolContext;
  return { ctx, services, notified, sideCalls, woken, pointers, advance: (ms: number) => { at += ms; } };
}

/** The first text of a tool output. */
export const textOf = (output: { content: Array<{ type: string; text?: string }> }) => output.content.find((part) => part.type === 'text')?.text ?? '';
