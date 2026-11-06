// B-052 track A: the Streamable HTTP transport of the MCP client. Every message is one POST (Accept: application/json,
// text/event-stream) with the target's headers (Authorization …) on top; the answer is JSON or an SSE stream whose
// other messages (server requests, notifications) go to the session. Legacy era: the Mcp-Session-Id of the
// initialize answer and MCP-Protocol-Version ride on every later request, 404 with a session = SessionExpired, close()
// sends DELETE. Stateless era (2026-07-28, the request carries `_meta`): MCP-Protocol-Version, Mcp-Method and
// Mcp-Name (base64 form when not header-safe). 401 / 403 insufficient_scope → McpAuthRequired; other statuses →
// HttpStatusError (status only); a 400 to a request with a session that names no other cause (no body, -32600 or
// -32000) counts as an expired session too (Python/TS SDK servers). Redirects are followed only within the same
// origin; https only (http on loopback). Headers of the target merge without regard to case (one value per name);
// a failure while building them (a refresh that failed, a missing vault entry) means nothing was sent. An SSE answer
// stream that ends without the answer after an event id is resumed (2025-11-25 servers may close it): GET with
// Last-Event-ID after the server's `retry` (at most 5 s), at most 3 times, within the request's deadline.
// Owns: that wire. Never: logs or returns a header value, the session id or a body; puts a body into an error.

import { WorkforceError } from '../../../shared/errors.ts';
import { McpAuthRequired, McpTransportError, ReconnectNeeded, type HttpTarget } from '../types.ts';
import { authChallenge } from './challenge.ts';
import { SseParser } from './sse.ts';
import {
  asReply, HttpStatusError, isRecord, metaVersionOf, nameOf, noAnswer, SessionExpired,
  type IncomingHandler, type RpcId, type RpcNotification, type RpcOutgoing, type RpcReply, type RpcRequest, type Wire,
} from './rpc.ts';

/** The largest answer read (a JSON body, or the whole SSE stream). */
export const MAX_BODY = 16 * 1024 * 1024;
const MAX_ERROR_BODY = 64 * 1024;
const DELIVER_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** SSE resumption (GET with Last-Event-ID): attempts per answer, the wait before one when the server names none, its cap. */
const MAX_RESUMES = 3;
const RESUME_WAIT_MS = 1_000;
const MAX_RESUME_WAIT_MS = 5_000;
/** A JSON-RPC code a 400 to a request with a session may carry when the server forgot that session. */
const SESSION_GONE_CODES = new Set([-32600, -32000]);
const REDIRECTS = new Set([301, 302, 307, 308]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED = new Set(['accept', 'content-type', 'content-length', 'host', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name']);
const SESSION_ID = /^[\x21-\x7e]{1,1024}$/;
const HEADER_SAFE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
/** Connection errors that happen before a request is written: it cannot have run. */
const NOT_SENT = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN',
  'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** The MCP endpoint as a URL: https, or http on 127.0.0.1 / localhost / [::1]; no user name or password. */
export function checkHttpUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new McpTransportError('The app address is not a valid web address.', false); }
  if (parsed.username || parsed.password) throw new McpTransportError('The app address may not contain a user name or password.', false);
  const allowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname));
  if (!allowed) throw new McpTransportError('The app address must start with https://.', false);
  parsed.hash = '';
  return parsed;
}

