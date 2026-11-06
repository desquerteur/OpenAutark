// B-052 track A: one MCP connection over a Wire (http.ts or stdio.ts). Handshake: `initialize` (2025-11-25 asked;
// 2025-03-26 / 2025-06-18 / 2025-11-25 and 2024-11-05 accepted) → notifications/initialized; when that is refused
// (HTTP 400/404/405 or a JSON-RPC error – never 401/403), or initialize answers with a stateless-era version, the
// stateless 2026-07-28 `server/discover`, after which every message carries `_meta` (-32022 data.supported picks
// another version). Requests are matched by id, time out (60 s default for the handshake and lists; tools/call 5 min,
// renewed by every notifications/progress for its progressToken up to 30 min in all – slow tools such as an analysis
// or a large repository question are not cut at a minute) and send notifications/cancelled on abort or timeout. An
// expired HTTP session is initialized again once and the request retried. Server requests get ping → {} or -32601;
// notifications/tools/list_changed reaches onToolsChanged listeners. tools/list pages by cursor (≤ 500 tools, ≤ 2 MB).
// Owns: that lifecycle. Never: retries a tools/call that may have run, or shows server text as an instruction.

import { McpAuthRequired, McpProtocolError, McpTransportError, type McpCallResult, type McpConnection, type McpServerInfo, type McpToolDef } from '../types.ts';
import { callResultOf, serverInfoOf, toolOf } from './shapes.ts';
import {
  answerError, classify, CODE, HttpStatusError, isRecord, LEGACY_VERSIONS, META_CAPABILITIES, META_CLIENT, META_VERSION, MODERN_VERSIONS,
  rpcCodeOf, serverRequestReply, SessionExpired, STDIO_OLD_VERSION, type RpcNotification, type RpcRequest, type Wire,
} from './rpc.ts';

export const DEFAULT_TIMEOUT_MS = 60_000;
/** tools/call: the deadline without progress, and the cap however often the server reports progress. */
export const CALL_TIMEOUT_MS = 5 * 60_000;
export const CALL_CAP_MS = 30 * 60_000;
export const MAX_TOOLS = 500;
/** All listed tools together (their JSON): the rest of a larger list is left out, in the server's order. */
export const MAX_TOOLS_CHARS = 2_000_000;
const MAX_PAGES = 100;
const TIMEOUT = Symbol('timeout');
const CLOSED = Symbol('closed');
const CALLER = Symbol('caller');

/** The request got no answer in time (the session swaps in the wire's hint during the handshake). */
export class McpTimeout extends McpTransportError {
  constructor(sent: boolean, message = 'The app did not answer in time.') { super(message, sent); this.name = 'McpTimeout'; }
}

/** The server speaks no protocol version this client knows. */
export class McpVersionUnsupported extends McpTransportError {
  constructor() { super('The app uses an MCP version this app does not support.', false); this.name = 'McpVersionUnsupported'; }
}

export interface SessionOptions {
  clientInfo: { name: string; version: string };
  timeoutMs?: number;
  transport: 'http' | 'stdio';
  /** Closes the connection when it aborts (also aborts the handshake). */
  lifetime?: AbortSignal;
}

interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; toolCall?: boolean }

/** The answered version of an initialize that names a stateless-era version: the handshake goes on with server/discover. */
class ModernAnswer extends McpTransportError {
  constructor() { super('The app answered with a stateless MCP version.', false); this.name = 'ModernAnswer'; }
}

function cancelledBy(signal: AbortSignal | undefined, toolCall: boolean): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new McpTransportError('The call was cancelled.', toolCall);
}

/** Worth trying the stateless era: the legacy handshake was refused, not unauthorized and not unreachable. */
function refusedHandshake(error: unknown): boolean {
  if (error instanceof McpAuthRequired) return false;
  if (error instanceof HttpStatusError) return error.status === 400 || error.status === 404 || error.status === 405;
  return error instanceof McpProtocolError || error instanceof ModernAnswer;
}

export class McpSession implements McpConnection {
  info: McpServerInfo = { protocolVersion: '' };
  private wire!: Wire;
  private readonly options: SessionOptions;
  private era: 'legacy' | 'modern' | undefined;
  private version = '';
  private seq = 0;
  private generation = 0;
  private renewing: Promise<void> | undefined;
  private closed = false;
  private readonly inflight = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();
  /** progressToken of a running tools/call → renews its deadline. */
  private readonly progress = new Map<string | number, () => void>();
  private readonly onLifetime = () => { void this.close(); };

