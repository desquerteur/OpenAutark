// B-058 i1 (t6 review cross-track 4): the account check of a media-only key (ElevenLabs, fal.ai) – they have no chat
// engine, so without this a wrong key showed only at the first job. One free, authenticated GET, documented by the
// provider (checked 30.10.2026):
// - ElevenLabs: GET {base}/user with `xi-api-key` (api-reference/user/get) – 401 authentication_error is a wrong,
//   expired or missing key; 403 authorization_error is a valid key that may not read this endpoint (a scope-restricted
//   key, e.g. text to speech only – docs eleven-api/resources/errors), so the key itself is accepted.
// - fal.ai: GET https://api.fal.ai/v1/models/pricing?endpoint_id=… with `Authorization: Key …` (platform-apis
//   authentication + v1/models/pricing: "Authentication: Required", "Required permissions: none"; no charge). Only for
//   the official queue host – a custom base URL is someone else's proxy and gets no request.
// 200 → 'ok', 401 → 'needs_login'; anything else (offline, timeout, 429, 5xx, a redirect) is unknown: a key the last
// check rejected stays rejected, any other stays usable ('ok' – the F0 behaviour before this check).
// Owns: the probe per provider and the status → state mapping. Never: logs, stores or returns the key, follows a
// redirect, reads the answer body, or sends the key anywhere but the provider's own host.

import type { Account, AccountState } from '../../../shared/model/providers.ts';
import { DEFAULT_BASE, endpointFor } from '../../engines/http/common.ts';

export type KeyFetch = (url: string, init: RequestInit) => Promise<Response>;

export const KEY_CHECK_MS = 10_000;
/** fal's platform API (pricing lookups need a valid key and cost nothing). */
export const FAL_PLATFORM = 'https://api.fal.ai/v1';
/** A model whose price the fal probe asks for (the adapter's own image model). */
const FAL_PROBE_MODEL = 'fal-ai/z-image/turbo';

/** The probe request for `account` (undefined: no probe for this provider or base URL). */
export function keyProbe(account: Pick<Account, 'provider' | 'baseUrl'>, key: string, falPlatform = FAL_PLATFORM): { url: string; headers: Record<string, string> } | undefined {
  let base: string;
  try { base = endpointFor(account); } catch { return undefined; }
  if (account.provider === 'elevenlabs') return { url: `${base}/user`, headers: { 'xi-api-key': key } };
  if (account.provider === 'fal' && base === DEFAULT_BASE.fal) {
    return { url: `${falPlatform}/models/pricing?endpoint_id=${encodeURIComponent(FAL_PROBE_MODEL)}`, headers: { authorization: `Key ${key}` } };
  }
  return undefined;
}

/** 'ok' / 'needs_login' from the provider's answer, undefined when it cannot tell (see the header). */
export async function probeMediaKey(account: Pick<Account, 'provider' | 'baseUrl'>, key: () => Promise<string | undefined>, fetchFn: KeyFetch = (url, init) => fetch(url, init), falPlatform?: string): Promise<'ok' | 'needs_login' | undefined> {
  let value: string | undefined;
  try { value = await key(); } catch { return undefined; } // the vault could not answer: unknown
  if (!value) return 'needs_login';
  const probe = keyProbe(account, value, falPlatform);
  if (!probe) return undefined;
  try {
    const response = await fetchFn(probe.url, { method: 'GET', headers: { accept: 'application/json', ...probe.headers }, redirect: 'error', signal: AbortSignal.timeout(KEY_CHECK_MS) });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return 'needs_login';
    if (response.ok || response.status === 403) return 'ok';
    return undefined;
  } catch { return undefined; }
}

/** The account state after the check: the probe's verdict, else a rejected key stays rejected and any other is 'ok'. */
export async function mediaKeyState(account: Pick<Account, 'provider' | 'baseUrl' | 'state'>, key: () => Promise<string | undefined>, fetchFn?: KeyFetch, falPlatform?: string): Promise<AccountState> {
  return (await probeMediaKey(account, key, fetchFn, falPlatform)) ?? (account.state === 'needs_login' ? 'needs_login' : 'ok');
}
