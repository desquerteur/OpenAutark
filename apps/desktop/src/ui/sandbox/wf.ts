// In-sandbox helper `wf` for ```app mini-tools (web-genui.md §7.9). Built to app/ui/sandbox/wf.js
// and auto-included in every app frame (served from wf-sandbox://lib, CSP connect-src 'none').
// Owns: the app side of the MCP Apps bridge (src/shared/blocks/app-bridge.ts): initialize,
// theme tokens on :root, events, to-do completion, file hand-back (wf.upload posts the Blob
// itself – a structured-clone handle, no base64 over the bridge), prompts, persisted state,
// charts, mermaid, fullscreen request and auto-height; in a view of <data>/pages also the app's RPC and events (wf.rpc, wf.listen).
// Never: touches the network, reads parent DOM, or claims to approve anything – every call is
// an ordinary "via mini-app" event the host may rate-limit or refuse.

import { APP_BRIDGE_PROTOCOL, APP_METHODS, APP_TOOLS } from '../../shared/blocks/app-bridge.ts';
import type { AppHostContext, AppInitializeResult } from '../../shared/blocks/app-bridge.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(data: unknown) => void>>();
let nextId = 1;
let context: AppHostContext = { theme: 'light' };

function post(message: Record<string, unknown>): void {
  // Opaque-origin frame: the host checks event.source, so '*' is the only usable target.
  window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
}

function request(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });
}

function notify(method: string, params?: unknown): void {
  post({ method, params });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await request(APP_METHODS.toolsCall, { name, arguments: args })) as
    { structuredContent?: Record<string, unknown>; isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'Host refused the call');
  return result?.structuredContent ?? {};
}

function emit(event: string, data: unknown): void {
  for (const fn of listeners.get(event) ?? []) {
    try { fn(data); } catch (error) { console.error(error); }
  }
}

function applyContext(next: AppHostContext): void {
  context = { ...context, ...next };
  const root = document.documentElement;
  for (const [key, value] of Object.entries(context.styles?.variables ?? {})) root.style.setProperty(key, value);
  root.dataset.theme = context.theme;
  root.style.colorScheme = context.theme;
  emit('theme', context);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const frame = event.data as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
  if (!frame || typeof frame !== 'object') return;
  if (typeof frame.id === 'number' && !frame.method) {
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(frame.error.message ?? 'Bridge error'));
    else waiter.resolve(frame.result);
    return;
  }
  // Heartbeat of the host's CPU watchdog: answering proves this frame's thread is not stuck.
  if (frame.method === APP_METHODS.ping && frame.id !== undefined) { post({ id: frame.id, result: {} }); return; }
  if (frame.method === APP_METHODS.hostContextChanged) applyContext(frame.params as AppHostContext);
  else if (frame.method) emit(frame.method, frame.params);
});

// ------------------------------------------------------------------ auto-height

let lastHeight = 0;
function reportSize(): void {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  notify(APP_METHODS.sizeChanged, { width: document.documentElement.clientWidth, height });
}

// ------------------------------------------------------------------ tiny SVG charts

