// Plan limit texts shared by the quota rail (shell/QuotaRail.tsx) and the account rows
// (settings/AccountRow.tsx, B-044): humanized window names, the share left, the reset countdown
// with its clock time ("resets in 2 h 14 min (14:27)"), the rail's 5-hour ring and short wait ("42m", B-078; "2d 5h", AF-009), the two fixed slots of a plan row
// (5-hour limit, Weekly – '–' while a reading is missing, so the row never changes height) and the
// banked Codex resets (count, the credit a reset uses and when it expires, the confirm and outcome texts).
// Owns: these display rules. Never: fetches, estimates or changes a limit – every number comes from
// the runtime's readings (an unknown or passed reading is '–', never 0 % or 100 %).

import { accountCharge } from '../../shared/model/charge.ts';
import type { Account, AccountLimits, LimitResets, LimitWindow, ResetCredit } from '../../shared/model/providers.ts';
import type { ResetOutcome } from '../../shared/api/methods-providers.ts';
import { locale, relative, relativeDay, resetTime, time } from './format.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_LABELS: Record<string, string> = { '5h': '5-hour limit', weekly: 'Weekly' };
const dayTimeFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** "5-hour limit", "Weekly", "Weekly · Opus"; any other window keeps its runtime name. */
export function windowLabel(name: string): string {
  if (WINDOW_LABELS[name]) return WINDOW_LABELS[name];
  if (name.startsWith('weekly-')) return `Weekly · ${name.slice(7).replace(/^./, (c) => c.toUpperCase())}`;
  return name;
}

/** Percent left; undefined once the window's reset has passed (the reading no longer applies). */
export function leftOf(window: LimitWindow, now: number): number | undefined {
  return window.resetsAt !== undefined && window.resetsAt <= now ? undefined : Math.max(0, Math.round(100 - window.usedPercent));
}

/**
 * "in 45 min", "in 2 h 14 min", and beyond a day the calendar days ("tomorrow", "in 4 days" – format.ts
 * relativeDay, so the word always matches the weekday in brackets); below a minute format.ts relative.
 */
export function countdown(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms >= DAY) return relativeDay(resetsAt, now);
  if (ms < 60_000) return relative(resetsAt, now);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

/** B-078 (D17): the rail's short wait until a reset – "42m", "2h 5m", "2h", "<1m"; undefined once it has passed. */
export function shortWait(resetsAt: number, now: number): string | undefined {
  const ms = resetsAt - now;
  if (ms <= 0) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** AF-009: shortWait beyond a day too – "2d 5h", "5d"; a weekly reset in the rail's wait line. */
export function shortReset(resetsAt: number, now: number): string | undefined {
  const ms = resetsAt - now;
  if (ms < DAY) return shortWait(resetsAt, now);
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms - days * DAY) / HOUR);
  return hours >= 24 ? `${days + 1}d` : hours ? `${days}d ${hours}h` : `${days}d`;
}

/** AF-009: the rail's wait line – the 5-hour reset while it counts down, else the weekly reset; undefined with neither. */
export function railWait(fiveResetsAt: number | undefined, weeklyResetsAt: number | undefined, now: number): string | undefined {
  if (fiveResetsAt !== undefined && fiveResetsAt > now) return shortWait(fiveResetsAt, now);
  return weeklyResetsAt !== undefined ? shortReset(weeklyResetsAt, now) : undefined;
}

/**
 * B-078 (D17): a plan's 5-hour window for the rail's ring – undefined when the plan reports none (some Claude and Codex
 * plans have no 5-hour limit any more: no ring); `left` undefined once its reset has passed (the track alone).
 */
export function fiveHourOf(limits: AccountLimits | undefined, now: number): { left?: number; resetsAt?: number } | undefined {
  const window = limits?.windows.find((entry) => entry.name === '5h');
  if (!window) return undefined;
  const left = leftOf(window, now);
  return { ...(left !== undefined ? { left } : {}), ...(window.resetsAt !== undefined && left !== undefined ? { resetsAt: window.resetsAt } : {}) };
}

/** The reset's clock time: "14:27" within a day, "Tue 09:00" within a week, else "20 Oct, 14:27". */
export function resetClock(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms < DAY) return time(resetsAt);
  return ms < 7 * DAY ? dayTimeFmt.format(resetsAt) : resetTime(resetsAt);
}

