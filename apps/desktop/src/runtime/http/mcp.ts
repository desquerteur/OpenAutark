// `POST /mcp/<token>` and `POST /mcp` (Authorization: Bearer) → the MCP hub (Streamable HTTP,
// JSON response mode). Engines (Codex, Claude Code, ACP agents) run on this PC, so the route is
// loopback-only; GET/DELETE answer 405 (no SSE stream, sessions end with the lease).
// Owns: transport details – body limit, JSON-RPC parse errors, header pass-through.
// Never: interprets MCP messages (the hub does) or forwards cookies/authorization headers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../contracts.ts';
import { BASE_HEADERS, HttpError, readJson, sendBodyError, sendJson } from './body.ts';
import { bearerToken } from './security.ts';
import type { McpHttp, RequestInfo } from './types.ts';

export const MCP_BODY_LIMIT = 4 * 1024 * 1024;

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

/** Request headers handed to the hub (lowercase names; secrets stripped). */
function forwardHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'authorization' || name === 'cookie' || name === 'proxy-authorization') continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Response headers the hub may set (e.g. Mcp-Session-Id); never framing or CORS headers. */
function safeReplyHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower.startsWith('access-control-')) continue;
    if (typeof value === 'string' && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, info: RequestInfo, deps: { mcp: McpHttp; log: () => Logger }, pathToken: string | undefined): Promise<void> {
  if (!info.loopback) {
    sendJson(res, 403, jsonRpcError(-32001, 'MCP is only available on this computer.'));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'POST', 'Content-Length': '0' });
    res.end();
    return;
  }
  const token = pathToken ?? bearerToken(req.headers.authorization);
  let body: unknown;
  try {
    body = await readJson(req, MCP_BODY_LIMIT);
  } catch (error) {
    if (error instanceof HttpError) {
      sendBodyError(req, res, error, (failure) => jsonRpcError(failure.status === 413 ? -32600 : -32700, failure.status === 413 ? 'Request too large.' : 'Parse error.'));
      return;
    }
    throw error;
  }
  let reply;
  try {
    reply = await deps.mcp.handle(token, body, forwardHeaders(req));
  } catch (error) {
    deps.log().error('mcp request failed', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, jsonRpcError(-32603, 'Internal error.'));
    return;
  }
  const status = Number.isInteger(reply?.status) && reply.status >= 200 && reply.status < 600 ? reply.status : 500;
  const headers = safeReplyHeaders(reply?.headers);
  if (reply?.body === undefined) {
    res.writeHead(status, { ...BASE_HEADERS, ...headers, 'Content-Length': '0' });
    res.end();
    return;
  }
  sendJson(res, status, reply.body, headers);
}