export interface ChartSpec {
  kind: 'bar' | 'line' | 'area' | 'donut';
  data: Array<Record<string, unknown>>;
  x: string;
  y: string | string[];
  unit?: string;
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function drawChart(target: Element, spec: ChartSpec): void {
  const W = 320, H = 160, pad = 24;
  const series = Array.isArray(spec.y) ? spec.y : [spec.y];
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img' });
  const color = (i: number) => `var(--wf-c${(i % 6) + 1}, currentColor)`;
  const values = spec.data.map((row) => series.map((key) => Number(row[key]) || 0));
  if (spec.kind === 'donut') {
    const total = values.reduce((sum, row) => sum + row[0], 0) || 1;
    let angle = -Math.PI / 2;
    values.forEach((row, i) => {
      const slice = (row[0] / total) * Math.PI * 2;
      const r = 60, cx = W / 2, cy = H / 2;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      angle += slice;
      const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
      svg.append(svgEl('path', { d: `M${x1} ${y1} A${r} ${r} 0 ${slice > Math.PI ? 1 : 0} 1 ${x2} ${y2}`, fill: 'none', stroke: color(i), 'stroke-width': 18 }));
    });
  } else {
    const max = Math.max(1, ...values.flat());
    const n = Math.max(1, values.length);
    const step = (W - pad * 2) / n;
    const yOf = (v: number) => H - pad - (v / max) * (H - pad * 2);
    series.forEach((_key, s) => {
      if (spec.kind === 'bar') {
        const width = step / series.length - 4;
        values.forEach((row, i) => svg.append(svgEl('rect', {
          x: pad + i * step + s * (width + 2), y: yOf(row[s]), width: Math.max(1, width), height: H - pad - yOf(row[s]), rx: 2, fill: color(s),
        })));
      } else {
        const points = values.map((row, i) => `${pad + i * step + step / 2},${yOf(row[s])}`);
        if (spec.kind === 'area') svg.append(svgEl('polygon', { points: `${pad + step / 2},${H - pad} ${points.join(' ')} ${pad + (n - 0.5) * step},${H - pad}`, fill: color(s), opacity: 0.2 }));
        svg.append(svgEl('polyline', { points: points.join(' '), fill: 'none', stroke: color(s), 'stroke-width': 2 }));
      }
    });
    spec.data.forEach((row, i) => {
      const label = svgEl('text', { x: pad + i * step + step / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--wf-muted, currentColor)' });
      label.textContent = String(row[spec.x] ?? '');
      svg.append(label);
    });
  }
  target.replaceChildren(svg);
  reportSize();
}

// ------------------------------------------------------------------ public API

let readyResolve: (ctx: AppHostContext) => void = () => {};
const ready = new Promise<AppHostContext>((resolve) => { readyResolve = resolve; });

const wf = {
  ready,
  /** Current host context; `theme` is also applied as --wf-* variables on :root. */
  get theme(): AppHostContext { return context; },
  on(event: 'theme' | string, fn: (data: unknown) => void): () => void {
    const set = listeners.get(event) ?? new Set();
    set.add(fn);
    listeners.set(event, set);
    return () => set.delete(fn);
  },
  /** Send a named event with data to the authoring agent (arrives as [ui-event …]). */
  send(name: string, data?: Json): Promise<Record<string, unknown>> {
    return callTool(APP_TOOLS.event, { name, data: data ?? null });
  },
  /** Resolve the to-do this app belongs to with a result. */
  complete(data?: Json): Promise<Record<string, unknown>> {
    return callTool(APP_TOOLS.complete, { data: data ?? null });
  },
  /**
   * Store a recording, image or document for the agent (to-do apps only; the host checks type and
   * size). Put the result into wf.complete(data) – the file then arrives attached to the answer.
   */
  async upload(data: Blob | ArrayBuffer | ArrayBufferView, name?: string): Promise<{ fileId: string; name: string; mime: string; size: number }> {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
    const fileName = name ?? (typeof File !== 'undefined' && data instanceof File ? data.name : undefined);
    const result = await callTool(APP_TOOLS.upload, { data: blob, name: fileName });
    return { fileId: String(result.fileId ?? ''), name: String(result.name ?? ''), mime: String(result.mime ?? ''), size: Number(result.size ?? 0) };
  },
  /** Opens the host recorder; only the human can start, record and send. To-do apps only. */
  async record(options: { mode?: 'audio' | 'video'; maxSeconds?: number; script?: string } = {}): Promise<{ fileId: string; name: string; mime: string; size: number }> {
    const result = await callTool(APP_TOOLS.record, options);
    return { fileId: String(result.fileId ?? ''), name: String(result.name ?? ''), mime: String(result.mime ?? ''), size: Number(result.size ?? 0) };
  },
  /** A view in <data>/pages: one call of the app's RPC (`rpc.methods` lists them); rejects with the app's message. */
  async rpc<T = unknown>(method: string, params?: Json): Promise<T> {
    return (await callTool(APP_TOOLS.rpc, { method, params: params ?? null })).result as T;
  },
  /** A view in <data>/pages: `fn` hears one of the app's events. */
  async listen(event: string, fn: (data: unknown) => void): Promise<() => void> {
    const off = wf.on(`event/${event}`, fn);
    await callTool(APP_TOOLS.listen, { event });
    return off;
  },
  /** Opens a link through the host: in a view of <data>/pages a tab of the pane, in a chat's mini-tool after the person said Open. */
  open(url: string): Promise<unknown> {
    return request('ui/open-link', { url });
  },
  /** Post a user-turn text into the chat, labelled "via mini-app". */
  prompt(text: string): Promise<unknown> {
    return request(APP_METHODS.message, { role: 'user', content: { type: 'text', text } });
  },
  state: {
    async get<T = unknown>(): Promise<T | undefined> {
      return (await callTool(APP_TOOLS.stateGet, {})).state as T | undefined;
    },
    async set(state: Json): Promise<void> {
      await callTool(APP_TOOLS.stateSet, { state });
    },
  },
  chart(target: Element, spec: ChartSpec): void {
    drawChart(target, spec);
  },
  async mermaid(target: Element, source: string): Promise<void> {
    const { svg } = await callTool(APP_TOOLS.mermaid, { source });
    if (typeof svg !== 'string') return;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg') return;
    root.querySelectorAll('script, foreignObject').forEach((node) => node.remove());
    target.replaceChildren(document.importNode(root, true));
    reportSize();
  },
  expand(): Promise<unknown> {
    return request(APP_METHODS.displayMode, { mode: 'fullscreen' });
  },
};

(window as unknown as { wf: typeof wf }).wf = wf;

async function start(): Promise<void> {
  try {
    const result = (await request(APP_METHODS.initialize, {
      protocolVersion: APP_BRIDGE_PROTOCOL,
      appInfo: { name: 'workforce-app', version: '1' },
      appCapabilities: {},
    })) as AppInitializeResult | undefined;
    if (result?.hostContext) applyContext(result.hostContext);
  } catch (error) {
    console.warn('wf: host did not initialize', error);
  }
  notify(APP_METHODS.initialized, {});
  new ResizeObserver(reportSize).observe(document.documentElement);
  reportSize();
  readyResolve(context);
}

void start();