  constructor(options: SessionOptions) {
    this.options = options;
  }

  attach(wire: Wire): void { this.wire = wire; }

  /** Messages from the wire that are no awaited answer. */
  readonly incoming = (raw: unknown): void => {
    const message = classify(raw);
    if (message.kind === 'request') {
      void this.wire.deliver(serverRequestReply(message.id, message.method)).catch(() => undefined);
    } else if (message.kind === 'notification' && message.method === 'notifications/tools/list_changed') {
      for (const listener of [...this.listeners]) { try { listener(); } catch { /* isolate */ } }
    } else if (message.kind === 'notification' && message.method === 'notifications/progress') {
      const token = message.params?.progressToken;
      if (typeof token === 'string' || typeof token === 'number') this.progress.get(token)?.();
    }
  };

  async open(): Promise<void> {
    const signal = this.options.lifetime;
    let refused: unknown;
    try {
      await this.initialize(LEGACY_VERSIONS[0], signal);
    } catch (error) {
      if (!refusedHandshake(error)) throw this.withHint(error);
      refused = error;
    }
    if (refused !== undefined) {
      try { await this.discover(MODERN_VERSIONS[0], signal, true); } catch (error) {
        throw error instanceof McpAuthRequired || error instanceof McpVersionUnsupported ? error : this.withHint(refused);
      }
    }
    if (signal) signal.addEventListener('abort', this.onLifetime, { once: true });
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let chars = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { signal });
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new McpProtocolError(CODE.internal, 'The app sent a tool list that could not be read.');
      for (const raw of result.tools) {
        const tool = toolOf(raw);
        if (!tool || names.has(tool.name)) continue;
        chars += JSON.stringify(tool).length;
        if (chars > MAX_TOOLS_CHARS) return tools; // what the app keeps and writes stays bounded
        names.add(tool.name);
        tools.push(tool);
        if (tools.length >= MAX_TOOLS) return tools;
      }
      const next = typeof result.nextCursor === 'string' && result.nextCursor.length <= 4_096 ? result.nextCursor : '';
      if (!next || cursors.has(next)) break; // the end, or a server that repeats a cursor
      cursors.add(next);
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS, toolCall: true });
    const parsed = callResultOf(result);
    if (!parsed) throw new McpTransportError('The app sent a tool result that could not be read.', true); // it ran: effect unknown
    return parsed;
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.lifetime?.removeEventListener('abort', this.onLifetime);
    for (const controller of this.inflight) controller.abort(CLOSED);
    this.listeners.clear();
    await this.wire.close().catch(() => undefined);
  }

  // ------------------------------------------------------------------ handshake

  private accepts(version: string): boolean {
    return (LEGACY_VERSIONS as readonly string[]).includes(version) || version === STDIO_OLD_VERSION; // 2024-11-05: the same tools/list and tools/call on either wire
  }

  private async initialize(version: string, signal?: AbortSignal): Promise<void> {
    this.era = undefined;
    this.version = '';
    const result = await this.exchange('initialize', { protocolVersion: version, capabilities: {}, clientInfo: this.options.clientInfo }, { signal });
    const answered = isRecord(result) && typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
    if ((MODERN_VERSIONS as readonly string[]).includes(answered)) throw new ModernAnswer();
    if (!this.accepts(answered)) throw new McpVersionUnsupported();
    this.era = 'legacy';
    this.version = answered;
    this.wire.negotiated(answered);
    this.info = serverInfoOf(result, answered);
    await this.wire.deliver(this.notification('notifications/initialized', {})).catch(() => undefined);
  }

  private async discover(version: string, signal: AbortSignal | undefined, retry: boolean): Promise<void> {
    this.era = 'modern';
    this.version = version;
    let result: unknown;
    try {
      result = await this.exchange('server/discover', {}, { signal });
    } catch (error) {
      const rpc = rpcCodeOf(error);
      if (rpc?.code !== CODE.unsupportedVersion) { this.era = undefined; throw error; }
      const data = isRecord(rpc.data) ? rpc.data : {};
      const supported = Array.isArray(data.supported) ? data.supported.filter((entry): entry is string => typeof entry === 'string') : [];
      const next = (MODERN_VERSIONS as readonly string[]).find((known) => known !== version && supported.includes(known));
      if (retry && next) return this.discover(next, signal, false);
      this.era = undefined;
      throw new McpVersionUnsupported();
    }
    this.info = serverInfoOf(result, version);
  }

  /** A handshake timeout with a better reason from the wire (stdio printed something that is not MCP). */
  private withHint(error: unknown): unknown {
    const hint = error instanceof McpTimeout ? this.wire.hint() : undefined;
    return hint ? new McpTimeout(false, hint) : error;
  }

  // ------------------------------------------------------------------ requests

  private withMeta(params: Record<string, unknown>): Record<string, unknown> {
    if (this.era !== 'modern') return params;
    const meta = isRecord(params._meta) ? params._meta : {};
    return { ...params, _meta: { ...meta, [META_VERSION]: this.version, [META_CAPABILITIES]: {}, [META_CLIENT]: this.options.clientInfo } };
  }

  private notification(method: string, params: Record<string, unknown>): RpcNotification {
    return { jsonrpc: '2.0', method, params: this.withMeta(params) };
  }

  /** A request that survives one expired HTTP session (initialize again, then the same request once more). */
  private async request(method: string, params: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
    const generation = this.generation;
    try {
      return await this.exchange(method, params, opts);
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
    }
    await this.renew(generation);
    try {
      return await this.exchange(method, params, opts);
    } catch (error) {
      if (error instanceof SessionExpired) throw new McpTransportError('The app ended the session.', false);
      throw error;
    }
  }

  private async renew(generation: number): Promise<void> {
    if (generation !== this.generation) return; // another request already started a new session
    this.renewing ??= (async () => {
      try {
        this.wire.reset();
        await this.initialize(LEGACY_VERSIONS[0]);
        this.generation++;
      } finally {
        this.renewing = undefined;
      }
    })();
    await this.renewing;
  }

  /** One request/answer with its own deadline; abort or timeout → notifications/cancelled (never for initialize). */
  private async exchange(method: string, params: Record<string, unknown>, opts: RequestOptions): Promise<unknown> {
    const toolCall = opts.toolCall === true;
    if (this.closed) throw new McpTransportError('The connection to the app is closed.', false);
    const caller = opts.signal;
    if (caller?.aborted) throw cancelledBy(caller, false);
    const id = ++this.seq;
    const progressMeta = toolCall ? { _meta: { ...(isRecord(params._meta) ? params._meta : {}), progressToken: id } } : {};
    const message: RpcRequest = { jsonrpc: '2.0', id, method, params: this.withMeta({ ...params, ...progressMeta }) };
    const controller = new AbortController();
    const wait = opts.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    let timer = setTimeout(() => controller.abort(TIMEOUT), wait);
    timer.unref?.();
    if (toolCall) {
      this.progress.set(id, () => { // progress renews the deadline, never beyond the cap
        const left = CALL_CAP_MS - (Date.now() - started);
        if (left <= 0 || controller.signal.aborted) return;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(TIMEOUT), Math.min(wait, left));
        timer.unref?.();
      });
    }
    const onAbort = () => controller.abort(CALLER);
    caller?.addEventListener('abort', onAbort, { once: true });
    this.inflight.add(controller);
    try {
      const reply = await this.wire.send(message, controller.signal, toolCall);
      if (reply.error) throw reply.error instanceof Error ? reply.error : answerError(reply.error);
      return reply.result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const reason: unknown = controller.signal.reason;
      if (reason === CLOSED) throw new McpTransportError('The connection to the app was closed.', toolCall);
      if (method !== 'initialize') {
        const why = reason === TIMEOUT ? 'The request timed out.' : 'The request was cancelled.';
        void this.wire.deliver(this.notification('notifications/cancelled', { requestId: id, reason: why })).catch(() => undefined);
      }
      if (reason === TIMEOUT) throw new McpTimeout(toolCall);
      throw cancelledBy(caller, toolCall);
    } finally {
      clearTimeout(timer);
      this.progress.delete(id);
      caller?.removeEventListener('abort', onAbort);
      this.inflight.delete(controller);
    }
  }
}
