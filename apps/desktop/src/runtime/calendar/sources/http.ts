// The network surface of connected calendars (B-041 track G): the injected fetch (tests use fakes; the default is the
// global fetch), reading a body under a size cap, form bodies for OAuth and a JSON call with a timeout whose
// failures are user-safe sentences (never a URL, a query, a token or a response body).
// Owns: that surface. Never: logs a request or a response, or keeps a token.

import { WorkforceError } from '../../../shared/errors.ts';

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export const globalFetch: FetchFn = (url, init) => fetch(url, init) as Promise<FetchResponse>;

/** The body as text; 'bad_request' when it is larger than `maxBytes` (the stream is cancelled there). */
export async function readCapped(response: FetchResponse, maxBytes: number, what: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  const tooBig = () => new WorkforceError('bad_request', `${what} is larger than ${Math.round(maxBytes / 1_000_000)} MB.`);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw tooBig();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw tooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(all);
}

/** application/x-www-form-urlencoded of the defined entries. */
export function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, value);
  return params.toString();
}

/** A failed HTTP call: its status and the provider's short error code (e.g. 'invalid_grant'), never its body. */
export class HttpFailure extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(`HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'HttpFailure';
    this.status = status;
    this.code = code;
  }
}

/** The short error code of a JSON error body: OAuth's "error": "invalid_grant", or Google's error.errors[0].reason. */
function errorCode(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { error?: unknown };
    if (typeof data.error === 'string') return data.error.slice(0, 40);
    const nested = data.error as { status?: unknown; errors?: Array<{ reason?: unknown }> } | undefined;
    const reason = nested?.errors?.[0]?.reason ?? nested?.status;
    return typeof reason === 'string' ? reason.slice(0, 40) : undefined;
  } catch { return undefined; }
}

/**
 * One JSON call: `HttpFailure` for an HTTP error (status + code), 'timeout' / 'unavailable' when the network fails.
 * `what` names the service in the user-safe message ("Google Calendar").
 */
export async function callJson<T>(fetchFn: FetchFn, url: string, init: { method?: string; headers?: Record<string, string>; body?: string; json?: unknown; timeoutMs?: number }, what: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers['content-type'] = 'application/json'; }
  let response: FetchResponse;
  try {
    response = await fetchFn(url, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new WorkforceError('timeout', `${what} did not answer in time.`);
    throw new WorkforceError('unavailable', `${what} could not be reached.`);
  }
  const text = response.status === 204 ? '' : await response.text().catch(() => '');
  if (!response.ok) throw new HttpFailure(response.status, errorCode(text));
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new WorkforceError('unavailable', `${what} sent an answer that could not be read.`); }
}
