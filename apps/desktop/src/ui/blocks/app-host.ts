// Pure parts of the host side of the ```app bridge (shared/blocks/app-bridge.ts, MCP Apps
// JSON-RPC names): frame parsing, the 64 KB size cap, rate limits and result shapes.
// A Blob in tools/call arguments (wf_upload, X03) is a structured-clone handle: frameBytes
// measures the JSON form only, where a Blob is '{}', and wf_upload brings its own byte caps
// (shared/blocks/app-files.ts, ui/blocks/app-upload.ts).
// Owns: these checks. Never: touches the DOM or RPC (AppFrame.tsx wires them), and never lets
// a bridge message count as consent – every action is an ordinary "via mini-app" event.

import { APP_BRIDGE_LIMITS, APP_METHODS, APP_TOOLS } from '../../shared/blocks/app-bridge.ts';

export interface BridgeFrame {
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type BridgeResult = Record<string, unknown>;

/** UTF-8 size of the JSON form of a message; Infinity when it cannot be serialized. */
export function frameBytes(data: unknown): number {
  let json: string | undefined;
  try { json = JSON.stringify(data); } catch { return Infinity; }
  if (json === undefined) return 0;
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** A JSON-RPC 2.0 request/notification from the frame, or null (responses and junk are ignored). */
export function parseFrame(data: unknown): BridgeFrame | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method || value.method.length > 100) return null;
  const id = value.id;
  if (id !== undefined && typeof id !== 'number' && !(typeof id === 'string' && id.length <= 64)) return null;
  const params = value.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return null;
  return { ...(id === undefined ? {} : { id }), method: value.method, params: (params ?? {}) as Record<string, unknown> };
}

/** Calls with an effect outside the frame (they share the per-minute action budget). */
export function isAction(frame: BridgeFrame): boolean {
  if (frame.method === APP_METHODS.message || frame.method === 'ui/open-link') return true;
  if (frame.method !== APP_METHODS.toolsCall) return false;
  const name = frame.params.name;
  return name === APP_TOOLS.event || name === APP_TOOLS.complete || name === APP_TOOLS.stateSet || name === APP_TOOLS.upload || name === APP_TOOLS.record;
}

/** Size notifications are coalesced instead of counted (they follow layout, not intent). */
export function isSizeChange(frame: BridgeFrame): boolean {
  return frame.method === APP_METHODS.sizeChanged;
}

/**
 * Sliding-window limits per frame: messages per second and actions per minute
 * (APP_BRIDGE_LIMITS). `allow` records the hit when it is allowed.
 */
export class BridgeLimiter {
  private readonly perSecond: number;
  private readonly perMinute: number;
  private messages: number[] = [];
  private actions: number[] = [];

  constructor(limits: { messagesPerSecond: number; actionsPerMinute: number } = APP_BRIDGE_LIMITS) {
    this.perSecond = limits.messagesPerSecond;
    this.perMinute = limits.actionsPerMinute;
  }

  allow(action: boolean, now: number): boolean {
    this.messages = this.messages.filter((at) => now - at < 1000);
    if (this.messages.length >= this.perSecond) return false;
    if (action) {
      this.actions = this.actions.filter((at) => now - at < 60_000);
      if (this.actions.length >= this.perMinute) return false;
      this.actions.push(now);
    }
    this.messages.push(now);
    return true;
  }
}

/** MCP `tools/call` success result. */
export function toolResult(structured: Record<string, unknown>, text = 'ok'): BridgeResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** MCP `tools/call` refusal (wf.js turns it into a rejected promise with this text). */
export function toolError(text: string): BridgeResult {
  return { isError: true, content: [{ type: 'text', text: text.slice(0, 300) }] };
}

/** Height the host gives an inline frame: the reported content height within sane bounds. */
export function clampHeight(value: unknown, max = 4000): number | undefined {
  const height = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(height) || height <= 0) return undefined;
  return Math.min(max, Math.max(24, Math.ceil(height)));
}

/** Text of a `ui/message` request (MCP content block or plain string), capped. */
export function messageText(params: Record<string, unknown>): string {
  const content = params.content as { type?: string; text?: unknown } | Array<{ type?: string; text?: unknown }> | string | undefined;
  const pick = (block: { text?: unknown } | undefined) => (typeof block?.text === 'string' ? block.text : '');
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(pick).join('\n') : pick(content);
  return text.trim().slice(0, 4000);
}
