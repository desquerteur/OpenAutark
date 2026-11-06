// Small helpers shared by all engines.
// Owns: bounded newline-delimited JSON reading, provider-safe tool names, ToolOutput → text,
// effort normalization, the folder comparison of sessions, the fixed, user-safe error data
// engines return and the sums of the cached tokens a usage reports (CacheTokens).
// Never: talks to a provider or knows a provider's wire format beyond names.

import path from 'node:path';
import type { Readable } from 'node:stream';
import type { CacheTokens } from './types.ts';
import type { Effort } from '../../shared/model/providers.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import type { ToolOutput, ToolSpec } from '../tools/types.ts';

/**
 * Calls `onLine` for every complete line. A line over `maxLine` bytes or unparseable JSON
 * calls `onBad` once (the connection is then considered broken).
 */
export function readJsonLines(stream: Readable, onMessage: (message: unknown) => void, onBad: (reason: string) => void, maxLine = 4 * 1024 * 1024): void {
  let buffer = '';
  let broken = false;
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    if (broken) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { broken = true; onBad('invalid_json'); return; }
      onMessage(message);
      if (broken) return;
    }
    if (buffer.length > maxLine) { broken = true; onBad('line_too_long'); }
  });
}

/** Provider function names must match ^[a-zA-Z0-9_-]{1,64}$; ours are dotted ("tasks.create"). */
export function toWireName(name: string): string {
  return name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export class ToolNames {
  private readonly byWire = new Map<string, string>();
  constructor(tools: ToolSpec[]) {
    for (const tool of tools) this.byWire.set(toWireName(tool.name), tool.name);
  }
  wire(name: string): string { return toWireName(name); }
  /** Our name for a wire name (also accepts our own dotted name). */
  ours(wire: string): string | undefined {
    return this.byWire.get(wire) ?? ([...this.byWire.values()].includes(wire) ? wire : undefined);
  }
}

export function outputText(output: ToolOutput, maxChars = 200_000): string {
  const text = output.content.map((part) => (part.type === 'text' ? part.text : `[image ${part.mime}]`)).join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

export function outputImages(output: ToolOutput): Array<{ mime: string; dataBase64: string }> {
  return output.content.flatMap((part) => (part.type === 'image' ? [{ mime: part.mime, dataBase64: part.dataBase64 }] : []));
}

/** Runs a tool call and converts thrown errors into an error result the model can read. */
export async function safeCall(callTool: (name: string, args: unknown, callId: string) => Promise<ToolOutput>, name: string, args: unknown, callId: string): Promise<ToolOutput> {
  try {
    return await callTool(name, args, callId);
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string'
      ? (error as { message: string }).message.slice(0, 500) : 'The tool failed.';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

const ORDER: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Picks the supported effort closest to (not above, if possible) the requested one. */
export function nearestEffort(wanted: Effort, supported: string[]): string | undefined {
  if (!supported.length) return undefined;
  if (supported.includes(wanted)) return wanted;
  const index = ORDER.indexOf(wanted);
  for (let i = index; i >= 0; i--) if (supported.includes(ORDER[i])) return ORDER[i];
  for (let i = index + 1; i < ORDER.length; i++) if (supported.includes(ORDER[i])) return ORDER[i];
  return supported[supported.length - 1];
}

export function normalizeEffort(value: unknown): Effort | undefined {
  if (value === 'minimal') return 'low';
  return typeof value === 'string' && (ORDER as string[]).includes(value) ? (value as Effort) : undefined;
}

export const ERR = {
  unavailable: (message: string): WorkforceErrorData => ({ code: 'unavailable', message }),
  limit: (retryAfterMs?: number, details?: Record<string, unknown>): WorkforceErrorData => ({
    code: 'rate_limited', message: 'The usage limit of this account was reached.', retryAfterMs, details,
  }),
  failed: (message = 'The model could not complete this turn.'): WorkforceErrorData => ({ code: 'internal', message }),
  cancelled: (): WorkforceErrorData => ({ code: 'cancelled', message: 'The turn was stopped.' }),
  timeout: (): WorkforceErrorData => ({ code: 'timeout', message: 'The engine did not respond in time.' }),
  /** A native session bound to another working folder: the executor renews it quietly (agents/turn.ts, details.folder). */
  folder: (engine: string): WorkforceErrorData => ({ code: 'conflict', message: `The working folder of this ${engine} session changed.`, details: { rebase: true, folder: true } }),
};

/** Same folder (resolved; case-insensitive on Windows). */
export function sameFolder(a: string, b: string): boolean {
  const norm = (dir: string) => { const full = path.resolve(dir); return process.platform === 'win32' ? full.toLowerCase() : full; };
  return norm(a) === norm(b);
}

/** Parses JSON text; undefined on failure. */
export function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const CACHE_KEYS = ['cachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/** The cache parts of `a` and `b` added (`sign` -1: b's taken off a's, never below 0), each only when one of them reports it ({} for b: a's alone). */
export function addCache(a: CacheTokens, b: CacheTokens, sign: 1 | -1 = 1): CacheTokens {
  const out: CacheTokens = {};
  for (const key of CACHE_KEYS) {
    const x = num(a[key]), y = num(b[key]);
    if (x !== undefined || y !== undefined) out[key] = Math.max(0, (x ?? 0) + sign * (y ?? 0));
  }
  return out;
}

/** The input the engine had cached (Codex's cached input, Claude's cache reads); a cache write is input sent in full. */
export function cachedInput(usage: CacheTokens | undefined): number {
  return Math.max(0, num(usage?.cachedInputTokens) ?? 0) + Math.max(0, num(usage?.cacheReadTokens) ?? 0);
}
