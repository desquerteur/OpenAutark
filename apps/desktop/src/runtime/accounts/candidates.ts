// Pure account selection rules for one engine (and model).
// Owns: engine → provider mapping; the health filter – state, cooling and used-up limit windows
// (a window at 100 % with a future reset counts as cooling until then; model windows such as
// weekly-opus only for matching models); the plan primary with opt-in rotation (shared rule in
// shared/model/plan-roles.ts); ordering (priority first, then B-048 E4.1 "use it or lose it" – the
// plan quota that resets soonest while some is left goes first, `expiring` –, then the smallest
// remaining share of the windows that apply). Spill-over to other providers is the router's job
// (across plans the router compares scores). The ACP engine runs the plan CLIs Gemini CLI, Copilot CLI (PR8) and
// Kimi Code (B-044) under the same plan rule. B-058: media-only accounts (ElevenLabs, fal.ai) have no engine
// (engineFor → undefined); their catalog models carry MEDIA_ENGINE as a placeholder, and the candidates of
// that engine include their accounts, so the function resolver finds them (every caller filters by the
// model's provider, so they never serve another provider's model).
// Never: touches the DB or the clock (callers pass `now`).

import { isAcpPlan, MEDIA_ONLY_PROVIDERS, type Account, type EngineId, type LimitWindow, type ProviderId } from '../../shared/model/providers.ts';
import { byPriority, isPlanProvider, isUsableState, planPrimary } from '../../shared/model/plan-roles.ts';
import { weeklyWindow, windowApplies, windowScope } from './limits.ts';

export const ENGINE_PROVIDERS: Record<EngineId, ProviderId[]> = {
  codex: ['codex'],
  claude: ['claude'],
  openai: ['openai'],
  anthropic: ['anthropic'],
  compatible: ['openrouter', 'google', 'xai', 'deepseek', 'groq', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'compatible'], // B-058: groq; elevenlabs/fal have no chat engine (media adapters only)
  fake: ['compatible'],
  acp: ['gemini-cli', 'copilot', 'kimi-cli'], // plan CLIs on the generic ACP engine (engines/acp/providers.ts)
};

/** B-058: the engine id the catalog models of media-only accounts carry (no turn ever runs on it for them). */
export const MEDIA_ENGINE: EngineId = 'compatible';

/** Which engine runs an account. */
export function engineFor(provider: ProviderId): EngineId | undefined {
  for (const [engine, providers] of Object.entries(ENGINE_PROVIDERS) as Array<[EngineId, ProviderId[]]>) {
    if (engine !== 'fake' && providers.includes(provider)) return engine;
  }
  return undefined;
}

export function isCooling(account: Account, now: number): boolean {
  return account.coolingUntil !== undefined && account.coolingUntil > now;
}

const usedUp = (window: LimitWindow, now: number) => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now;

/** Current readings that limit a turn on `model` (expired readings are unknown, not 0 %). */
export function applicableWindows(account: Account, now: number, model?: string): LimitWindow[] {
  return (account.limits?.windows ?? []).filter((window) => (window.resetsAt === undefined || window.resetsAt > now) && windowApplies(window.name, model));
}

/** When the account can run `model` again (cooling or a used-up window); undefined = now. */
export function blockedUntil(account: Account, now: number, model?: string): number | undefined {
  let until = isCooling(account, now) ? account.coolingUntil : undefined;
  for (const window of applicableWindows(account, now, model)) {
    if (usedUp(window, now)) until = Math.max(until ?? 0, window.resetsAt!);
  }
  return until;
}

export function isHealthy(account: Account, now: number, model?: string): boolean {
  // 'cooling' with an expired coolingUntil is healthy again; 'unknown' = not yet checked (try it).
  return isUsableState(account) && blockedUntil(account, now, model) === undefined;
}

/** Remaining weekly percent; undefined when unknown. */
export function weeklyHeadroom(account: Account, now: number): number | undefined {
  const weekly = weeklyWindow(account.limits, now);
  return weekly ? Math.max(0, 100 - weekly.usedPercent) : undefined;
}

/** Smallest remaining percent of the windows that apply (5h, weekly, the model's own window); undefined when unknown. */
export function headroom(account: Account, now: number, model?: string): number | undefined {
  const windows = applicableWindows(account, now, model);
  return windows.length ? Math.max(0, 100 - Math.max(...windows.map((window) => window.usedPercent))) : undefined;
}

/**
 * The limit a turn on `model` just hit is the model's own (its window, e.g. weekly-opus, is used
 * up and no account-wide one is): only that model waits; the account keeps serving others.
 */
export function modelOnlyLimit(account: Account, now: number, model: string): boolean {
  const used = (account.limits?.windows ?? []).filter((window) => usedUp(window, now));
  return used.some((window) => windowScope(window.name) !== undefined && windowApplies(window.name, model))
    && !used.some((window) => windowScope(window.name) === undefined);
}

