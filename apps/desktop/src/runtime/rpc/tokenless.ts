// The tokenless `POST /rpc` route of the RPC server (split out of rpc/server.ts): one request
// frame from a page that has no device token yet. Only these methods answer here – pairing a phone
// by its one-time QR link (`pwa.exchange`) and an employee's device joining the organisation
// (`people.join`, then `people.awaitJoin`, a long request that ends when the page goes away).
// They run as an anonymous device scope without capabilities, with the caller's address
// (rpc/caller.ts) for per-address limits.
// Owns: the allow-list, framing and the exchange fallback. Never: authentication, other
// methods, or logging params (the secret and ticket are in them).

import { isRequest } from '../../shared/api/protocol.ts';
import type { ClientScope, RpcResponse } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import { withCaller } from './caller.ts';
import { parseFrame } from './connection.ts';
import type { RpcExtras } from './extras.ts';
import type { HandlerContext, HandlerTable } from './table.ts';

/** Scope of the tokenless route (no capabilities at all). */
export const ANONYMOUS: ClientScope = { kind: 'device', deviceId: '', capabilities: [] };
/** Methods the tokenless route serves; everything else answers "Sign in first." */
export const TOKENLESS: ReadonlySet<string> = new Set(['pwa.exchange', 'people.join', 'people.awaitJoin']);
const NEVER = new AbortController().signal;

/** Facts of a tokenless HTTP call (http/rpc.ts): the caller's address and the end of its request. */
export interface HttpCallMeta {
  remote?: string;
  signal?: AbortSignal;
}

export interface TokenlessDeps {
  table: HandlerTable;
  context(scope: ClientScope, signal: AbortSignal): HandlerContext;
  errorData(error: unknown, method: string): WorkforceErrorData;
}

/** Serves one tokenless frame. The table's scope rule is for authenticated sockets; this route is the pairing exception. */
export async function serveTokenless(frame: unknown, meta: HttpCallMeta, deps: TokenlessDeps): Promise<RpcResponse> {
  const request = parseFrame(frame);
  const id = request && isRequest(request) && typeof request.id === 'number' && Number.isFinite(request.id) ? request.id : 0;
  if (!request || !isRequest(request) || typeof request.method !== 'string') {
    return { id, error: { code: 'bad_request', message: 'Send one RPC request.' } };
  }
  const method = request.method;
  if (!TOKENLESS.has(method)) return { id, error: { code: 'forbidden', message: 'Sign in first.' } };
  try {
    const entry = deps.table.get(method);
    const ctx = deps.context(ANONYMOUS, meta.signal ?? NEVER);
    const run = () => (entry ? entry.handler(request.params as never, ctx)
      : method === 'pwa.exchange' ? exchangeDirect(request.params, ctx.extras)
        : Promise.reject(new WorkforceError('not_found', 'Unknown method.', { details: { method } })));
    const result = await withCaller({ scope: ANONYMOUS, remote: meta.remote ?? '' }, run);
    return { id, result: result ?? null };
  } catch (error) {
    return { id, error: deps.errorData(error, method) };
  }
}

/** Fallback when no handler module registered `pwa.exchange` (the PWA must still pair). */
async function exchangeDirect(params: unknown, extras: RpcExtras): Promise<{ token: string; deviceId?: string }> {
  const value = (params && typeof params === 'object' ? params : {}) as { secret?: unknown; name?: unknown };
  if (typeof value.secret !== 'string' || !value.secret || value.secret.length > 200) {
    throw new WorkforceError('bad_request', 'The pairing link is incomplete.');
  }
  const name = typeof value.name === 'string' ? value.name.slice(0, 60) : undefined;
  return extras.pwa.exchange(value.secret, { name });
}
