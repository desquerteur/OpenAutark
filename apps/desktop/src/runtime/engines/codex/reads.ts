// The Codex app server's account-level reads (split from engine.ts, B-044 integration): `model/list` (paged,
// hidden models dropped, the supported efforts remembered per model for the turn's nearest effort) and the
// account check – `account/read`, then for a ChatGPT plan the rate limits with or without the banked resets'
// credit details (limits-read.ts). The engine gets the server and keeps what these return.
// B-058 G7: a model whose `inputModalities` include 'audio' is listed with audioIn (the catalog's caps.audioIn,
// so the listener may route a recording to it) and remembered here, so the turn sends it audio as
// `localAudio` (turn.ts codexInput; a turn with a recording lists once more when no listing in this process named
// its model – after a restart the catalog may not re-list for 10 min). The owner's plan models were text+image only
// on 29.10.2026 (live).
// Owns: parsing these answers and the set of listed models that hear audio. Never: starts or stops a server,
// stores accounts or limits (AccountService does), or reads token files.

import type { AccountCheck, EngineModel } from '../types.ts';
import type { RpcClient } from './rpc.ts';
import { isRecord, normalizeEffort, str } from '../shared.ts';
import { normalizeCodexLimits } from '../../accounts/limits.ts';
import { readRateLimits, type PlainReads } from './limits-read.ts';

/** Codex models the last listings reported with audio input (model ids are the same on every account). */
const HEARING = new Set<string>();
/** Models a listing in this process reported at all (the catalog may skip re-listing for 10 min after a restart). */
const LISTED = new Set<string>();

/** Whether a listing reported that this Codex model hears audio (unknown before the first listing: no). */
export function codexHearsAudio(model: string): boolean {
  return HEARING.has(model);
}

/** codexHearsAudio, listing the models once first when no listing in this process reported `model` (a failed list: no). */
export async function codexHearsAudioNow(rpc: Pick<RpcClient, 'request'>, model: string): Promise<boolean> {
  if (!LISTED.has(model)) await listCodexModels(rpc, new Map()).catch(() => undefined);
  return HEARING.has(model);
}

/** The visible models (at most 200 read); `efforts` gets each model's supported reasoning efforts as Codex names them. */
export async function listCodexModels(rpc: Pick<RpcClient, 'request'>, efforts: Map<string, string[]>): Promise<EngineModel[]> {
  const out: EngineModel[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc.request<{ data?: unknown[]; nextCursor?: string | null }>('model/list', { limit: 100, includeHidden: false, cursor: cursor ?? null });
    for (const raw of Array.isArray(page?.data) ? page.data : []) {
      if (!isRecord(raw) || typeof raw.model !== 'string' || raw.model.length > 200) continue;
      const supported = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.map((e) => (isRecord(e) ? str(e.reasoningEffort) : undefined)).filter((e): e is string => Boolean(e)) : [];
      efforts.set(raw.model, supported);
      const normalized = [...new Set(supported.map(normalizeEffort).filter((e) => e !== undefined))];
      const modalities = Array.isArray(raw.inputModalities) ? raw.inputModalities : undefined;
      const audioIn = modalities ? modalities.includes('audio') : undefined;
      if (audioIn) HEARING.add(raw.model); else if (modalities) HEARING.delete(raw.model);
      LISTED.add(raw.model);
      out.push({
        model: raw.model, name: String(raw.displayName ?? raw.model).slice(0, 200), efforts: normalized,
        defaultEffort: normalizeEffort(raw.defaultReasoningEffort),
        vision: modalities ? modalities.includes('image') : true,
        ...(audioIn !== undefined ? { audioIn } : {}),
        hidden: raw.hidden === true,
      });
    }
    cursor = str(page?.nextCursor) ?? undefined;
  } while (cursor && out.length < 200);
  return out.filter((m) => !m.hidden);
}

/**
 * The account check on a running server: signed in or not, plan and email, and a ChatGPT plan's limits
 * (`details`: the reset credits' details too; `seen` gets the raw rate limits for later retry hints).
 * Limits are optional – a failed limits read leaves them out; no answer at all is 'error'.
 */
export async function readCodexAccount(rpc: Pick<RpcClient, 'request'>, input: { details: boolean; plain: PlainReads; now: () => number; seen: (rateLimits: unknown) => void }): Promise<AccountCheck> {
  try {
    const read = await rpc.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>('account/read', { refreshToken: false });
    const info = isRecord(read?.account) ? read.account : undefined;
    if (!info) return { state: read?.requiresOpenaiAuth === false ? 'ok' : 'needs_login', message: read?.requiresOpenaiAuth === false ? undefined : 'Sign in to Codex.' };
    const check: AccountCheck = { state: 'ok', plan: info.type === 'chatgpt' ? str(info.planType) : info.type === 'apiKey' ? 'api' : str(info.type), email: str(info.email) };
    if (info.type === 'chatgpt') {
      try {
        const limits = await readRateLimits(rpc, input.details, input.plain);
        check.limits = normalizeCodexLimits(limits, input.now());
        if (isRecord(limits)) input.seen(limits.rateLimits);
      } catch { /* limits are optional */ }
    }
    return check;
  } catch {
    return { state: 'error', message: 'Codex did not answer the account check.' };
  }
}