/** A header value as it may be sent: plain when header-safe, else RFC 2047-like `=?base64?…?=` (2026-07-28). */
export function headerSafe(value: string): string {
  return HEADER_SAFE.test(value) ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function networkError(error: unknown, toolCall: boolean): McpTransportError {
  const code = causeCode(error);
  if (code && NOT_SENT.has(code)) return new McpTransportError('The app could not be reached.', false);
  return new McpTransportError('The connection to the app broke.', toolCall);
}

/** Waits `ms` (an abort ends the wait with the signal's reason). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A failure while building a request's headers: nothing was sent (sign-in problems keep their kind). */
function notPrepared(error: unknown): Error {
  if (error instanceof ReconnectNeeded || error instanceof McpAuthRequired || error instanceof McpTransportError) return error;
  return new McpTransportError(error instanceof WorkforceError ? error.message : 'The request to the app could not be prepared.', false);
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** The body as text under a cap; abort → the signal's reason, a broken stream → McpTransportError. */
async function readBody(response: Response, max: number, signal: AbortSignal, toolCall: boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try { chunk = await reader.read(); } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw networkError(error, toolCall);
    }
    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;
    if (size > max) { void reader.cancel().catch(() => undefined); throw new McpTransportError('The app\'s answer is too large.', toolCall); }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** The JSON-RPC error code/data of a small JSON error body (never its text). */
async function errorRpc(response: Response, signal: AbortSignal): Promise<{ code: number; data?: unknown } | undefined> {
  if (!mediaType(response).includes('json')) { discard(response); return undefined; }
  try {
    const parsed = JSON.parse(await readBody(response, MAX_ERROR_BODY, signal, false)) as unknown;
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    return error && typeof error.code === 'number' ? { code: error.code, data: error.data } : undefined;
  } catch { return undefined; }
}

export interface HttpWireDeps {
  fetch: typeof fetch;
  /** Server requests and notifications that arrive with an answer. */
  incoming: IncomingHandler;
}

export class HttpWire implements Wire {
  private url: URL;
  private readonly target: HttpTarget;
  private readonly fetchFn: typeof fetch;
  private readonly incoming: IncomingHandler;
  private sessionId: string | undefined;
  private version: string | undefined;
  private closed = false;

  constructor(target: HttpTarget, deps: HttpWireDeps) {
    this.url = checkHttpUrl(target.url);
    this.target = target;
    this.fetchFn = deps.fetch;
    this.incoming = deps.incoming;
  }

  negotiated(version: string): void { this.version = version; }
  reset(): void { this.sessionId = undefined; this.version = undefined; }
  hint(): string | undefined { return undefined; }

  async send(message: RpcRequest, signal: AbortSignal, toolCall: boolean): Promise<RpcReply> {
    if (this.closed) throw new McpTransportError('The connection to the app is closed.', false);
    if (message.method === 'initialize') this.reset();
    const response = await this.post(message, signal, toolCall);
    if (message.method === 'initialize') {
      const id = response.headers.get('mcp-session-id');
      this.sessionId = id && SESSION_ID.test(id) ? id : undefined;
    }
    if (response.status === 202 || response.status === 204) { discard(response); throw noAnswer(toolCall); }
    const type = mediaType(response);
    if (type === 'text/event-stream') return this.readStream(response, message.id, signal, toolCall);
    if (type === '' || type === 'application/json' || type.endsWith('+json')) {
      const text = await readBody(response, MAX_BODY, signal, toolCall);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw noAnswer(toolCall, 'The app sent an answer that could not be read.'); }
      const found = this.route(Array.isArray(parsed) ? parsed : [parsed], message.id);
      if (!found) throw noAnswer(toolCall);
      return found;
    }
    discard(response);
    throw noAnswer(toolCall, 'The app sent an answer that could not be read.');
  }

  async deliver(message: RpcNotification | RpcReply): Promise<void> {
    if (this.closed) return;
    discard(await this.post(message, AbortSignal.timeout(DELIVER_TIMEOUT_MS), false));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessionId = this.sessionId;
    const version = this.version;
    this.reset();
    if (!sessionId) return;
    try {
      const headers: Record<string, string> = { ...(await this.custom()), 'Mcp-Session-Id': sessionId };
      if (version) headers['MCP-Protocol-Version'] = version;
      discard(await this.fetchFn(this.url.href, { method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) }));
    } catch { /* best effort: 405 or gone */ }
  }

  // ------------------------------------------------------------------ internals

  /** One POST (same-origin redirects followed); a non-2xx answer becomes the matching error. */
  private async post(message: RpcOutgoing, signal: AbortSignal, toolCall: boolean): Promise<Response> {
    const body = JSON.stringify(message);
    const withSession = this.sessionId !== undefined && metaVersionOf(message) === undefined;
    const isRequest = 'method' in message && 'id' in message;
    for (let hop = 0; ; hop++) {
      let headers: Record<string, string>;
      try { headers = await this.headers(message); } catch (error) { throw notPrepared(error); }
      let response: Response;
      try {
        response = await this.fetchFn(this.url.href, { method: 'POST', headers, body, signal, redirect: 'manual' });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw networkError(error, toolCall);
      }
      if (REDIRECTS.has(response.status)) { discard(response); this.follow(response.headers.get('location'), hop); continue; }
      if (response.ok) return response;
      const auth = authChallenge(response.status, response.headers.get('www-authenticate'));
      if (auth) { discard(response); throw auth; }
      if (response.status === 404 && withSession && isRequest) { discard(response); throw new SessionExpired(); }
      const rpc = await errorRpc(response, signal);
      if (response.status === 400 && withSession && isRequest && (!rpc || SESSION_GONE_CODES.has(rpc.code))) throw new SessionExpired();
      throw new HttpStatusError(response.status, toolCall && response.status >= 500, rpc);
    }
  }

  private follow(location: string | null, hop: number): void {
    let next: URL | undefined;
    try { next = location ? new URL(location, this.url) : undefined; } catch { next = undefined; }
    if (!next || hop >= 2 || next.origin !== this.url.origin) throw new McpTransportError('The app moved to another address.', false);
    next.hash = '';
    this.url = next;
  }

  /** The target's own headers, without anything that would break the request or override the protocol's; one value
   *  per name whatever its spelling (the later one wins). */
  private async custom(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const extra = this.target.headers ? await this.target.headers() : {};
    for (const [name, value] of Object.entries(extra)) {
      if (!HEADER_NAME.test(name) || RESERVED.has(name.toLowerCase())) continue;
      if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) continue;
      for (const key of Object.keys(out)) if (key.toLowerCase() === name.toLowerCase()) delete out[key];
      out[name] = value;
    }
    return out;
  }

  private async headers(message: RpcOutgoing): Promise<Record<string, string>> {
    const out = await this.custom();
    out.Accept = 'application/json, text/event-stream';
    out['Content-Type'] = 'application/json';
    const modern = metaVersionOf(message);
    if (modern) {
      out['MCP-Protocol-Version'] = modern;
      if ('method' in message) out['Mcp-Method'] = headerSafe(message.method);
      const name = 'method' in message && 'id' in message ? nameOf(message) : undefined;
      if (name) out['Mcp-Name'] = headerSafe(name);
    } else {
      if (this.version) out['MCP-Protocol-Version'] = this.version;
      if (this.sessionId) out['Mcp-Session-Id'] = this.sessionId;
    }
    return out;
  }

  /** The answer to `id` from an SSE stream, resumed by GET with Last-Event-ID when the server closes it early. */
  private async readStream(first: Response, id: RpcId, signal: AbortSignal, toolCall: boolean): Promise<RpcReply> {
    let response = first;
    let lastId: string | undefined;
    let retry = RESUME_WAIT_MS;
    for (let resumes = 0; ; resumes++) {
      const parser = new SseParser();
      const found = await this.readEvents(response, parser, id, signal, toolCall);
      if (found) return found;
      lastId = parser.lastEventId ?? lastId;
      retry = parser.retry ?? retry;
      if (lastId === undefined || resumes >= MAX_RESUMES) throw noAnswer(toolCall, 'The app closed the connection without an answer.');
      await pause(Math.min(retry, MAX_RESUME_WAIT_MS), signal);
      response = await this.resume(lastId, signal, toolCall);
    }
  }

  /** GET for the rest of a stream (any non-SSE answer: the stream cannot go on). */
  private async resume(lastId: string, signal: AbortSignal, toolCall: boolean): Promise<Response> {
    const ended = () => noAnswer(toolCall, 'The app closed the connection without an answer.');
    if (!HEADER_SAFE.test(lastId) || lastId.length > 1024) throw ended();
    let headers: Record<string, string>;
    try { headers = await this.custom(); } catch (error) { throw notPrepared(error); }
    headers.Accept = 'text/event-stream';
    headers['Last-Event-ID'] = lastId;
    if (this.version) headers['MCP-Protocol-Version'] = this.version;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response: Response;
    try {
      response = await this.fetchFn(this.url.href, { method: 'GET', headers, signal, redirect: 'manual' });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw networkError(error, toolCall);
    }
    if (!response.ok || mediaType(response) !== 'text/event-stream') { discard(response); throw ended(); }
    return response;
  }

  /** Reads one SSE stream to its end: the answer to `id`, or undefined when it ends without it. */
  private async readEvents(response: Response, parser: SseParser, id: RpcId, signal: AbortSignal, toolCall: boolean): Promise<RpcReply | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw networkError(error, toolCall);
      }
      if (!chunk.done) {
        size += chunk.value.byteLength;
        if (size > MAX_BODY) { void reader.cancel().catch(() => undefined); throw new McpTransportError('The app\'s answer is too large.', toolCall); }
      }
      const events = chunk.done ? [...parser.push(decoder.decode()), ...parser.end()] : parser.push(decoder.decode(chunk.value, { stream: true }));
      for (const event of events) {
        if (event.event !== 'message' || !event.data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { continue; } // a malformed event is skipped, not fatal
        const found = this.route(Array.isArray(parsed) ? parsed : [parsed], id);
        if (found) { void reader.cancel().catch(() => undefined); return found; }
      }
      if (chunk.done) return undefined;
    }
  }

  /** Hands everything but the answer to `id` to the session; returns that answer. */
  private route(messages: unknown[], id: RpcId): RpcReply | undefined {
    let found: RpcReply | undefined;
    for (const message of messages) {
      const reply = asReply(message);
      if (reply) { if (reply.id === id && !found) found = reply; continue; } // answers to other ids are stale
      try { this.incoming(message); } catch { /* isolate */ }
    }
    return found;
  }
}
