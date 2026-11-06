// JSON-RPC 2.0 plumbing for the MCP hub: classifying incoming messages and building replies.
// Owns: message shapes, error codes and the defensive classification of untrusted input.
// Never: interprets MCP methods (hub.ts does) or echoes untrusted input back unbounded.

export type JsonRpcId = string | number;

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Not defined by JSON-RPC/MCP; used for unknown or expired hub tokens (HTTP 401). */
  unauthorized: -32001,
} as const;

export interface RpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type Incoming =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> | undefined; badParams: boolean }
  | { kind: 'notification'; method: string; params: Record<string, unknown> | undefined }
  | { kind: 'response' } // a client reply to a server request (we never send any)
  | { kind: 'invalid'; id: JsonRpcId | null };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length <= 200) || (typeof value === 'number' && Number.isFinite(value));
}

/** Classifies one untrusted JSON value. */
export function classify(message: unknown): Incoming {
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id: isRecord(message) && validId(message.id) ? message.id : null };
  }
  const method = message.method;
  if (typeof method === 'string') {
    if (!method || method.length > 200) return { kind: 'invalid', id: validId(message.id) ? message.id : null };
    const params = message.params;
    const badParams = params !== undefined && !isRecord(params);
    const clean = isRecord(params) ? params : undefined;
    if (!('id' in message)) return { kind: 'notification', method, params: clean };
    if (!validId(message.id)) return { kind: 'invalid', id: null };
    return { kind: 'request', id: message.id, method, params: clean, badParams };
  }
  if (method === undefined && validId(message.id) && ('result' in message || 'error' in message)) return { kind: 'response' };
  return { kind: 'invalid', id: validId(message.id) ? message.id : null };
}

export function rpcResult(id: JsonRpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Clips untrusted text before it appears in an error message. */
export function clip(text: string, max = 80): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
