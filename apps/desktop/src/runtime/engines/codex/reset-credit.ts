// B-044 Codex banked resets on the app server (split from engine.ts): one call of
// `account/rateLimitResetCredit/consume` {idempotencyKey, creditId?} → {outcome} (generated schema of
// codex-cli 0.162; no creditId = the provider picks the next available credit). The key names one
// attempt – accounts/resets.ts keeps and reuses it on a retry. A Codex without the method refuses
// plainly ('unavailable': nothing was redeemed); any other failure (a timeout, an error answer)
// throws as it came, because the effect is then unknown.
// Owns: this request and its refusal. Never: makes up a key, retries, or reads the limits itself.

import { WorkforceError } from '../../../shared/errors.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { isRecord } from '../shared.ts';

/** JSON-RPC "method not found". */
const NO_METHOD = -32601;

/** The provider's outcome as sent (accounts/resets.ts checks it). */
export async function consumeResetCredit(rpc: Pick<RpcClient, 'request'>, idempotencyKey: string, creditId?: string): Promise<unknown> {
  try {
    const answer = await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey, ...(creditId ? { creditId } : {}) }, 60_000);
    return isRecord(answer) ? answer.outcome : undefined;
  } catch (error) {
    if (error instanceof RpcError && (error.rpcCode === NO_METHOD || /method not found|unknown variant/i.test(error.message))) {
      throw new WorkforceError('unavailable', 'This Codex version cannot use resets. Update Codex, then try again.');
    }
    throw error;
  }
}
