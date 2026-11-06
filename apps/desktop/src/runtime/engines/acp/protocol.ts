// ACP (Agent Client Protocol) wire: newline-delimited JSON-RPC 2.0 over an agent's stdio.
// Owns: request/response matching, notification fan-out, agent→client requests (answered by a
// handler; unknown methods get -32601), timeouts, connection failure, the initialize request
// (protocol version 1, no fs/terminal client capabilities) and reading the agent's capabilities
// (prompt images and, B-058 G7, audio) and auth methods; classifying errors (auth required, usage limit, gone).
// Never: knows sessions or turns (process.ts / turn.ts do), logs message bodies, or offers the
// agent file or terminal access through us (it uses its own tools; we only approve them).

import type { ChildLike } from '../../system/supervisor.ts';
import { isRecord, readJsonLines, str } from '../shared.ts';

export const ACP_PROTOCOL_VERSION = 1;
/** ACP's error code for "authentication required" (RequestError.authRequired). */
export const AUTH_REQUIRED = -32000;
export const METHOD_NOT_FOUND = -32601;

const AUTH_TEXT = /auth(entication|orization)? required|not (signed|logged) in|please (log|sign) ?in|unauthori[sz]ed|invalid credentials|login required/i;
const LIMIT_TEXT = /rate.?limit|quota|usage limit|too many requests|\b429\b|resource.?exhausted/i;

export class AcpRpcError extends Error {
  readonly rpcCode: number;
  /** 'remote' = the agent answered with an error; 'timeout' = no answer in time; 'closed' = connection gone. */
  readonly kind: 'remote' | 'timeout' | 'closed';
  constructor(kind: AcpRpcError['kind'], code: number, message: string) {
    super(message);
    this.name = 'AcpRpcError';
    this.kind = kind;
    this.rpcCode = code;
  }
}

/** The agent says it needs a sign-in (code -32000, or the usual wording on another code). */
/**
 * B-059 #184: a JSON-RPC error's text – its message plus the detail an agent puts in `data` (the ACP SDK turns a thrown
 * error into "Internal error" with the real text, e.g. Gemini's "[API Error: got status: 503 …]", in data.details), at
 * most 300 characters, so sign-in, limit and outage texts are recognized.
 */
export function rpcErrorText(error: Record<string, unknown>): string {
  const base = typeof error.message === 'string' ? error.message : 'The agent reported an error.';
  const data = error.data;
  const detail = typeof data === 'string' ? data
    : isRecord(data) && typeof data.details === 'string' ? data.details
      : isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : '';
  return (detail && detail !== base ? `${base}: ${detail}` : base).slice(0, 300);
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.kind === 'remote' && (error.rpcCode === AUTH_REQUIRED || AUTH_TEXT.test(error.message));
}

/** The agent reports a used-up plan or a rate limit. */
export function isLimitError(error: unknown): boolean {
  return error instanceof AcpRpcError && error.kind === 'remote' && LIMIT_TEXT.test(error.message);
}

