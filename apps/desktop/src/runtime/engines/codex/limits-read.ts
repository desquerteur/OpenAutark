// B-044 Codex limits read on the app server (split from engine.ts): `account/rateLimits/read` with the
// client capability `excludeResetCreditDetails` (generated schema of codex-cli 0.162, GetAccountRateLimitsParams:
// "Skip the separate reset-credit detail lookup for background usage polls. The usage response still
// includes the available count"). A background read (the account monitor's 15 s cadence) asks without the
// details; the person opening the limits (Settings › Models & accounts, the quota card) and the read after a
// reset was used ask for them – accounts/limits.ts mergeLimits keeps the stored details meanwhile. A Codex
// that refuses the parameter with an error answer (an older app server) is asked again without it, and
// `plain` remembers that for the engine's later reads; a timeout or a closed connection is no refusal.
// Owns: this request's parameters and that fallback. Never: normalizes or stores the answer (engine.ts,
// accounts/limits.ts do).

import { RpcError, type RpcClient } from './rpc.ts';

/** The client's own "no answer" code (rpc.ts request timeout) – not a refusal of the parameter. */
const RPC_TIMEOUT = -32000;

/** Whether this engine's Codex refused excludeResetCreditDetails before (its later reads ask without it). */
export interface PlainReads { value: boolean }

/** The raw `account/rateLimits/read` answer; `details` false skips the reset credits' detail lookup where Codex supports it. */
export async function readRateLimits(rpc: Pick<RpcClient, 'request'>, details: boolean, plain: PlainReads): Promise<unknown> {
  if (details || plain.value) return rpc.request('account/rateLimits/read', {});
  try {
    return await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true });
  } catch (error) {
    if (!(error instanceof RpcError) || error.rpcCode === RPC_TIMEOUT) throw error;
    const answer = await rpc.request('account/rateLimits/read', {});
    plain.value = true; // the plain read answered: this Codex does not know the parameter
    return answer;
  }
}
