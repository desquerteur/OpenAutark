// Fakes for the side driver's tests: a DevTools debugger that answers commands from handlers and
// emits events on demand, a tab's contents, the workspace browser's side surface (a shown tab per space), and a clock whose
// sleep only moves time (mouse paths replay instantly, with their times recorded).
// Owns: these fakes. Never: real pages or timers beyond the waits' own.

import { BINDING, WORLD } from '../../../src/main/side-driver/cdp.ts';
import type { AXNode } from '../../../src/main/side-driver/snapshot.ts';

type Handler = (params: any) => unknown;

export class FakeDebugger {
  attached = true;
  calls: Array<{ method: string; params: any; at: number }> = [];
  handlers: Record<string, Handler> = {};
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  clock: { now: number };

  constructor(clock: { now: number }) { this.clock = clock; }
  isAttached(): boolean { return this.attached; }
  attach(): void { this.attached = true; }
  async sendCommand(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params, at: this.clock.now });
    const handler = this.handlers[method];
    return handler ? handler(params ?? {}) : {};
  }
  on(event: string, listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }
  removeListener(event: string, listener: (...args: any[]) => void): this { this.listeners.get(event)?.delete(listener); return this; }
  /** Someone detached the debugger (DevTools took the page, the target closed). */
  detach(reason = 'canceled_by_user'): void { this.attached = false; for (const listener of [...(this.listeners.get('detach') ?? [])]) listener({}, reason); }
  /** A DevTools event from the page. */
  emit(method: string, params: unknown): void { for (const listener of [...(this.listeners.get('message') ?? [])]) listener({}, method, params); }
  /** The person's (or an echoed) input report from the driver's world in the main frame. */
  report(data: unknown, contextId = 5): void { this.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify(data), executionContextId: contextId }); }
  named(method: string): Array<{ method: string; params: any; at: number }> { return this.calls.filter((call) => call.method === method); }
  evals(prefix: string): string[] { return this.named('Runtime.evaluate').map((call) => String(call.params.expression)).filter((text) => text.startsWith(prefix)); }
}

export class FakeContents {
  readonly debugger: FakeDebugger;
  url = 'https://shop.example/cart';
  title = 'Cart';
  loading = false;
  destroyed = false;
  constructor(clock: { now: number }) { this.debugger = new FakeDebugger(clock); }
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
  getTitle(): string { return this.title; }
  isLoading(): boolean { return this.loading; }
  getZoomFactor(): number { return 1; }
  isDevToolsOpened(): boolean { return false; }
  async capturePage(): Promise<any> {
    let size = { width: 2000, height: 1600 };
    const image = { isEmpty: () => false, getSize: () => size, resize: (o: { width: number; height: number }) => { size = { width: o.width, height: o.height }; return image; }, toJPEG: () => Buffer.from('jpeg') };
    return image;
  }
}

const ax = (nodeId: string, role: string, name: string, extra: Partial<AXNode> = {}): AXNode => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

/** A small checkout page: heading, email field, a password, a checkbox, a link and the Pay button. */
export function checkoutTree(extra: AXNode[] = []): AXNode[] {
  return [
    ax('1', 'RootWebArea', 'Cart', { childIds: ['2', '3', '4', '5', '6', '7', ...extra.map((node) => node.nodeId)], backendDOMNodeId: 1 }),
    ax('2', 'heading', 'Your cart', { parentId: '1', backendDOMNodeId: 10, properties: [{ name: 'level', value: { value: 1 } }], childIds: ['2t'] }),
    ax('2t', 'StaticText', 'Your cart', { parentId: '2', backendDOMNodeId: 11 }),
    ax('3', 'textbox', 'Email', { parentId: '1', backendDOMNodeId: 20, value: { value: 'ann@example.com' } }),
    ax('4', 'textbox', 'Password', { parentId: '1', backendDOMNodeId: 21, value: { value: '••••••' } }),
    ax('5', 'checkbox', 'Keep me signed in', { parentId: '1', backendDOMNodeId: 22, properties: [{ name: 'checked', value: { value: 'true' } }] }),
    ax('6', 'link', 'Terms', { parentId: '1', backendDOMNodeId: 23, properties: [{ name: 'url', value: { value: 'https://shop.example/terms?session=abc&lang=en' } }] }),
    ax('7', 'button', 'Pay', { parentId: '1', backendDOMNodeId: 24 }),
    ...extra.map((node) => ({ ...node, parentId: '1' })),
  ];
}