export interface AcpNotification { method: string; params: Record<string, unknown> }
export type AgentRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class AcpConnection {
  private readonly child: ChildLike;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(note: AcpNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private sequence = 0;
  private closed: AcpRpcError | undefined;
  handler: AgentRequestHandler | undefined;

  constructor(child: ChildLike) {
    this.child = child;
    if (!child.stdout || !child.stdin) throw new Error('ACP agent needs piped stdio');
    const fail = (reason: string) => this.close(new AcpRpcError('closed', -32099, `ACP connection closed (${reason})`));
    readJsonLines(child.stdout, (message) => this.receive(message), fail);
    child.stdin.on('error', () => fail('stdin'));
    child.once('exit', () => fail('exit'));
    child.once('error', () => fail('spawn'));
  }

  get isClosed(): boolean { return this.closed !== undefined; }

  onNotification(listener: (note: AcpNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) { listener(this.closed); return () => {}; }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** `timeoutMs` 0 = wait until answered or closed (a prompt turn can wait hours for approvals). */
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> } = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => { this.pending.delete(id); reject(new AcpRpcError('timeout', -32098, `The agent did not answer ${method}.`)); }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { if (entry.timer) clearTimeout(entry.timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  notify(method: string, params: unknown = {}): void {
    try { this.write({ jsonrpc: '2.0', method, params }); } catch { /* connection gone */ }
  }

  close(error: AcpRpcError = new AcpRpcError('closed', -32099, 'ACP connection closed')): void {
    if (this.closed) return;
    this.closed = error;
    for (const entry of this.pending.values()) { if (entry.timer) clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(error); } catch { /* isolate */ } }
    this.closeListeners.clear();
  }

  private write(message: unknown): void {
    if (this.closed) throw this.closed;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new AcpRpcError('closed', -32099, 'ACP agent stdin unavailable');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message.id;
    const method = str(message.method);
    if (method && id !== undefined && id !== null) { void this.answerAgent(id, method, isRecord(message.params) ? message.params : {}); return; }
    if (method) {
      const note = { method, params: isRecord(message.params) ? message.params : {} };
      for (const listener of this.listeners) { try { listener(note); } catch { /* isolate */ } }
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32603;
      entry.reject(new AcpRpcError('remote', code, rpcErrorText(message.error)));
    } else entry.resolve(message.result);
  }

  private async answerAgent(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
    let reply: Record<string, unknown>;
    if (!this.handler) reply = { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: 'This action is not available.' } };
    else {
      try { reply = { jsonrpc: '2.0', id, result: (await this.handler(method, params)) ?? null }; }
      catch (error) {
        const code = error instanceof AcpRpcError ? error.rpcCode : -32603;
        reply = { jsonrpc: '2.0', id, error: { code, message: error instanceof AcpRpcError ? error.message : 'The request failed.' } };
      }
    }
    try { this.write(reply); } catch { /* connection gone */ }
  }
}

export interface AuthMethod { id: string; name: string; description?: string }

/** What the agent said about itself in its initialize answer. */
export interface AgentInfo {
  protocolVersion: number;
  loadSession: boolean; // session/load (replays the history as session/update)
  resumeSession: boolean; // session/resume (no replay)
  closeSession: boolean; // session/close
  images: boolean; // image content blocks in prompts
  audio: boolean; // B-058 G7: audio content blocks in prompts (promptCapabilities.audio)
  mcpHttp: boolean; // HTTP MCP servers in session/new
  authMethods: AuthMethod[];
  title?: string;
}

const present = (value: unknown) => value !== undefined && value !== null && value !== false;

export function parseAgentInfo(result: unknown): AgentInfo {
  const r = isRecord(result) ? result : {};
  const caps = isRecord(r.agentCapabilities) ? r.agentCapabilities : {};
  const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {};
  const mcp = isRecord(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
  const sessions = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
  const agent = isRecord(r.agentInfo) ? r.agentInfo : {};
  const methods = Array.isArray(r.authMethods) ? r.authMethods : [];
  return {
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : ACP_PROTOCOL_VERSION,
    loadSession: caps.loadSession === true,
    resumeSession: present(sessions.resume),
    closeSession: present(sessions.close),
    images: prompt.image === true,
    audio: prompt.audio === true,
    mcpHttp: mcp.http === true,
    authMethods: methods.filter(isRecord).flatMap((m) => {
      const id = str(m.id);
      return id && id.length <= 200 ? [{ id, name: (str(m.name) ?? id).slice(0, 200), description: str(m.description)?.slice(0, 500) }] : [];
    }).slice(0, 20),
    title: (str(agent.title) ?? str(agent.name))?.slice(0, 200),
  };
}

/** Sends initialize; rejects when the agent speaks another protocol version. */
export async function initialize(conn: AcpConnection, version: string): Promise<AgentInfo> {
  const result = await conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'workforce', title: 'Autark', version },
  }, 30_000);
  const info = parseAgentInfo(result);
  if (info.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpRpcError('remote', -32600, 'The agent speaks an unsupported ACP version.');
  return info;
}
