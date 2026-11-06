// What an agent debugs a side tab with – its console (console calls, uncaught exceptions,
// the browser's own log entries) and its network requests, kept in small ring buffers from the moment
// the driver attaches to the tab. Fed with DevTools protocol events (driver.ts); read as text lines.
// Cookie, authorization and other secret header values and secret query values are never handed out,
// and secret-looking fields in a response body are hidden.
// Owns: the buffers, the redaction and the text. Never: talks to a page (pure).

import { SIDE_TEXT_MAX } from '../../shared/model/side-browser.ts';
import { maskUrl } from './snapshot.ts';

const CONSOLE_MAX = 300;
const NETWORK_MAX = 300;
const ENTRY_TEXT = 600;

type Level = 'error' | 'warning' | 'info' | 'log' | 'debug' | 'page';
interface ConsoleEntry { at: number; level: Level; text: string; where?: string }

export interface LogFilter { pattern?: string; errorsOnly?: boolean; limit?: number }

/** A filter's pattern: a regular expression when it is one, else plain text (both case-insensitive). */
function matcher(pattern: string | undefined): (text: string) => boolean {
  if (!pattern) return () => true;
  try { const re = new RegExp(pattern, 'i'); return (text) => re.test(text); } catch { const low = pattern.toLowerCase(); return (text) => text.toLowerCase().includes(low); }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

interface RemoteObject { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string }

function argText(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.value !== undefined) { try { return JSON.stringify(arg.value); } catch { return String(arg.value); } }
  return arg.description ?? arg.type ?? '';
}

interface Frame { url?: string; lineNumber?: number }
const place = (frame: Frame | undefined) => (frame?.url ? `${maskUrl(frame.url)}:${(frame.lineNumber ?? 0) + 1}` : undefined);

export class ConsoleLog {
  private items: ConsoleEntry[] = [];
  /** console.* calls in this tab since attach (Runtime.consoleAPICalled). */
  count = 0;

  private add(entry: ConsoleEntry): void {
    this.items.push({ ...entry, text: clip(entry.text.replace(/\s+$/, ''), ENTRY_TEXT) });
    if (this.items.length > CONSOLE_MAX) this.items.splice(0, this.items.length - CONSOLE_MAX);
  }

  api(params: { type?: string; args?: RemoteObject[]; timestamp?: number; stackTrace?: { callFrames?: Frame[] } }): void {
    this.count += 1;
    const type = params.type ?? 'log';
    const level: Level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : type === 'debug' ? 'debug' : 'log';
    this.add({ at: params.timestamp ?? Date.now(), level, text: (params.args ?? []).map(argText).join(' '), where: place(params.stackTrace?.callFrames?.[0]) });
  }

  exception(params: { timestamp?: number; exceptionDetails?: { text?: string; url?: string; lineNumber?: number; exception?: RemoteObject } }): void {
    const details = params.exceptionDetails ?? {};
    const text = details.exception?.description ?? details.text ?? 'Uncaught exception';
    this.add({ at: params.timestamp ?? Date.now(), level: 'error', text: text.split('\n').slice(0, 4).join('\n'), where: place(details) });
  }

  entry(params: { entry?: { level?: string; text?: string; url?: string; source?: string; timestamp?: number } }): void {
    const entry = params.entry;
    if (!entry || entry.level === 'verbose') return;
    const level: Level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info';
    this.add({ at: entry.timestamp ?? Date.now(), level, text: `${entry.source ? `${entry.source}: ` : ''}${entry.text ?? ''}`, where: entry.url ? maskUrl(entry.url) : undefined });
  }

  /** The main frame went to another document. */
  navigated(url: string, at = Date.now()): void {
    this.add({ at, level: 'page', text: `navigated to ${maskUrl(url)}` });
  }

  text(filter: LogFilter = {}): string {
    const match = matcher(filter.pattern);
    const hits = this.items.filter((item) => (!filter.errorsOnly || item.level === 'error' || (item.level === 'page')) && (item.level === 'page' || match(item.text)));
    const real = hits.filter((item) => item.level !== 'page');
    if (!real.length) return filter.pattern || filter.errorsOnly ? 'No console messages match.' : 'No console messages since the driver started watching this tab.';
    const limit = Math.max(1, Math.min(CONSOLE_MAX, filter.limit ?? 50));
    const shown = hits.slice(-limit);
    const lines = shown.map((item) => `[${item.level}] ${clock(item.at)} ${item.text}${item.where ? ` (${item.where})` : ''}`);
    if (hits.length > shown.length) lines.unshift(`… ${hits.length - shown.length} earlier entries`);
    return clip(lines.join('\n'), SIDE_TEXT_MAX);
  }
}

/** Header names whose values are never handed out. */
const SECRET_HEADER = /^(?:cookie|set-cookie|authorization|proxy-authorization)$|token|secret|api-?key|session|auth|csrf|xsrf|password|signature/i;
/** JSON fields in a body whose values are hidden. */
const SECRET_FIELD = /("(?:[\w-]*(?:token|secret|password|passwd|api_?key|apikey|session_?id|sessionid|client_secret|refresh|cookie|otp|pin))"\s*:\s*)"[^"]*"/gi;

export function redactHeaders(headers: Record<string, unknown> | undefined): string[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => `${name}: ${SECRET_HEADER.test(name) ? '[hidden]' : clip(String(value), 300)}`);
}

export function redactBody(body: string): string {
  return body.replace(SECRET_FIELD, '$1"[hidden]"');
}

