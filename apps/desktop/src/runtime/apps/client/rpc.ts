// B-052 track A: the JSON-RPC 2.0 plumbing of the MCP client, shared by both transports (http.ts, stdio.ts) and the
// session (session.ts): protocol versions, the _meta of the stateless 2026-07-28 era, message shapes, reading an
// untrusted answer, the reply to a server request (ping → {}, everything else → -32601) and the internal errors the
// session decides on (an expired HTTP session, an HTTP status with its JSON-RPC error code).
// Owns: these shapes and helpers and the Wire seam a transport implements. Never: sends anything itself, keeps a
// header value, or puts a response body into a message (server text is clipped and stays data).

import { classify, clip, isRecord } from '../../mcp/jsonrpc.ts';
import { McpProtocolError, McpTransportError } from '../types.ts';

/** classify: server requests and notifications (anything that is not a response) – the hub's defensive reader. */
export { classify, clip, isRecord };

/** The `initialize` era, newest first (we ask for the first; the server may answer an older one). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** stdio servers built with an older SDK answer this; tools/list and tools/call are the same on that wire. */
export const STDIO_OLD_VERSION = '2024-11-05';
/** The stateless era (`server/discover`, `_meta` on every request). */
export const MODERN_VERSIONS = ['2026-07-28'] as const;

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_CLIENT = 'io.modelcontextprotocol/clientInfo';

export const CODE = {
  methodNotFound: -32601,
  internal: -32603,
  unsupportedVersion: -32022,
} as const;

export type RpcId = string | number;

export interface RpcRequest { jsonrpc: '2.0'; id: RpcId; method: string; params?: Record<string, unknown> }
export interface RpcNotification { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }
export interface RpcErrorBody { code: number; message: string; data?: unknown }
export interface RpcReply { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: RpcErrorBody }
export type RpcOutgoing = RpcRequest | RpcNotification | RpcReply;

/** What a transport does for the session. Every failure is an Mcp* error (or SessionExpired / HttpStatusError). */
export interface Wire {
  /** Sends one request and resolves with the server's answer to its id. Rejects promptly when `signal` aborts.
   *  `toolCall`: a failure after sending reports `sent: true` (the call may have run). */
  send(message: RpcRequest, signal: AbortSignal, toolCall: boolean): Promise<RpcReply>;
  /** A notification or the reply to a server request; resolves when handed over (errors are the caller's to drop). */
  deliver(message: RpcNotification | RpcReply): Promise<void>;
  /** Legacy era: the negotiated version (sent as MCP-Protocol-Version from now on). */
  negotiated(version: string): void;
  /** Forgets the HTTP session before a new `initialize` (stdio: nothing). */
  reset(): void;
  /** A user-safe hint when the server did not answer the handshake (stdio: it printed non-MCP text). */
  hint(): string | undefined;
  close(): Promise<void>;
}

/** Messages a wire gets that are not the answer it waits for: server requests and notifications. */
export type IncomingHandler = (message: unknown) => void;

/** HTTP 404 on a request that carried an Mcp-Session-Id: the session is gone, `initialize` again (spec). */
export class SessionExpired extends Error {
  constructor() { super('The app ended the session.'); this.name = 'SessionExpired'; }
}

/** An HTTP error status; `rpc` is the JSON-RPC error code/data of a JSON error body (for the session's decisions,
 *  never shown). The message names only the status. */
export class HttpStatusError extends McpTransportError {
  readonly status: number;
  readonly rpc?: { code: number; data?: unknown };
  constructor(status: number, sent: boolean, rpc?: { code: number; data?: unknown }) {
    super(`The app answered with HTTP ${status}.`, sent);
    this.name = 'HttpStatusError';
    this.status = status;
    this.rpc = rpc;
  }
}

/** A JSON-RPC error answer, with its `data` kept for version negotiation (-32022 data.supported). */
export class RpcAnswerError extends McpProtocolError {
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) { super(code, message); this.data = data; }
}

/** The error code (and data) of either answer form: a JSON-RPC error, or an HTTP status with a JSON-RPC body. */
export function rpcCodeOf(error: unknown): { code: number; data?: unknown } | undefined {
  if (error instanceof RpcAnswerError) return { code: error.code, data: error.data };
  if (error instanceof McpProtocolError) return { code: error.code };
  if (error instanceof HttpStatusError) return error.rpc;
  return undefined;
}

/** Turns an untrusted error object into an RpcAnswerError with a clipped, control-free message. */
export function answerError(error: unknown): RpcAnswerError {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === 'number' && Number.isFinite(record.code) ? Math.trunc(record.code) : CODE.internal;
  const text = typeof record.message === 'string' && record.message.trim() ? clip(record.message.trim(), 200) : 'The app reported an error.';
  return new RpcAnswerError(code, text, record.data);
}

/** A JSON-RPC response (id plus result or error, no method), or undefined. */
export function asReply(message: unknown): RpcReply | undefined {
  if (!isRecord(message) || 'method' in message) return undefined;
  const id = message.id;
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  if (!('result' in message) && !('error' in message)) return undefined;
  const failed = message.error !== undefined && message.error !== null; // some servers send `error: null` next to a result
  return { jsonrpc: '2.0', id, result: message.result, error: failed ? answerError(message.error) : undefined };
}

/** Our answer to a server request: ping is answered, nothing else is supported (no sampling, elicitation, roots). */
export function serverRequestReply(id: RpcId, method: string): RpcReply {
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: CODE.methodNotFound, message: 'Not supported by this client.' } };
}

/** The 2026-07-28 version a request carries in `_meta`, if any. */
export function metaVersionOf(message: RpcOutgoing): string | undefined {
  const params = 'params' in message ? message.params : undefined;
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  const version = meta?.[META_VERSION];
  return typeof version === 'string' ? version : undefined;
}

/** The value of a stateless request's Mcp-Name header (the tool, prompt or resource it names). */
export function nameOf(message: RpcRequest): string | undefined {
  const params = message.params ?? {};
  const value = message.method === 'resources/read' ? params.uri : message.method === 'tools/call' || message.method === 'prompts/get' ? params.name : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

/** A user-safe failure for a request that got no answer; `sent` only matters for tools/call. */
export function noAnswer(toolCall: boolean, what = 'The app sent no answer.'): McpTransportError {
  return new McpTransportError(what, toolCall);
}
