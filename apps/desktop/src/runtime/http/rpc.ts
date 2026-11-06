// `POST /rpc`: one RpcRequest frame without a token (the PWA's pairing exchange `pwa.exchange`
// trades a one-time secret for a device token; a person's device joins with `people.join` and
// waits up to 55 s with `people.awaitJoin`). JSON body ≤ 64 KB, rate-limited per address;
// the RPC server decides which methods are allowed on this path. The call gets the caller's
// address and a signal that aborts when the page goes away before the answer (a long wait ends).
// B-050 K8 (d): with `Authorization: Bearer <token>` the frame runs with that token's scope – the
// same tokens and rules as the /ws Hello (the server's `scope` decides) – over a one-shot
// connection of the RPC server (body ≤ 6 MB, one files.upload; its own per-address limit, which also
// counts calls with a wrong token); a missing or unknown token answers 401, a revoked one 403.
// Without the header the tokenless path stays.
// Owns: the transport (limits, JSON, RpcResponse framing, the one-shot connection). Never:
// authentication or dispatch.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientScope, RpcResponse } from '../../shared/api/protocol.ts';
import { toErrorData } from '../../shared/errors.ts';
import type { Logger } from '../contracts.ts';
import type { HttpCallMeta } from '../rpc/tokenless.ts';
import { HttpError, readJson, sendBodyError, sendJson } from './body.ts';
import { header } from './request.ts';
import { bearerToken, type RateLimiter } from './security.ts';
import type { RequestInfo, RpcAttach, RpcConnection } from './types.ts';

export const RPC_BODY_LIMIT = 64 * 1024;
/** A bearer call's frame: one files.upload request (rpc/uploads.ts) and its envelope. */
export const BEARER_BODY_LIMIT = 6 * 1024 * 1024;

/** Token → scope as on /ws; 'revoked' for a token that was taken back. */
export type BearerScope = (token: string) => ClientScope | 'revoked' | undefined;

/** RpcServer.handleHttp also takes the call's facts; RpcAttach (types.ts) names only the frame so far. */
type TokenlessRpc = RpcAttach & { handleHttp(frame: unknown, meta?: HttpCallMeta): Promise<RpcResponse> };

function requestId(frame: unknown): number {
  const id = (frame as { id?: unknown } | null)?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : 0;
}

export async function handleRpcPost(req: IncomingMessage, res: ServerResponse, info: RequestInfo, deps: { rpc: RpcAttach; limiter: RateLimiter; log: () => Logger }): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { id: 0, error: { code: 'bad_request', message: 'Use POST.' } } satisfies RpcResponse, { Allow: 'POST' });
    return;
  }
  if (!deps.limiter.take(info.remote || 'unknown')) {
    sendJson(res, 429, { id: 0, error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.', retryAfterMs: 60_000 } } satisfies RpcResponse, { 'Retry-After': '60' });
    return;
  }
  let frame: unknown;
  try {
    frame = await readJson(req, RPC_BODY_LIMIT);
  } catch (error) {
    if (error instanceof HttpError) {
      sendBodyError(req, res, error, (failure) => ({ id: 0, error: { code: failure.code, message: failure.message } } satisfies RpcResponse));
      return;
    }
    throw error;
  }
  // The page went away before the answer: a long wait (people.awaitJoin) ends at once.
  const gone = new AbortController();
  res.once('close', () => { if (!res.writableFinished) gone.abort(); });
  try {
    const reply = await (deps.rpc as TokenlessRpc).handleHttp(frame, { remote: info.remote, signal: gone.signal });
    if (!res.destroyed) sendJson(res, 200, reply);
  } catch (error) {
    deps.log().error('rpc over http failed', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { id: requestId(frame), error: toErrorData(error) } satisfies RpcResponse);
  }
}

const reject = (res: ServerResponse, status: number, code: 'forbidden' | 'bad_request', message: string) =>
  sendJson(res, status, { id: 0, error: { code, message } } satisfies RpcResponse, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});

/** B-050 K8 (d): `POST /rpc` with a bearer token – one request with that token's scope. */
export async function handleBearerRpc(req: IncomingMessage, res: ServerResponse, info: RequestInfo, deps: { rpc: RpcAttach; limiter: RateLimiter; log: () => Logger; scope: BearerScope }): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { id: 0, error: { code: 'bad_request', message: 'Use POST.' } } satisfies RpcResponse, { Allow: 'POST' });
    return;
  }
  // Counted before the token check: a wrong token costs lookups too, so guessing is throttled as well.
  if (!deps.limiter.take(info.remote || 'unknown')) {
    sendJson(res, 429, { id: 0, error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.', retryAfterMs: 60_000 } } satisfies RpcResponse, { 'Retry-After': '60' });
    return;
  }
  const token = bearerToken(header(req.headers.authorization));
  const scope = token ? deps.scope(token) : undefined;
  if (scope === 'revoked') return reject(res, 403, 'forbidden', 'This token was revoked.');
  if (!scope) return reject(res, 401, 'forbidden', 'A valid token is required.');
  let frame: unknown;
  try {
    frame = await readJson(req, BEARER_BODY_LIMIT);
  } catch (error) {
    if (error instanceof HttpError) {
      sendBodyError(req, res, error, (failure) => ({ id: 0, error: { code: failure.code, message: failure.message } } satisfies RpcResponse));
      return;
    }
    throw error;
  }
  const request = frame as { method?: unknown; params?: unknown } | null;
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') return reject(res, 400, 'bad_request', 'Send one RPC request: {"id": 1, "method": "…", "params": {…}}.');
  const gone = new AbortController();
  res.once('close', () => { if (!res.writableFinished) gone.abort(); });
  try {
    const reply = await callOnce(deps.rpc, scope, { id: requestId(frame), method: request.method, params: request.params }, gone.signal);
    if (!res.destroyed) sendJson(res, 200, reply);
  } catch (error) {
    deps.log().error('rpc over http failed', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { id: requestId(frame), error: toErrorData(error) } satisfies RpcResponse);
  }
}

/** Runs one request over a connection attached for just this call; it closes with the answer (or when the caller went). */
function callOnce(rpc: RpcAttach, scope: ClientScope, frame: { id: number; method: string; params: unknown }, gone: AbortSignal): Promise<RpcResponse> {
  return new Promise((resolve) => {
    let listener: ((data: unknown) => void) | undefined;
    const closers: Array<() => void> = [];
    let detach: (() => void) | undefined;
    let done = false;
    const finish = (reply: RpcResponse) => {
      if (done) return;
      done = true;
      resolve(reply);
      for (const closed of closers.splice(0)) { try { closed(); } catch { /* cleanup only */ } }
      detach?.();
    };
    const connection: RpcConnection = {
      send(out) { if ((out as { id?: unknown } | null)?.id === frame.id && !('event' in (out as object))) finish(out as RpcResponse); },
      close() { finish({ id: frame.id, error: { code: 'unavailable', message: 'The call ended before its answer.' } }); },
      onMessage(next) { listener = next; },
      onClose(next) { if (done) next(); else closers.push(next); },
    };
    detach = rpc.attach(connection, scope);
    if (done) { detach(); return; }
    gone.addEventListener('abort', () => connection.close(), { once: true });
    listener?.(JSON.stringify(frame));
  });
}