interface Request {
  id: string; method: string; url: string; type: string; start: number; wall: number;
  status?: number; statusText?: string; mime?: string; failed?: string; canceled?: boolean; size?: number; end?: number;
  reqHeaders?: Record<string, unknown>; resHeaders?: Record<string, unknown>;
}

const size = (bytes: number | undefined) => (bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1048576).toFixed(1)} MB`);
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded|graphql|ld\+json|problem\+json)|image\/svg)|\+json|\+xml/i;

export class NetworkLog {
  private items = new Map<string, Request>();

  private keep(request: Request): void {
    this.items.delete(request.id);
    this.items.set(request.id, request);
    while (this.items.size > NETWORK_MAX) this.items.delete(this.items.keys().next().value!);
  }

  sent(p: { requestId: string; request?: { url?: string; method?: string; headers?: Record<string, unknown> }; type?: string; timestamp?: number; wallTime?: number; redirectResponse?: { status?: number; statusText?: string; headers?: Record<string, unknown>; mimeType?: string } }): void {
    const old = this.items.get(p.requestId);
    if (old && p.redirectResponse) { // the same id continues at the new address: keep the redirect as its own line
      this.items.delete(p.requestId);
      this.keep({ ...old, id: `${p.requestId}~${old.start}`, status: p.redirectResponse.status, statusText: p.redirectResponse.statusText, resHeaders: p.redirectResponse.headers, end: p.timestamp });
    }
    this.keep({
      id: p.requestId, method: p.request?.method ?? 'GET', url: p.request?.url ?? '', type: (p.type ?? 'Other').toLowerCase(),
      start: p.timestamp ?? 0, wall: p.wallTime ? p.wallTime * 1000 : Date.now(), reqHeaders: p.request?.headers,
    });
  }

  response(p: { requestId: string; response?: { status?: number; statusText?: string; mimeType?: string; headers?: Record<string, unknown> } }): void {
    const item = this.items.get(p.requestId);
    if (!item || !p.response) return;
    item.status = p.response.status; item.statusText = p.response.statusText; item.mime = p.response.mimeType; item.resHeaders = p.response.headers;
  }

  finished(p: { requestId: string; timestamp?: number; encodedDataLength?: number }): void {
    const item = this.items.get(p.requestId);
    if (item) { item.end = p.timestamp ?? item.start; item.size = p.encodedDataLength; }
  }

  failed(p: { requestId: string; timestamp?: number; errorText?: string; canceled?: boolean; blockedReason?: string }): void {
    const item = this.items.get(p.requestId);
    if (item) { item.end = p.timestamp ?? item.start; item.failed = p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText ?? 'failed'; item.canceled = p.canceled === true; }
  }

  /** Requests still open (long-lived event streams and those older than 10 s are not counted). */
  inflight(nowSec?: number): number {
    let open = 0;
    for (const item of this.items.values()) {
      if (item.end !== undefined || item.type === 'eventsource' || item.type === 'websocket') continue;
      if (nowSec !== undefined && nowSec - item.start > 10) continue;
      open += 1;
    }
    return open;
  }

  /** The newest monotonic timestamp seen (DevTools seconds). */
  latest(): number {
    let at = 0;
    for (const item of this.items.values()) at = Math.max(at, item.end ?? item.start);
    return at;
  }

  has(id: string): boolean { return this.items.has(id); }
  mime(id: string): string | undefined { return this.items.get(id)?.mime; }

  private line(item: Request): string {
    const ms = item.end !== undefined ? ` ${Math.max(0, Math.round((item.end - item.start) * 1000))} ms` : '';
    const state = item.failed ? (item.canceled ? 'canceled' : `failed (${item.failed})`) : item.status !== undefined ? String(item.status) : item.end !== undefined ? 'done' : 'pending';
    return `${item.method} ${state} ${item.type}${item.size !== undefined ? ` ${size(item.size)}` : ''}${ms} ${maskUrl(item.url, undefined, 300)} [id=${item.id}]`;
  }

  text(filter: LogFilter = {}): string {
    const match = matcher(filter.pattern);
    const hits = [...this.items.values()].filter((item) => match(item.url) && (!filter.errorsOnly || (item.failed && !item.canceled) || (item.status ?? 0) >= 400));
    if (!hits.length) return filter.pattern || filter.errorsOnly ? 'No requests match.' : 'No requests since the driver started watching this tab.';
    const limit = Math.max(1, Math.min(NETWORK_MAX, filter.limit ?? 50));
    const shown = hits.slice(-limit);
    const lines = shown.map((item) => this.line(item));
    if (hits.length > shown.length) lines.unshift(`… ${hits.length - shown.length} earlier requests`);
    return clip(lines.join('\n'), SIDE_TEXT_MAX);
  }

  /** One request with its (redacted) headers; `body` as the page received it (decoded when textual). */
  detail(id: string, body?: { body: string; base64Encoded?: boolean }): string | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    const lines = [this.line(item)];
    if (item.statusText) lines.push(`Status: ${item.status} ${item.statusText}`);
    if (item.mime) lines.push(`Type: ${item.mime}`);
    const req = redactHeaders(item.reqHeaders);
    if (req.length) lines.push('Request headers:', ...req.map((line) => `  ${line}`));
    const res = redactHeaders(item.resHeaders);
    if (res.length) lines.push('Response headers:', ...res.map((line) => `  ${line}`));
    if (body) {
      const textual = !body.base64Encoded || TEXTUAL.test(item.mime ?? '');
      if (!textual) lines.push(`Body: binary, ${size(Math.floor((body.body.length * 3) / 4))}`);
      else {
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        lines.push('Body:', redactBody(text));
      }
    }
    return clip(lines.join('\n'), SIDE_TEXT_MAX);
  }
}