/** "64% left · resets in 2 h 14 min (14:27)"; '–' while unknown or once the reset has passed. */
export function windowText(window: LimitWindow | undefined, now: number): string {
  const left = window ? leftOf(window, now) : undefined;
  if (!window || left === undefined) return '–';
  return window.resetsAt === undefined ? `${left}% left` : `${left}% left · resets ${countdown(window.resetsAt, now)} (${resetClock(window.resetsAt, now)})`;
}

/** One fixed bar of a plan row. */
export interface LimitSlot {
  name: string;
  label: string;
  /** Percent left (bar width); undefined = unknown ('–', empty bar). */
  left?: number;
  /** "5-hour limit · 64% left · resets in 2 h 14 min (14:27)" */
  line: string;
}

/** The windows every plan row reserves a bar for, in this order. */
export const PLAN_SLOTS: readonly string[] = ['5h', 'weekly'];

/** The two fixed bars of a plan row (5-hour limit, Weekly), each '–' while its reading is missing. */
export function limitSlots(limits: AccountLimits | undefined, now: number): LimitSlot[] {
  return PLAN_SLOTS.map((name) => {
    const window = limits?.windows.find((entry) => entry.name === name);
    const left = window ? leftOf(window, now) : undefined;
    return { name, label: windowLabel(name), ...(left === undefined ? {} : { left }), line: `${windowLabel(name)} · ${windowText(window, now)}` };
  });
}

/** The readings outside the fixed slots ("Weekly · Opus · 80% left · …"), for a tooltip. */
export function otherWindows(limits: AccountLimits | undefined, now: number): string[] {
  return (limits?.windows ?? []).filter((window) => !PLAN_SLOTS.includes(window.name)).map((window) => `${windowLabel(window.name)} · ${windowText(window, now)}`);
}

// ------------------------------------------------------------------ banked resets (Codex)

/** The available count; undefined when the provider never reported resets. */
export function resetCount(resets: LimitResets | undefined): number | undefined {
  return resets?.available;
}

/** The credit a reset uses: the available one that expires first (undefined when only the count is known). */
export function nextCredit(resets: LimitResets | undefined, now: number): ResetCredit | undefined {
  return resets?.credits?.find((credit) => credit.expiresAt === undefined || credit.expiresAt > now);
}

/** "Use reset (2)", "Use reset (–)" while unknown. */
export function resetButtonLabel(resets: LimitResets | undefined): string {
  const count = resetCount(resets);
  return `Use reset (${count === undefined ? '–' : count})`;
}

/** "1 reset available", "3 resets available · Next expires 3 Nov, 14:27" (the quota card). */
export function resetsAvailableText(count: number, next?: ResetCredit): string {
  const expiry = count > 0 ? resetExpiryText(next) : undefined;
  return `${count} reset${count === 1 ? '' : 's'} available${expiry ? ` · ${expiry}` : ''}`;
}

/** "Next expires 3 Nov, 14:27" for the credit a reset uses; undefined while its expiry is unknown or it never expires. */
export function resetExpiryText(next: ResetCredit | undefined): string | undefined {
  return next?.expiresAt ? `Next expires ${resetTime(next.expiresAt)}` : undefined;
}

/** The confirm text: what a reset does, how many are left, when this one expires, that it is final. */
export function resetConfirmText(resets: LimitResets | undefined, now: number): string {
  const count = resetCount(resets) ?? 0;
  const credit = nextCredit(resets, now);
  const expiry = credit?.expiresAt ? `; this one expires ${resetTime(credit.expiresAt)}` : '';
  return `Restores your 5-hour and weekly limits now. ${count} reset${count === 1 ? '' : 's'} left${expiry}. This cannot be undone.`;
}

/** The toast after the provider answered; 'alreadyRedeemed' (this attempt went through before) counts as done. */
export function resetOutcomeText(outcome: ResetOutcome): { title: string; body?: string; ok: boolean } {
  if (outcome === 'reset' || outcome === 'alreadyRedeemed') return { title: 'Limits reset', ok: true };
  if (outcome === 'nothingToReset') return { title: 'Nothing to reset', body: 'No limit window can be reset right now.', ok: false };
  return { title: 'No reset available', body: 'This account has no reset left.', ok: false };
}
