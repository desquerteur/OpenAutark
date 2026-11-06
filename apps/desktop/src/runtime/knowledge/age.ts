// Human-readable age of retrieved knowledge: the relative age ("3 weeks ago") and, B-044, the absolute
// day next to it ("saved 2026-10-04, 3 weeks ago") – every retrieval surface (search reasons, find
// candidates, an opened note, pinned memory) carries it, so agents judge how old a hint is
// (rules.md › Memory). The day is the calendar day in the person's time zone – the zone the prompt's
// Now line names (context/time.ts profileZone) –, so a note saved just after local midnight shows that day.
// Owns: these formatting rules and DAY_MS. Never: reads settings (callers pass the zone), or dates in
// prompts that must stay cache-stable (only volatile sections and tool results use this).

import { validZone } from '../context/time.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DAY_MS = DAY;

export function ageText(then: number, now: number): string {
  const delta = Math.max(0, now - then);
  if (delta < HOUR) return 'just now';
  if (delta < DAY) { const hours = Math.round(delta / HOUR); return `${hours} hour${hours === 1 ? '' : 's'} ago`; }
  if (delta < 14 * DAY) { const days = Math.round(delta / DAY); return `${days} day${days === 1 ? '' : 's'} ago`; }
  if (delta < 60 * DAY) return `${Math.round(delta / (7 * DAY))} weeks ago`;
  if (delta < 365 * DAY) return `${Math.round(delta / (30 * DAY))} months ago`;
  const years = Math.round(delta / (365 * DAY));
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The day of a timestamp, YYYY-MM-DD, in `zone` (the profile zone; unknown or undefined = the process zone). */
export function dayText(at: number, zone: string | undefined): string {
  const key = zone ?? '';
  let format = dayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: validZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dayFormats.size > 16) dayFormats.clear();
    dayFormats.set(key, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(at)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The weekday of a timestamp in `zone`, in English: a relative time in a person's words ("this week") needs it next to the day. */
export function weekdayText(at: number, zone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: validZone(zone), weekday: 'long' }).format(at);
}

/** "saved 2026-10-04, 3 weeks ago" – the day (in `zone`) a note was saved next to its age. */
export function savedText(then: number, now: number, zone: string | undefined): string {
  return `saved ${dayText(then, zone)}, ${ageText(then, now)}`;
}
