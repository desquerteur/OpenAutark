// B-059 #184/#10: a provider's transient failure – overloaded, a 5xx, the connection or the stream lost, a request that
// timed out – is an outage of the account, not a failure of the model: it is classified 'unavailable', so the existing
// outage path applies (accounts/failure.ts: a short cooling and one failover; tasks/ladder.ts: no stall and no attempt;
// agents/turn-finish.ts: the model's rating stays; agents/redelivery.ts: a chat turn is delivered again). The one place
// for these signals – structured ones or narrow, anchored texts only: a lasting error read as an outage would be retried
// quietly instead of escalating.
//   providerOutage (agents/turn-attempt.ts, every engine's result): an engine 'timeout' (ACP's session/new or
//     session/load) and a cloud provider's HTTP 500, 502 or 504 (the text of engines/http/common.ts statusError, which
//     leaves them 'internal'); never another 5xx (501 not supported, 505, 507 …) and never a local runtime's status
//     (ollama, lmstudio, llamacpp, vllm or any account on a loopback address): its 500 is a lasting failure of its own –
//     too little memory, a crashed runner – that must stall and escalate, not cool and retry;
//   claudeDown (engines/claude/engine.ts): Claude Code's assistant error 'server_error', or an error result
//     "API Error: 5xx …", "API Error: Connection error.", "API Error: Request timed out." or an overloaded_error;
//   codexDown and acpDown: the same for Codex's codexErrorInfo and an ACP agent's error message (applied where
//     engines/codex/turn.ts and engines/acp/turn.ts map their errors).
// Owns: these signals and the outage text. Never: classifies a 4xx, a refusal, a cut-off answer, a step limit or a setup
// error as an outage, or uses a text that reads as signed out or not installed (accounts/failure.ts SIGNED_OUT, NOT_INSTALLED).

import type { Account } from '../../shared/model/providers.ts';
import type { EngineTurnResult } from './types.ts';
import { isRecord, num } from './shared.ts';
import { LOCAL_PROVIDERS } from './http/common.ts';

/** The outage text of a provider that did not serve the turn (`who`: 'Anthropic', 'OpenAI', an ACP agent's name). */
export const providerDownMessage = (who: string): string => `${who} is overloaded or unreachable right now.`;

/** engines/http/common.ts statusError's text for the 5xx of a passing outage: 500, 502, 504 (503 and 529 it maps itself). */
const HTTP_DOWN = /^The model request failed \(HTTP 50[024]\)\.$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A local runtime: a local provider, or any account whose server runs on this PC. */
function localRuntime(account: Pick<Account, 'provider' | 'baseUrl'>): boolean {
  if (LOCAL_PROVIDERS.has(account.provider)) return true;
  try { return account.baseUrl !== undefined && LOOPBACK.has(new URL(account.baseUrl).hostname); } catch { return false; }
}

/** An engine's 'timeout', or a cloud provider's HTTP 500/502/504, as 'unavailable' (its text kept); any other result unchanged. */
export function providerOutage(result: EngineTurnResult, account: Pick<Account, 'provider' | 'baseUrl'>): EngineTurnResult {
  const error = result.stop === 'error' ? result.error : undefined;
  if (!error || error.details?.setup === true) return result;
  const httpDown = error.code === 'internal' && HTTP_DOWN.test(error.message) && !localRuntime(account);
  if (error.code === 'timeout' || httpDown) return { ...result, error: { ...error, code: 'unavailable' } };
  return result;
}

/** Claude Code's error results for an API it could not reach (a "API Error: 400 …" stays a failure). */
const CLAUDE_DOWN = /^API Error:? \(?(5\d\d\b|Repeated 529|Connection error|Request timed out)|\boverloaded_error\b/i;

/** Claude Code reported the API overloaded or unreachable (the turn's assistant error, or its error result's text). */
export function claudeDown(assistantError: string | undefined, errorText: string | undefined): boolean {
  return assistantError === 'server_error' || CLAUDE_DOWN.test(errorText ?? '');
}

const CODEX_DOWN = new Set(['serverOverloaded', 'internalServerError', 'flexUnavailable']);
const CODEX_DOWN_KEYS = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'];

/** A Codex `codexErrorInfo` of a provider outage: overloaded, a server error, or a lost connection without a 4xx (408 counts). */
export function codexDown(info: unknown): boolean {
  if (typeof info === 'string') return CODEX_DOWN.has(info);
  if (!isRecord(info)) return false;
  const key = CODEX_DOWN_KEYS.find((name) => name in info);
  if (!key) return false;
  const inner = info[key];
  const status = isRecord(inner) ? num(inner.httpStatusCode) : undefined;
  return status === undefined || status >= 500 || status === 408;
}

/** An ACP agent's error message of a provider outage ("status: 503", gRPC UNAVAILABLE, overloaded, a reset connection). */
const ACP_DOWN = /\b(?:status|code|HTTP)[\s:"=]*5(?:00|02|03|04|29)\b|\boverloaded\b|ECONNRESET|socket hang up|fetch failed/i;
export function acpDown(message: string | undefined): boolean {
  return Boolean(message) && (ACP_DOWN.test(message!) || /\bUNAVAILABLE\b/.test(message!));
}