/** Handlers for a tab whose driver world is context 5 in the main frame. */
export function pageHandlers(dbg: FakeDebugger, state: { tree: AXNode[]; human?: boolean; text?: string; quads?: Record<number, number[]>; stale?: Set<number> }): void {
  dbg.handlers['Page.getFrameTree'] = () => ({ frameTree: { frame: { id: 'main' } } });
  dbg.handlers['Page.addScriptToEvaluateOnNewDocument'] = () => {
    queueMicrotask(() => dbg.emit('Runtime.executionContextCreated', { context: { id: 5, name: WORLD, auxData: { frameId: 'main' } } }));
    return { identifier: '1' };
  };
  dbg.handlers['Runtime.evaluate'] = (p) => {
    const expression = String(p.expression);
    if (expression.startsWith('__wfSide.facts()')) return { result: { value: { human: state.human === true, passwords: 0 } } };
    const wanted = /^__wfSide\.text\(4000000\)\.toLowerCase\(\)\.includes\((".*")\)$/.exec(expression);
    if (wanted) return { result: { value: (state.text ?? '').toLowerCase().includes(JSON.parse(wanted[1]!)) } };
    if (expression.startsWith('__wfSide.text(')) return { result: { value: state.text ?? '' } };
    return { result: { value: true } };
  };
  dbg.handlers['Accessibility.getFullAXTree'] = () => ({ nodes: state.tree });
  dbg.handlers['DOM.resolveNode'] = (p) => {
    if (state.stale?.has(p.backendNodeId)) throw new Error('No node with given id found');
    return { object: { objectId: `obj-${p.backendNodeId}` } };
  };
  dbg.handlers['Runtime.callFunctionOn'] = (p) => {
    const fn = String(p.functionDeclaration);
    if (fn.includes('isConnected')) return { result: { value: true } };
    if (fn.includes('editable')) return { result: { value: { editable: true, disabled: false, readonly: false, direct: false } } };
    if (fn.includes('HTMLSelectElement')) return { result: { value: { picked: ['Germany'] } } };
    if (fn.includes('aria-checked')) return { result: { value: { ok: true } } };
    return { result: { value: undefined } };
  };
  dbg.handlers['DOM.getContentQuads'] = (p) => {
    const q = state.quads?.[p.backendNodeId] ?? [100, 100, 180, 100, 180, 132, 100, 132];
    return { quads: [q] };
  };
  dbg.handlers['Page.getLayoutMetrics'] = () => ({ cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } });
}

export interface FakeBrowser {
  pages: Array<{ id: string; url: string; title: string }>;
  /** The tab each space shows (the global pane and every chat's area show one at the same time). */
  active: Record<string, string>;
  contents: Map<string, FakeContents>;
  opened: string[];
  openers: unknown[];
  sideTabs(space?: string): { pages: Array<{ id: string; url: string; title: string }>; active: string | null };
  sideContents(id: string): FakeContents | undefined;
  sideOpen(url: string, opener: unknown, show?: boolean): string;
  sideClose(id: string): void;
}

export function fakeBrowser(tabs: Record<string, FakeContents>): FakeBrowser {
  const first = Object.keys(tabs)[0];
  const browser: FakeBrowser = {
    pages: Object.entries(tabs).map(([id, contents]) => ({ id, url: contents.url, title: contents.title })),
    active: first ? { global: first } : {},
    contents: new Map(Object.entries(tabs)),
    opened: [],
    openers: [],
    sideTabs: (space = 'global') => ({ pages: browser.pages, active: browser.active[space] ?? null }),
    sideContents: (id) => browser.contents.get(id),
    sideOpen: (url, opener, show) => { browser.opened.push(url); browser.openers.push({ opener, show }); throw new Error('Close a browser tab before opening another.'); },
    sideClose: (id) => { browser.pages = browser.pages.filter((page) => page.id !== id); },
  };
  return browser;
}
