// Formatting helpers for times, dates, sizes and short texts (also an agent's live note: a bare tool
// name reads as what it does, workNote). Words (weekdays, months, "1 minute
// ago") are English like the rest of the UI; numbers follow the person's region (24 h clock,
// day/month order) – e.g. de-AT → en-AT.
// Owns: display formatting only. Never: parses user input into dates (schedules do that).

import { toolDoing } from '../../shared/text/step-label.ts';

/** English with the region of the browser locale (falls back to plain English). */
export function uiLocale(language: string | undefined): string {
  try {
    const region = language ? new Intl.Locale(language).maximize().region : undefined;
    if (region) return Intl.DateTimeFormat.supportedLocalesOf(`en-${region}`).length ? `en-${region}` : 'en';
  } catch { /* malformed tag */ }
  return 'en';
}

export const locale = uiLocale(typeof navigator === 'undefined' ? undefined : navigator.language);
const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
/** The region's clock has AM/PM ("09:17 PM"): a time-only slot needs the wider room (call.css). */
export const clock12 = /^h1[12]$/.test(timeFmt.resolvedOptions().hourCycle ?? '');
const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
const resetFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayMonthFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
const relFmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "14:05" */
export function time(ms: number): string {
  return timeFmt.format(ms);
}

/** Full date and time for tooltips. */
export function fullDate(ms: number): string {
  return fullFmt.format(ms);
}

/** List-row time: today → "14:05", yesterday → "Yesterday", this week → "Mon", else "12.10". */
export function listTime(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 0) return timeFmt.format(ms);
  if (days === 1) return relFmt.format(-1, 'day').replace(/^./, (c) => c.toUpperCase());
  if (days < 7) return dayFmt.format(ms);
  return dateFmt.format(ms);
}

/** "in 3 h", "5 min ago" … */
export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return relFmt.format(0, 'second');
  if (abs < 3_600_000) return relFmt.format(Math.round(diff / 60_000), 'minute');
  if (abs < DAY) return relFmt.format(Math.round(diff / 3_600_000), 'hour');
  return relFmt.format(Math.round(diff / DAY), 'day');
}

/**
 * "tomorrow", "in 2 days", "yesterday" by calendar days – a moment 27 h ahead on Tuesday night is Thursday:
 * "in 2 days", never the rounded "tomorrow" of relative().
 */
export function relativeDay(ms: number, now = Date.now()): string {
  return relFmt.format(Math.round((startOfDay(ms) - startOfDay(now)) / DAY), 'day');
}

/** Compact reset date under a quota: "20.10." */
export function shortDate(ms: number): string {
  return dateFmt.format(ms);
}

/** "30 Oct" – a day without its time, the month as a word (the reset dates' style) */
export function dayMonth(ms: number): string {
  return dayMonthFmt.format(ms);
}

/** "20 Oct, 14:27" */
export function resetTime(ms: number): string {
  return resetFmt.format(ms);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Initials for avatars: "Video Editor" → "VE", "mira" → "M". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Markdown's backslash escapes (CommonMark: ASCII punctuation), kept aside while markup is stripped. */
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
/** Private-use stand-ins for escaped characters (U+E000 + the character's code). */
const KEPT = 0xe000;

/**
 * One-line plain preview of markdown text: fences, images and markup stripped, links as their text,
 * escapes resolved ("\[18:21]" → "[18:21]"); an underscore or asterisk inside a word stays
 * ("task_1m5z…"), only emphasis around words goes.
 */
export function plainPreview(markdown: string, max = 140): string {
  const text = markdown
    .replace(ESCAPED, (_, char: string) => String.fromCharCode(KEPT + char.charCodeAt(0)))
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[*+][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}])[*_](?=\S)(.*?\S)[*_](?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/\*{2,}|`+/g, '')
    .replace(/\|/g, ' ')
    .replace(/[-]/g, (char) => String.fromCharCode(char.charCodeAt(0) - KEPT))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** The currency's sign as money() writes it ("€" for EUR), e.g. an amount field's suffix; the code when there is none. */
export function currencySign(currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * An agent's live note as a person reads it: a bare tool name ("bash", "browser.show", "Browser show")
 * becomes what the agent does ("running a command", "showing a page" – C5: never 'bash'); any other note
 * stays as written. The words are the run line's (shared/text/step-label.ts toolDoing), so a chat's
 * header and its run lines say the same.
 */
export function workNote(note: string): string {
  return toolDoing(note) ?? note.trim();
}
