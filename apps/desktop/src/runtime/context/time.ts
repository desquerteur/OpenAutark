// Time formatting for the volatile prompt and rendered chat lines, in the human's time zone.
// Owns: validated time zones, the one profile-zone read (`profileZone`: the prompt's Now line and every
// "saved"/"indexed" day of retrieved knowledge, knowledge/age.ts), cached Intl formatters and the few
// fixed formats agents see ("14:05", "18 Oct", "Sat 18 Oct 2026, 14:05"). English month/day names (agent-facing).
// Never: used for the stable prompt section (times there would break prompt caching).

import type { RuntimeServices } from '../contracts.ts';

const cache = new Map<string, Intl.DateTimeFormat>();
const known = new Map<string, boolean>(); // zone → Intl knows it (profileZone runs per retrieved hit)

/** The zone if Intl knows it, otherwise undefined (= the process' local zone). */
export function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  let valid = known.get(zone);
  if (valid === undefined) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); valid = true; } catch { valid = false; }
    if (known.size > 16) known.clear();
    known.set(zone, valid);
  }
  return valid ? zone : undefined;
}

/** The zone used for display: the profile zone when valid, else the process zone. */
export function displayZone(zone: string | undefined): string {
  return validZone(zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** The person's display zone (settings.profile.timezone, else the process zone); also without wired settings. */
export function profileZone(services: Pick<RuntimeServices, 'settings'>): string {
  try { return displayZone(services.settings.get().profile.timezone); } catch { return displayZone(undefined); }
}

function parts(ms: number, zone: string | undefined): Record<string, string> {
  const key = zone ?? '';
  let format = cache.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: validZone(zone), weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    if (cache.size > 16) cache.clear();
    cache.set(key, format);
  }
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
  return out;
}

/** "14:05" */
export function clockText(ms: number, zone: string | undefined): string {
  const p = parts(ms, zone);
  return `${p.hour}:${p.minute}`;
}

/** "2026-10-18"-like key to compare calendar days in the zone. */
export function dayKey(ms: number, zone: string | undefined): string {
  const p = parts(ms, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "18 Oct" (with the year when it differs from `now`). */
export function dateText(ms: number, zone: string | undefined, now?: number): string {
  const p = parts(ms, zone);
  const sameYear = now === undefined || parts(now, zone).year === p.year;
  return sameYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/** "Sat 18 Oct 2026, 14:05" */
export function fullDateTime(ms: number, zone: string | undefined): string {
  const p = parts(ms, zone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** Message stamp: "14:05" today, "17 Oct 14:05" on other days. */
export function stampText(ms: number, zone: string | undefined, now: number): string {
  const time = clockText(ms, zone);
  return dayKey(ms, zone) === dayKey(now, zone) ? time : `${dateText(ms, zone, now)} ${time}`;
}

/** Due/next-run text: "today 18:00", "20 Oct 09:00", with "overdue" when in the past. */
export function dueText(ms: number, zone: string | undefined, now: number): string {
  const time = clockText(ms, zone);
  const day = dayKey(ms, zone) === dayKey(now, zone) ? 'today' : dateText(ms, zone, now);
  return `${day} ${time}${ms < now ? ' (overdue)' : ''}`;
}
