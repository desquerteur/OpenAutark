// MCP authorization (B-052 track B): the network surface of a sign-in – one JSON call with a 20 s timeout and a size
// cap (metadata GETs follow at most 3 redirects, each hop checked by the URL rule; POSTs never follow one, so a code
// or a token is never forwarded elsewhere), form and JSON bodies, the URL rule for every endpoint (HTTPS, no
// credentials in it; plain HTTP only on this PC – and this PC, a private or link-local address only for an app that
// is itself on this PC, so a remote app's metadata can never point the runtime or the browser at a local service),
// and failures as user-safe sentences: the HTTP status and a short OAuth error code at most, never a URL, a body or a
// token.
// Owns: that surface and OAuthHttpError. Never: logs a request or a response, or keeps a token.

import { WorkforceError } from '../../../shared/errors.ts';

export type FetchLike = typeof fetch;

export const HTTP_TIMEOUT_MS = 20_000;
/** Metadata, registration and token answers are small; anything larger is refused. */
const MAX_BYTES = 512 * 1024;
const CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 3;
/** Loopback, private (RFC 1918, fc00::/7) and link-local (169.254/16, fe80::/10) hosts written as addresses. */
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)|^\[(::1?|f[cd][0-9a-f]*:.*|fe[89ab][0-9a-f]*:.*|::ffff:.*)\]$|^localhost$|\.localhost$/i;

/** A failed HTTP call: its status and the short OAuth error code ('invalid_grant'), never its body. */
export class OAuthHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(`HTTP ${status}${code ? `, ${code}` : ''}`);
    this.name = 'OAuthHttpError';
    this.status = status;
    this.code = code;
  }
}

/** A short plain OAuth error code (server text: anything else is dropped). */
export function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && CODE.test(value) ? value : undefined;
}

/** The OAuth `error` field of a JSON error body. */
function errorCode(text: string): string | undefined {
  try { return safeCode((JSON.parse(text) as { error?: unknown } | null)?.error); } catch { return undefined; }
}

/** The address names this PC (127.0.0.1, localhost, [::1]). */
export function isLocalUrl(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

/**
 * `value` as an endpoint URL, or undefined: HTTPS, or HTTP only on this PC (tests, local servers); never with a user
 * or password in it, never a fragment. `local` false (the app is not on this PC): no loopback, private or link-local
 * host at all.
 */
export function endpointUrl(value: unknown, local = true): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.username || url.password || url.hash) return undefined;
  if (!local && PRIVATE_HOST.test(url.hostname)) return undefined;
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) ? url : undefined;
}

/** An answer that is no JSON at all (a catch-all page): discovery tries the next address. */
export class UnreadableAnswer extends WorkforceError {
  constructor(what: string) { super('unavailable', `${what} sent an answer that could not be read.`); this.name = 'UnreadableAnswer'; }
}

async function readCapped(response: Response, what: string): Promise<string> {
  const tooBig = () => new WorkforceError('unavailable', `${what} sent an answer that is too large.`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BYTES) { void response.body?.cancel().catch(() => undefined); throw tooBig(); }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_BYTES) throw tooBig();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface CallInit {
  method?: 'GET' | 'POST';
  /** application/x-www-form-urlencoded fields (undefined entries are left out). */
  form?: Record<string, string | undefined>;
  json?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** GET redirects may lead to this PC (endpointUrl's `local`; default: no). */
  local?: boolean;
}

/**
 * One JSON call. Resolves the parsed answer (undefined for an empty one); rejects with OAuthHttpError for an HTTP
 * error, with WorkforceError 'timeout' / 'unavailable' when the network fails or the answer cannot be read.
 * `what` names the other side in the user-safe message ("The app's sign-in server").
 */
export async function callJson<T>(fetchFn: FetchLike, url: string, init: CallInit, what: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  let body: string | undefined;
  if (init.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init.form)) if (value !== undefined) params.set(key, value);
    body = params.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers['content-type'] = 'application/json';
  }
  const method = init.method ?? (body === undefined ? 'GET' : 'POST');
  const signal = AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS);
  let target = url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetchFn(target, { method, headers, body, redirect: method === 'POST' ? 'error' : 'manual', signal });
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new WorkforceError('timeout', `${what} did not answer in time.`);
      throw new WorkforceError('unavailable', `${what} could not be reached.`);
    }
    if (method !== 'GET' || !REDIRECTS.has(response.status)) break;
    void response.body?.cancel().catch(() => undefined);
    let next: URL | undefined;
    try { next = endpointUrl(new URL(response.headers.get('location') ?? '', target).href, init.local ?? false); } catch { next = undefined; }
    if (!next || hop >= MAX_HOPS) throw new WorkforceError('forbidden', `${what} sent the request to an address that is not allowed.`);
    target = next.href;
  }
  const text = response.status === 204 ? '' : await readCapped(response, what).catch((error: unknown) => {
    if (error instanceof WorkforceError) throw error;
    return '';
  });
  if (!response.ok) throw new OAuthHttpError(response.status, errorCode(text));
  if (!text.trim()) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new UnreadableAnswer(what); }
}

/** A plain JSON object (server data is untrusted: anything else is no answer). */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The strings of a JSON array (other entries dropped, at most 100). */
export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 200).slice(0, 100) : undefined;
}
