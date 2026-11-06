// Usage-limit normalizers (ported 1:1 in behaviour from legacy usage.cjs) into AccountLimits.
// Owns: validation of provider limit payloads (Codex rateLimits*, Claude get_usage / rate_limit_event),
// naming of windows ("5h", "weekly", "weekly-opus" …) and which model a suffixed window binds;
// B-044: Codex banked resets (`rateLimitResetCredits` of account/rateLimits/read, codex-cli 0.162 schema);
// a count-only reading keeps the stored credit details while they still match its count (mergeLimits).
// Invalid windows are dropped, never 0 %.
// Never: fetches anything or invents values (an ambiguous 100 % reading that was not rejected stays below 100).

import type { AccountLimits, LimitResets, LimitWindow, ResetCredit } from '../../shared/model/providers.ts';
import { isRecord } from '../engines/shared.ts';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;

function windowName(minutes: number, suffix?: string): string {
  const base = minutes === 10080 ? 'weekly' : minutes === 300 ? '5h' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return suffix ? `${base}-${suffix}` : base;
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.replace(/[\u0000-\u001f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return label || undefined;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_CREDITS = 50;

/**
 * Codex `rateLimitResetCredits` (RateLimitResetCreditsSummary): the available count and, when the
 * provider sent details, the available credits (status 'available'), soonest expiry first. A bad
 * count is no reading; credits without a usable id are dropped.
 */
export function normalizeCodexResets(value: unknown): LimitResets | undefined {
  if (!isRecord(value)) return undefined;
  const count = value.availableCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  const resets: LimitResets = { available: Math.min(count, 10_000) };
  if (!Array.isArray(value.credits)) return resets; // null: only the count is known
  const credits: ResetCredit[] = [];
  for (const raw of value.credits.slice(0, MAX_CREDITS)) {
    if (!isRecord(raw) || raw.status !== 'available' || typeof raw.id !== 'string') continue;
    const id = raw.id.replace(CONTROL, '').trim();
    if (!id || id.length > 200) continue;
    const credit: ResetCredit = { id };
    const title = typeof raw.title === 'string' ? raw.title.replace(CONTROL, ' ').trim().slice(0, 120) : '';
    if (title) credit.title = title;
    if (typeof raw.expiresAt === 'number' && Number.isSafeInteger(raw.expiresAt) && raw.expiresAt > 0) credit.expiresAt = raw.expiresAt * 1000;
    credits.push(credit);
  }
  resets.credits = credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return resets;
}

/**
 * Codex `account/rateLimits/read` result or `account/rateLimits/updated` params. A payload that
 * carries `rateLimitResetCredits` (the read) sets `resets` – also to undefined when it is null, so
 * mergeLimits drops an old count; one without it (the sparse push) leaves the stored resets alone.
 */
export function normalizeCodexLimits(value: unknown, now: number): AccountLimits | undefined {
  if (!isRecord(value)) return undefined;
  const byId = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : undefined;
  const buckets: Record<string, unknown> = byId ?? (value.rateLimits ? { codex: value.rateLimits } : {});
  const windows: LimitWindow[] = [];
  for (const [id, bucket] of Object.entries(buckets).slice(0, 20)) {
    if (!ID.test(id) || !isRecord(bucket)) continue;
    // The main "codex" bucket gets unsuffixed names; others are suffixed with their name/id.
    const suffix = id === 'codex' ? undefined : cleanLabel(bucket.limitName) ?? cleanLabel(id);
    for (const raw of [bucket.primary, bucket.secondary]) {
      if (!isRecord(raw)) continue;
      const used = raw.usedPercent, mins = raw.windowDurationMins, reset = raw.resetsAt;
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
      if (typeof mins !== 'number' || !Number.isSafeInteger(mins) || mins <= 0) continue;
      if (reset != null && !(typeof reset === 'number' && Number.isSafeInteger(reset) && reset > 0)) continue;
      windows.push({ name: windowName(mins, suffix), windowMinutes: mins, usedPercent: used, resetsAt: typeof reset === 'number' ? reset * 1000 : undefined });
    }
  }
  if (!windows.length) return undefined;
  return Object.hasOwn(value, 'rateLimitResetCredits') ? { windows, readAt: now, resets: normalizeCodexResets(value.rateLimitResetCredits) } : { windows, readAt: now };
}

/** True when a Codex limits payload says the limit is reached right now. */
export function codexLimitReached(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const snapshots = [value.rateLimits, ...(isRecord(value.rateLimitsByLimitId) ? Object.values(value.rateLimitsByLimitId) : [])];
  return snapshots.some((s) => isRecord(s) && typeof s.rateLimitReachedType === 'string');
}

const CLAUDE_WINDOWS: Array<[string, number, string | undefined]> = [
  ['five_hour', 300, undefined], ['seven_day', 10080, undefined], ['seven_day_opus', 10080, 'opus'],
  ['seven_day_sonnet', 10080, 'sonnet'], ['seven_day_oauth_apps', 10080, 'oauth-apps'],
];

/** Claude `get_usage` control response payload. Returns plan too. */
export function normalizeClaudeUsage(value: unknown, now: number): { limits?: AccountLimits; plan?: string } {
  if (!isRecord(value) || value.rate_limits_available !== true) return {};
  const limits = isRecord(value.rate_limits) ? value.rate_limits : {};
  const windows: LimitWindow[] = [];
  for (const [key, minutes, suffix] of CLAUDE_WINDOWS) {
    const limit = limits[key];
    if (!isRecord(limit)) continue;
    const used = limit.utilization;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const reset = typeof limit.resets_at === 'string' ? Date.parse(limit.resets_at) : NaN;
    windows.push({ name: windowName(minutes, suffix), windowMinutes: minutes, usedPercent: used, resetsAt: Number.isFinite(reset) && reset > 0 ? reset : undefined });
  }
  const plan = typeof value.subscription_type === 'string' && ['pro', 'max', 'team', 'enterprise'].includes(value.subscription_type) ? value.subscription_type : undefined;
  return { limits: windows.length ? { windows, readAt: now } : undefined, plan };
}

/**
 * Claude stream-json `rate_limit_event` (shape not officially documented):
 * `{type:'rate_limit_event', rate_limit_info:{status:'allowed'|'allowed_warning'|'rejected', resetsAt (unix s), utilization?, rateLimitType?}}`.
 * Utilization units are disputed (0..1 or 0..100); values ≤ 1 are treated as fractions.
 */
export function parseClaudeRateLimitEvent(value: unknown, now: number): { rejected: boolean; resetsAt?: number; limits?: AccountLimits } {
  const info = isRecord(value) && isRecord(value.rate_limit_info) ? value.rate_limit_info : undefined;
  if (!info) return { rejected: false };
  const rejected = info.status === 'rejected';
  const resetsAtSec = typeof info.resetsAt === 'number' && info.resetsAt > 0 ? info.resetsAt : undefined;
  const resetsAt = resetsAtSec ? (resetsAtSec < 1e12 ? resetsAtSec * 1000 : resetsAtSec) : undefined;
  let limits: AccountLimits | undefined;
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const raw = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : undefined;
  const known = CLAUDE_WINDOWS.find(([key]) => key === type); // same names as get_usage ("weekly-opus" …)
  const minutes = known?.[1] ?? (type?.startsWith('seven_day') ? 10080 : undefined);
  if (minutes && (raw !== undefined || rejected)) {
    // A rejected window is used up. Otherwise 100 % is ambiguous (units, overage) and must not
    // shut the plan out until its reset – the provider's own rejection decides that.
    const scaled = raw === undefined ? 100 : raw <= 1 ? raw * 100 : raw;
    if (scaled >= 0 && scaled <= 100) {
      const used = rejected ? 100 : Math.min(scaled, 99);
      limits = { windows: [{ name: windowName(minutes, known?.[2]), windowMinutes: minutes, usedPercent: used, resetsAt }], readAt: now };
    }
  }
  return { rejected, resetsAt, limits };
}

/**
 * The resets of a new reading: its own when it carries the key (a null summary clears them), else the
 * stored ones. B-044: a count-only reading (a background read without the credit details – Codex
 * excludeResetCreditDetails – or a summary whose `credits` was null) keeps the stored credit details,
 * minus those expired by its reading time, while they still account for its count; at a count of 0 none
 * are left. A count that moved otherwise (a reset used or granted in another app) leaves only the count –
 * which credit changed is unknown – until the next detail read (monitor.ts refreshAll).
 */
function mergeResets(previous: LimitResets | undefined, next: AccountLimits): LimitResets | undefined {
  if (!Object.hasOwn(next, 'resets')) return previous;
  const resets = next.resets;
  if (!resets || resets.credits || !previous?.credits) return resets;
  if (resets.available === 0) return { ...resets, credits: [] };
  const credits = previous.credits.filter((credit) => credit.expiresAt === undefined || credit.expiresAt > next.readAt);
  return resets.available === previous.available || credits.length === resets.available ? { ...resets, credits } : resets;
}

/** Merges a partial reading into previous limits (same-named windows replaced; resets by mergeResets). */
export function mergeLimits(previous: AccountLimits | undefined, next: AccountLimits): AccountLimits {
  if (!previous) return next;
  const byName = new Map(previous.windows.map((w) => [w.name, w]));
  for (const w of next.windows) byName.set(w.name, w);
  const resets = mergeResets(previous.resets, next);
  return { windows: [...byName.values()], readAt: next.readAt, ...(resets ? { resets } : {}) };
}

/** The model a suffixed window binds ("weekly-opus" → "opus"); undefined for account-wide windows ("5h", "weekly"). */
export function windowScope(name: string): string | undefined {
  return /^(?:weekly|\d+[dhm])-(.+)$/.exec(name)?.[1];
}

/**
 * True when a window limits turns on `model`: account-wide windows always; a model window only
 * when the model id contains its scope as whole words ("claude-opus-5-5" ↔ "opus",
 * "gpt-5.3-codex-spark" ↔ "gpt-5-3-codex-spark"). Without a model only account-wide windows bind;
 * scopes that name no model ("oauth-apps") never exclude anything.
 */
export function windowApplies(name: string, model?: string): boolean {
  const scope = windowScope(name);
  if (!scope) return true;
  if (!model) return false;
  return `-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`.includes(`-${scope}-`);
}

/** The unnamed weekly window (never a 5h/session window). */
export function weeklyWindow(limits: AccountLimits | undefined, now: number): LimitWindow | undefined {
  const weekly = limits?.windows.find((w) => w.name === 'weekly');
  if (!weekly) return undefined;
  if (weekly.resetsAt !== undefined && weekly.resetsAt < now) return undefined; // expired reading: unknown
  return weekly;
}
