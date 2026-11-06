// In-memory ring of app-to-host bridge calls from ```app mini-tools: which frame, which method
// (and wf_* tool), how many bytes (a wf_upload's file included – its Blob is only '{}' in the
// message's JSON), when, how it ended and how long it took. The frame's Activity
// disclosure (AppActivity.tsx) shows one frame's entries as rows (activityRows) and follows the
// ring through subscribe(); nothing is persisted.
// Owns: the ring, its change listeners, the name sanitizing and the Activity row wording.
// Never: stores payload content – no params, no text, and no method or tool string it does not
// know (an app could hide data in them).

import { APP_METHODS, APP_TOOLS } from '../../shared/blocks/app-bridge.ts';

export type CallResult = 'pending' | 'ok' | 'error' | 'limited' | 'too-large' | 'invalid';

export interface CallEntry {
  /** Date.now() when the message arrived. */
  at: number;
  /** Block key of the frame. */
  frame: string;
  /** A known bridge method, else 'other'. */
  method: string;
  /** For tools/call: a known wf_* tool, else 'other'. */
  tool?: string;
  bytes: number;
  result: CallResult;
  /** Handling time of a request (ms), once answered. */
  ms?: number;
}

const KNOWN_METHODS: ReadonlySet<string> = new Set<string>([...Object.values(APP_METHODS), 'ui/open-link']);
const KNOWN_TOOLS: ReadonlySet<string> = new Set<string>(Object.values(APP_TOOLS));

function record(data: unknown): Record<string, unknown> | undefined {
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

/** Method (and tool) name of a raw frame message, reduced to names this host knows. */
export function callName(data: unknown): { method: string; tool?: string } {
  const value = record(data);
  const method = typeof value?.method === 'string' && KNOWN_METHODS.has(value.method) ? value.method : 'other';
  if (method !== APP_METHODS.toolsCall) return { method };
  const name = record(value?.params)?.name;
  return { method, tool: typeof name === 'string' && KNOWN_TOOLS.has(name) ? name : 'other' };
}

/** A JSON-RPC response (e.g. the answer to the host's heartbeat ping) – not a call. */
export function isReply(data: unknown): boolean {
  const value = record(data);
  return value !== undefined && value.jsonrpc === '2.0' && value.method === undefined && value.id !== undefined
    && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
}

/** Fixed-size ring, oldest entries overwritten first. */
export class CallRing {
  readonly capacity: number;
  private items: CallEntry[] = [];
  private next = 0;
  private readonly listeners = new Set<() => void>();

  constructor(capacity = 200) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Adds an entry (the returned object may be completed later with `finish`). */
  add(entry: CallEntry): CallEntry {
    if (this.items.length < this.capacity) this.items.push(entry);
    else this.items[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    this.changed();
    return entry;
  }

  /** Completes a pending request entry of this ring and tells the listeners. */
  finish(entry: CallEntry, result: CallResult, now = Date.now()): void {
    finishCall(entry, result, now);
    this.changed();
  }

  /** Entries oldest first, optionally of one frame only (copies). */
  entries(frame?: string): CallEntry[] {
    const ordered = this.items.length < this.capacity ? this.items : [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
    return ordered.filter((entry) => frame === undefined || entry.frame === frame).map((entry) => ({ ...entry }));
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.next = 0;
    this.changed();
  }

  /** Called after every add, finish and clear; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a broken view must not break the bridge */ }
    }
  }
}

/** The host's ring (all frames, last 200 calls). */
export const appCalls = new CallRing(200);

/** Size of the file a wf_upload call hands over (its Blob argument), else 0. */
export function uploadBytes(data: unknown): number {
  const params = record(record(data)?.params);
  if (params?.name !== APP_TOOLS.upload) return 0;
  const blob = record(params.arguments)?.data;
  return typeof Blob !== 'undefined' && blob instanceof Blob ? blob.size : 0;
}

/** Logs one message from `frame`; only its name, size (a wf_upload's file included) and time are kept. */
export function logCall(ring: CallRing, frame: string, data: unknown, bytes: number, result: CallResult, now = Date.now()): CallEntry {
  const named = callName(data);
  const size = Number.isFinite(bytes) ? bytes + (named.tool === APP_TOOLS.upload ? uploadBytes(data) : 0) : -1;
  return ring.add({ at: now, frame, ...named, bytes: size, result });
}

/** Completes a pending request entry (without telling listeners; use CallRing.finish for that). */
export function finishCall(entry: CallEntry, result: CallResult, now = Date.now()): void {
  entry.result = result;
  entry.ms = Math.max(0, now - entry.at);
}

// ---------------------------------------------------------------- Activity rows

/** One row of a frame's Activity list: consecutive equal calls are merged (count, total bytes). */
export interface ActivityRow {
  /** What the app did, in words ("Saved its state"). */
  label: string;
  /** The bridge name it used ("wf_state_set", "ui/open-link", "other"). */
  name: string;
  result: CallResult;
  /** Time of the newest call in the row. */
  at: number;
  /** Bytes of all calls in the row (-1 when unknown). */
  bytes: number;
  /** Handling time of the newest call, once answered. */
  ms?: number;
  count: number;
}

const METHOD_LABEL: Record<string, string> = {
  [APP_METHODS.initialize]: 'Connected',
  [APP_METHODS.initialized]: 'Ready',
  [APP_METHODS.message]: 'Posted a message to the chat',
  [APP_METHODS.displayMode]: 'Asked for another view size',
  [APP_METHODS.sizeChanged]: 'Resized',
  [APP_METHODS.ping]: 'Pinged the host',
  'ui/open-link': 'Asked to open a link',
};
const TOOL_LABEL: Record<string, string> = {
  [APP_TOOLS.event]: 'Sent an event to the agent',
  [APP_TOOLS.complete]: 'Finished the to-do',
  [APP_TOOLS.stateGet]: 'Read its saved state',
  [APP_TOOLS.stateSet]: 'Saved its state',
  [APP_TOOLS.mermaid]: 'Drew a diagram',
  [APP_TOOLS.upload]: 'Stored a file for the agent',
  [APP_TOOLS.record]: 'Asked for a recording',
  [APP_TOOLS.rpc]: 'Called the app',
  [APP_TOOLS.listen]: 'Listened to an app event',
};

/** The words and the bridge name of one entry (only names the ring already sanitized). */
export function activityLabel(entry: Pick<CallEntry, 'method' | 'tool'>): { label: string; name: string } {
  if (entry.method === APP_METHODS.toolsCall) {
    const tool = entry.tool ?? 'other';
    return { label: TOOL_LABEL[tool] ?? 'Called an unknown tool', name: tool };
  }
  return { label: METHOD_LABEL[entry.method] ?? 'Sent an unknown message', name: entry.method };
}

/**
 * The Activity list of one frame, newest first, at most `limit` rows: names, sizes, results and
 * times only – the ring holds nothing else, and rows are built from its sanitized names.
 */
export function activityRows(ring: CallRing, frame: string, limit = 30): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const entry of ring.entries(frame).reverse()) {
    const { label, name } = activityLabel(entry);
    const last = rows[rows.length - 1];
    if (last && last.label === label && last.name === name && last.result === entry.result) {
      last.count += 1;
      last.bytes = last.bytes < 0 || entry.bytes < 0 ? -1 : last.bytes + entry.bytes;
      continue;
    }
    if (rows.length >= limit) break;
    rows.push({ label, name, result: entry.result, at: entry.at, bytes: entry.bytes, ...(entry.ms === undefined ? {} : { ms: entry.ms }), count: 1 });
  }
  return rows;
}
