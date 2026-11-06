// browser.console / browser.network in an agent's own browser: per tab, from the moment
// sessions.ts tracks it, the newest console messages (with uncaught page errors) and requests in two
// small ring buffers, filled by Playwright's page events (no polling, nothing stored on disk).
// Decisions: addresses lose the values of query parameters that look like credentials (token, key,
// secret, password, auth, session, sig, code); a request's details show only harmless headers
// (SAFE_HEADERS – cookie, set-cookie, authorization and every other header never leave); a response body
// is read on request only, text types only, at most BODY_MAX characters; the tool output passes the vault's redaction.
// Owns: the buffers, the event wiring and those cuts. Never: request interception, header values
// outside SAFE_HEADERS, or bodies of binary responses.

import type { PageLike } from './page.ts';

export const CONSOLE_MAX = 200;
export const NETWORK_MAX = 300;
export const BODY_MAX = 8000;
const TEXT_MAX = 500;
const URL_MAX = 300;

/** The only headers a request's details show (lower case). */
export const SAFE_HEADERS: ReadonlySet<string> = new Set([
  'content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'last-modified', 'location', 'access-control-allow-origin', 'retry-after',
]);
const SECRET_PARAM = /token|key|secret|pass|auth|session|sig|code|credential/i;

export interface ConsoleEntry { type: string; text: string; source?: string; at: number }
export interface NetworkEntry {
  id: string; method: string; url: string; type: string; at: number;
  status?: number; failure?: string; ms?: number;
}

interface RequestLike { url(): string; method(): string; resourceType?(): string; failure?(): { errorText: string } | null; headers?(): Record<string, string> }
interface ResponseLike { status(): number; headers?(): Record<string, string>; text?(): Promise<string>; request?(): RequestLike }
interface ConsoleLike { type(): string; text(): string; location?(): { url?: string; lineNumber?: number } }
type Listen = (event: string, listener: (payload: unknown) => void) => unknown;

/** An address without the values of query parameters that look like credentials. */
export function safeUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw.slice(0, URL_MAX); }
  for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.set(key, '…');
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href.slice(0, URL_MAX);
}

export function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (SAFE_HEADERS.has(key) && typeof value === 'string') out[key] = key === 'location' ? safeUrl(value) : value.slice(0, 200);
  }
  return out;
}

const TEXTUAL = /json|text|xml|javascript|html|csv|graphql|x-www-form-urlencoded/i;

export class PageLog {
  readonly console: ConsoleEntry[] = [];
  readonly network: NetworkEntry[] = [];
  private readonly requests = new WeakMap<object, NetworkEntry>();
  private readonly responses = new Map<string, ResponseLike>();
  private next = 1;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  /** Listens to the page's console, page errors and requests (Playwright events; fakes may lack them). */
  attach(page: PageLike): void {
    const on = (page as unknown as { on?: Listen }).on?.bind(page) as Listen | undefined;
    if (!on) return;
    const safely = (fn: (payload: never) => void) => (payload: unknown) => { try { fn(payload as never); } catch { /* a page event never breaks the session */ } };
    on('console', safely((message: ConsoleLike) => {
      if (typeof message?.type !== 'function' || typeof message.text !== 'function') return;
      const where = message.location?.();
      this.push(this.console, { type: message.type(), text: message.text().slice(0, TEXT_MAX), ...(where?.url ? { source: `${safeUrl(where.url)}${where.lineNumber ? `:${where.lineNumber}` : ''}` } : {}), at: this.now() }, CONSOLE_MAX);
    }));
    on('pageerror', safely((error: Error) => {
      if (!error || typeof (error as { message?: unknown }).message !== 'string') return;
      this.push(this.console, { type: 'error', text: `Uncaught ${error.name || 'Error'}: ${error.message}`.slice(0, TEXT_MAX), at: this.now() }, CONSOLE_MAX);
    }));
    on('request', safely((request: RequestLike) => {
      if (typeof request?.url !== 'function' || typeof request.method !== 'function') return;
      const entry: NetworkEntry = { id: `r${this.next++}`, method: request.method(), url: safeUrl(request.url()), type: request.resourceType?.() ?? 'other', at: this.now() };
      this.requests.set(request, entry);
      this.push(this.network, entry, NETWORK_MAX);
    }));
    on('response', safely((response: ResponseLike) => {
      const entry = response?.request ? this.requests.get(response.request() as object) : undefined;
      if (!entry || typeof response.status !== 'function') return;
      entry.status = response.status();
      entry.ms = this.now() - entry.at;
      this.responses.set(entry.id, response);
    }));
    on('requestfailed', safely((request: RequestLike) => {
      const entry = this.requests.get(request as object);
      if (!entry) return;
      entry.failure = (request.failure?.()?.errorText ?? 'failed').slice(0, 200);
      entry.ms = this.now() - entry.at;
    }));
  }

  /** The request's details: method, address, status, harmless headers and (text types) its body, capped. */
  async details(id: string): Promise<{ entry: NetworkEntry; headers: Record<string, string>; body?: string; bodyCut?: boolean } | undefined> {
    const entry = this.network.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    const response = this.responses.get(id);
    const headers = safeHeaders(response?.headers?.());
    if (!response?.text || !TEXTUAL.test(headers['content-type'] ?? '')) return { entry, headers };
    try {
      const body = await response.text();
      return { entry, headers, body: body.slice(0, BODY_MAX), bodyCut: body.length > BODY_MAX };
    } catch {
      return { entry, headers, body: '(the body is no longer available)' };
    }
  }

  private push<T>(list: T[], entry: T, max: number): void {
    list.push(entry);
    while (list.length > max) {
      const gone = list.shift() as { id?: unknown } | undefined;
      if (typeof gone?.id === 'string') this.responses.delete(gone.id);
    }
  }
}

/** Console lines as the agent reads them: newest last, filtered. */
export function consoleLines(entries: readonly ConsoleEntry[], input: { pattern?: string; errorsOnly?: boolean; limit?: number }): string[] {
  const pattern = input.pattern?.trim().toLowerCase();
  const picked = entries.filter((entry) => (!input.errorsOnly || entry.type === 'error' || entry.type === 'assert')
    && (!pattern || entry.text.toLowerCase().includes(pattern) || entry.source?.toLowerCase().includes(pattern)));
  return picked.slice(-(input.limit ?? 50)).map((entry) => `[${entry.type}] ${entry.text}${entry.source ? ` (${entry.source})` : ''}`);
}

/** Request lines: "r12 GET 200 https://… (fetch, 120 ms)", newest last, filtered. */
export function networkLines(entries: readonly NetworkEntry[], input: { urlPattern?: string; failedOnly?: boolean; limit?: number }): string[] {
  const pattern = input.urlPattern?.trim().toLowerCase();
  const failed = (entry: NetworkEntry) => entry.failure !== undefined || (entry.status ?? 0) >= 400;
  const picked = entries.filter((entry) => (!input.failedOnly || failed(entry)) && (!pattern || entry.url.toLowerCase().includes(pattern)));
  return picked.slice(-(input.limit ?? 50)).map((entry) => {
    const status = entry.failure ? `failed: ${entry.failure}` : entry.status !== undefined ? String(entry.status) : 'pending';
    return `${entry.id} ${entry.method} ${status} ${entry.url} (${entry.type}${entry.ms !== undefined ? `, ${entry.ms} ms` : ''})`;
  });
}