// ------------------------------------------------------------------ B-048 E4.1: use it or lose it

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A plan whose shortest window (5h) has less than this share left is never pushed while its weekly window has more. */
export const FIVE_HOUR_GUARD = 10;
/** Below this the `expiring` value is no reason to prefer an account (unknown limits count 0). */
export const EXPIRING_MIN = 0.15;
/** `expiring` values closer than this are a tie (the remaining share decides). */
export const EXPIRING_TIE = 0.05;

/**
 * How urgent a window's reset is, 0..1: 1 within its horizon (a weekly or longer window resets in
 * ≤ 24 h, a 5h or shorter one in ≤ 1 h); after that a weekly window decays as horizon / resetIn (2 days
 * 0.5, 6 days ≈ 0.17), a short one falls linearly to 0 one horizon later – its quota is not lost while the
 * weekly window still binds.
 */
export function urgency(windowMinutes: number, resetIn: number): number {
  const long = windowMinutes >= 1440;
  const horizon = long ? DAY_MS : HOUR_MS;
  if (resetIn <= horizon) return 1;
  return long ? horizon / resetIn : Math.max(0, 1 - (resetIn - horizon) / horizon);
}

/** A plan login (subscription quota that resets), not a key that pays per use or a local runtime. */
function planQuota(account: Account): boolean {
  return (isPlanProvider(account.provider) || isAcpPlan(account.provider)) && account.auth === 'cli' && account.plan?.trim().toLowerCase() !== 'api';
}

/**
 * B-048 E4.1 "use it or lose it": the share of a plan's quota that is lost unless used soon –
 * remaining share (the smallest of the windows that apply to `model`) × the highest urgency of their
 * resets. 0 for accounts without plan quota or readings, and while the guard holds: a 5h window under
 * FIVE_HOUR_GUARD % is never drained further while the weekly window has more left. Deterministic.
 */
export function expiring(account: Account, now: number, model?: string): number {
  if (!planQuota(account)) return 0;
  const windows = applicableWindows(account, now, model).filter((window) => window.resetsAt !== undefined);
  if (!windows.length) return 0;
  const left = (window: LimitWindow) => Math.max(0, 100 - window.usedPercent);
  const short = windows.filter((window) => window.windowMinutes < 1440).map(left);
  const long = windows.filter((window) => window.windowMinutes >= 1440).map(left);
  if (short.length && long.length && Math.min(...short) < FIVE_HOUR_GUARD && Math.max(...long) > Math.min(...short)) return 0;
  const share = Math.min(...windows.map(left)) / 100;
  const urgent = Math.max(...windows.map((window) => urgency(window.windowMinutes, window.resetsAt! - now)));
  return Math.round(share * urgent * 1000) / 1000;
}

/**
 * The `expiring` step an account ranks by: none below EXPIRING_MIN, else in steps of EXPIRING_TIE
 * (steps keep the order transitive; inside a step the remaining share decides).
 */
export function expiringRank(account: Account, now: number, model?: string): number {
  const value = expiring(account, now, model);
  return value >= EXPIRING_MIN ? Math.floor(value / EXPIRING_TIE + 1e-9) : 0;
}

export function selectCandidates(accounts: Account[], engine: EngineId, now: number, model?: string): Account[] {
  const providers = [...(ENGINE_PROVIDERS[engine] ?? []), ...(engine === MEDIA_ENGINE ? MEDIA_ONLY_PROVIDERS : [])];
  const out: Account[] = [];
  for (const provider of providers) {
    const all = accounts.filter((a) => a.provider === provider && a.enabled).sort(byPriority);
    if (!all.length) continue;
    // Plan-based providers: the first signed-in account is the user's primary (one that needs
    // sign-in never shuts out the next); others join only when the user opted them into rotation
    // (provider terms) and rank behind it by priority. Keyed/local providers have no such restriction.
    const plan = isPlanProvider(provider) || isAcpPlan(provider);
    const primary = plan ? planPrimary(all) : undefined;
    const allowed = plan ? all.filter((a) => a === primary || a.rotation) : all;
    out.push(...allowed.filter((a) => isHealthy(a, now, model)));
  }
  return out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ea = expiringRank(a, now, model); // E4.1: quota that resets soon while some is left goes first
    const eb = expiringRank(b, now, model);
    if (ea !== eb) return eb - ea;
    const ha = headroom(a, now, model) ?? 50; // unknown ranks in the middle
    const hb = headroom(b, now, model) ?? 50;
    if (ha !== hb) return hb - ha;
    if (a.state !== b.state) return a.state === 'ok' ? -1 : b.state === 'ok' ? 1 : 0;
    return a.createdAt - b.createdAt;
  });
}
