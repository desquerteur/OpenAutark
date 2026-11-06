// The MCP hub: ONE Streamable-HTTP MCP server inside the runtime for every CLI engine run
// (Claude Code, ACP agents …) instead of an MCP server copy per CLI process.
// Each run gets a lease: a random 32-byte token mapped to the run's tool context (agent, run,
// chat, task, mode, device). The HTTP server calls handle() for `POST /mcp/<token>` and for
// `POST /mcp` with `Authorization: Bearer <token>`. JSON response mode only (no SSE):
// initialize (version echo + Mcp-Session-Id), ping, tools/list (the agent's tools for its mode
// under MCP-safe wire names), tools/call (→ ToolRegistry.call with the lease context, so validation,
// idempotency and the run journal apply), notifications → 202, batches.
// No resources (B-044: the secret area resources are gone; secrets are files and tools – secrets.list,
// secrets.run – through that same tool path).
// Releasing a lease aborts its in-flight calls; the token is rejected afterwards (401).
// The 2026-07-28 stateless core works too: nothing here depends on initialize.
// Owns: leases, the JSON-RPC/MCP method handling, version negotiation.
// Never: runs a tool outside ToolRegistry.call, accepts an unknown token, logs tokens or tool
// arguments, opens SSE streams or sends server-initiated requests.

import { randomBytes } from 'node:crypto';
import type { McpHub, RuntimeServices } from '../contracts.ts';
import type { ToolContext, ToolSpec } from '../tools/types.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { toErrorData, WorkforceError } from '../../shared/errors.ts';
import { classify, clip, isRecord, RPC_ERROR, rpcError, rpcResult, type JsonRpcId, type RpcResponse } from './jsonrpc.ts';
import { errorResult, toCallResult, toMcpTool } from './convert.ts';
import { McpToolNames } from './names.ts';
import { engineOffer } from '../tools/learned.ts'; // B-049 F4

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'] as const;
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const MAX_BATCH = 64;
const MAX_TOKEN = 128;

export type LeaseContext = Omit<ToolContext, 'services' | 'signal' | 'status'>;

export interface McpDeps {
  services: () => RuntimeServices;
  /** Origin of the runtime's HTTP server, e.g. "http://127.0.0.1:47213". */
  baseUrl: () => string;
  version?: string;
}

export interface McpHttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface LeaseState {
  ctx: LeaseContext;
  controller: AbortController;
  inflight: Map<string, AbortController>; // JSON-RPC request id → call (notifications/cancelled)
  specs?: ToolSpec[]; // offered tools, computed once per lease (mode is fixed for a run)
}

type Reply = { response?: RpcResponse; sessionId?: string; invalid?: boolean } | undefined;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PARSE_ERROR = Symbol('parse_error');

export class Mcp implements McpHub {
  private readonly deps: McpDeps;
  private readonly leases = new Map<string, LeaseState>();
  private callSeq = 0; // process-wide: call ids stay unique per run even across leases (failover)

  constructor(deps: McpDeps) {
    this.deps = deps;
  }

  lease(ctx: LeaseContext): { url: string; token: string; release(): void } {
    const token = randomBytes(32).toString('base64url');
    const state: LeaseState = { ctx: { ...ctx }, controller: new AbortController(), inflight: new Map() };
    this.leases.set(token, state);
    return {
      url: `${this.base()}/mcp/${token}`,
      token,
      release: () => {
        if (this.leases.get(token) !== state) return;
        this.leases.delete(token);
        state.controller.abort(new WorkforceError('cancelled', 'The run ended.'));
      },
    };
  }

  url(): string {
    return `${this.base()}/mcp`;
  }

  /** Number of live leases (diagnostics). */
  active(): number {
    return this.leases.size;
  }

  /** Shutdown: aborts every in-flight call and forgets all leases. */
  close(): void {
    for (const state of this.leases.values()) state.controller.abort(new WorkforceError('cancelled', 'The runtime is shutting down.'));
    this.leases.clear();
  }

  /** One HTTP POST to the hub. `token` comes from the path; otherwise the Bearer header counts. */
  async handle(token: string | undefined, body: unknown, headers: Record<string, string | undefined> = {}): Promise<McpHttpResponse> {
    const h = lowerKeys(headers);
    const lease = this.resolve(token, h.authorization);
    if (!lease) {
      return { status: 401, body: rpcError(null, RPC_ERROR.unauthorized, 'Unknown or expired token.'), headers: { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer' } };
    }
    if (h.origin && !this.originAllowed(h.origin)) {
      return { status: 403, body: rpcError(null, RPC_ERROR.invalidRequest, 'Origin not allowed.'), headers: JSON_HEADERS };
    }
    const payload = parseBody(body);
    if (payload === PARSE_ERROR) return { status: 400, body: rpcError(null, RPC_ERROR.parse, 'Parse error.'), headers: JSON_HEADERS };
    const batch = Array.isArray(payload);
    const messages: unknown[] = batch ? payload : [payload];
    if (!messages.length || messages.length > MAX_BATCH) {
      return { status: 400, body: rpcError(null, RPC_ERROR.invalidRequest, batch && messages.length ? 'Batch too large.' : 'Empty batch.'), headers: JSON_HEADERS };
    }
    // The header names the negotiated version; `initialize` negotiates it in the body instead.
    const version = h['mcp-protocol-version'];
    if (version !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version) && !messages.some(isInitialize)) {
      return { status: 400, body: rpcError(null, RPC_ERROR.invalidRequest, 'Unsupported MCP-Protocol-Version.'), headers: JSON_HEADERS };
    }

    const replies = await Promise.all(messages.map((message) => this.message(lease, message)));
    const responses = replies.flatMap((reply) => (reply?.response ? [reply.response] : []));
    const sessionId = replies.find((reply) => reply?.sessionId)?.sessionId;
    const extra: Record<string, string> = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
    if (!responses.length) return { status: 202, headers: extra };
    if (!batch && replies[0]?.invalid) return { status: 400, body: responses[0], headers: { ...JSON_HEADERS, ...extra } };
    return { status: 200, body: batch ? responses : responses[0], headers: { ...JSON_HEADERS, ...extra } };
  }

  // ------------------------------------------------------------------ internals

  private base(): string {
    return this.deps.baseUrl().replace(/\/+$/, '');
  }

  private resolve(token: string | undefined, authorization: string | undefined): LeaseState | undefined {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1];
    for (const candidate of [token, bearer]) {
      if (!candidate || candidate.length > MAX_TOKEN) continue;
      const lease = this.leases.get(candidate);
      if (lease && !lease.controller.signal.aborted) return lease;
    }
    return undefined;
  }

  /** CLI clients send no Origin; a browser page may only reach the hub from our own origin. */
  private originAllowed(origin: string): boolean {
    try { return new URL(origin).origin === new URL(this.base()).origin; } catch { return false; }
  }

  private async message(lease: LeaseState, raw: unknown): Promise<Reply> {
    const message = classify(raw);
    switch (message.kind) {
      case 'invalid':
        return { response: rpcError(message.id, RPC_ERROR.invalidRequest, 'Invalid request.'), invalid: true };
      case 'response':
        return undefined;
      case 'notification':
        this.notification(lease, message.method, message.params);
        return undefined;
      case 'request':
        if (message.badParams) return { response: rpcError(message.id, RPC_ERROR.invalidParams, 'Params must be an object.') };
        try {
          return await this.request(lease, message.id, message.method, message.params ?? {});
        } catch (error) {
          this.deps.services().log.warn('mcp request failed', { method: clip(message.method, 60), error: clip(error instanceof Error ? error.message : String(error), 300) });
          return { response: rpcError(message.id, RPC_ERROR.internal, 'Internal error.') };
        }
    }
  }

  private notification(lease: LeaseState, method: string, params: Record<string, unknown> | undefined): void {
    if (method !== 'notifications/cancelled' || !params) return;
    const requestId = params.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    lease.inflight.get(String(requestId))?.abort(new WorkforceError('cancelled', 'The client cancelled the call.'));
  }

  private async request(lease: LeaseState, id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<Reply> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
        return {
          response: rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'workforce', version: this.version() },
          }),
          sessionId: randomBytes(16).toString('base64url'),
        };
      }
      case 'ping':
        return { response: rpcResult(id, {}) };
      case 'tools/list':
        return { response: rpcResult(id, { tools: this.specs(lease).map(toMcpTool) }) };
      case 'tools/call':
        return { response: await this.call(lease, id, params) };
      default:
        return { response: rpcError(id, RPC_ERROR.methodNotFound, `Method not found: ${clip(method, 60)}`) };
    }
  }

  private specs(lease: LeaseState): ToolSpec[] {
    if (lease.specs) return lease.specs;
    const services = this.deps.services();
    let mode: ModeInfo;
    try { mode = services.modes.get(lease.ctx.mode); } catch { mode = services.modes.get('general'); }
    // B-049 F4: core set + learned + tools.find/tools.call (as the turn's key). B-057 S8: a split's lease has no chat – its
    // learned tools are its parent chat's (split-turn.ts offerScope), so a forked session gets the parent's exact list.
    const scope = lease.ctx.conversationId ?? lease.ctx.split?.parentConversationId;
    lease.specs = engineOffer(services, lease.ctx.agent, mode, { ownTools: true, via: 'mcp' }, scope);
    return lease.specs;
  }

  private async call(lease: LeaseState, id: JsonRpcId, params: Record<string, unknown>): Promise<RpcResponse> {
    const called = params.name;
    if (typeof called !== 'string' || !called) return rpcError(id, RPC_ERROR.invalidParams, 'Missing tool name.');
    const args = params.arguments ?? {};
    if (!isRecord(args)) return rpcError(id, RPC_ERROR.invalidParams, 'Tool arguments must be an object.');
    const name = new McpToolNames(this.specs(lease)).resolve(called);
    if (!name) return rpcError(id, RPC_ERROR.invalidParams, `Unknown tool: ${clip(called)}`);

    const services = this.deps.services();
    const call = new AbortController();
    const key = String(id);
    lease.inflight.set(key, call);
    try {
      const signal = AbortSignal.any([lease.controller.signal, call.signal]);
      const output = await services.tools.call(name, args, { ...lease.ctx, signal, status: () => {} }, `mcp-${++this.callSeq}`);
      return rpcResult(id, toCallResult(output));
    } catch (error) {
      // Tool failures are results the model can read, not protocol errors.
      services.log.warn('mcp tool call failed', { tool: name, runId: lease.ctx.runId, error: clip(error instanceof Error ? error.message : String(error), 300) });
      return rpcResult(id, errorResult(toErrorData(error).message));
    } finally {
      if (lease.inflight.get(key) === call) lease.inflight.delete(key);
    }
  }

  private version(): string {
    if (this.deps.version) return this.deps.version;
    try { return this.deps.services().host.app.version || '0.0.0'; } catch { return '0.0.0'; }
  }
}

/** The HTTP server normally passes parsed JSON; strings and bytes are parsed here. */
function parseBody(body: unknown): unknown {
  let text: string | undefined;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  if (text === undefined) return body === undefined ? PARSE_ERROR : body;
  try { return JSON.parse(text) as unknown; } catch { return PARSE_ERROR; }
}

function isInitialize(message: unknown): boolean {
  return isRecord(message) && message.method === 'initialize';
}

function lowerKeys(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  return out;
}
