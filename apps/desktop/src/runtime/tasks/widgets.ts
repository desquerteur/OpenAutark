// Pure helpers for human to-do widgets (ask blocks from the catalog):
//  * deterministic DE/EN keyword fallback that turns free text into an ask block;
//  * the times and days a to-do text names (F05: parseWhen with parseDay – "tomorrow at 9",
//    "am 25.10.", "on Friday"; B-041: "timer 10 min" is a timer ringing then; links are ignored);
//  * a minimal block of a given type (the "Show as…" switch);
//  * titles, human reasons and due-time parsing (the person's line for an answer is
//    shared/blocks/answer-text.ts).
// Owns: those rules. Never: I/O, model calls (the decision model and the props filled from the
// text are in subconscious/widget.ts and subconscious/widget-fill.ts).

import { ASK_TYPES, YES_NO, type BlockType, type UiBlock } from '../../shared/blocks/catalog.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { foldText } from '../../shared/text/normalize.ts';
import { isoMinutes, timerMinutes } from '../../shared/text/durations.ts';
import type { HumanReason } from '../../shared/model/tasks.ts';

export function isAskBlock(block: UiBlock): boolean {
  return ASK_TYPES.has(block.type);
}

/** F05: a reminder for a day without a clock time rings at 9:00 that day. */
export const DAY_START_HOUR = 9;

/**
 * When a free-text to-do mentions a time ("um 17:00", "at 5pm", "in 10 min") and/or a day
 * (parseDay: "tomorrow at 9", "am 25.10. um 17 Uhr", "on Friday" → 9:00). Never in the past.
 */
export function parseWhen(text: string, now: number): { at?: number; duration?: string } {
  const plain = stripUrls(text);
  const folded = foldText(plain);
  const relative = /\bin\s+(\d{1,4})\s*(min|minute|minuten|minutes|m|std|stunde|stunden|hour|hours|h)\b/.exec(folded);
  if (relative) {
    const value = Number(relative[1]);
    const hours = /^(std|stunde|stunden|hour|hours|h)$/.test(relative[2]);
    return { duration: hours ? `PT${value}H` : `PT${value}M` };
  }
  // B-041: "timer 10 min", "Timer für eine halbe Stunde", "10-min timer", "zehn Minuten Timer" ring after that long –
  // the one timer phrase of shared/text/durations.ts (My day's input reads it too).
  const timer = timerMinutes(folded);
  if (timer !== undefined) return { duration: isoMinutes(timer) };
  const day = parseDay(plain, now);
  const clock = clockOf(folded);
  if (!clock && day === undefined) return {};
  const date = new Date(day ?? now);
  date.setHours(clock?.hour ?? DAY_START_HOUR, clock?.minute ?? 0, 0, 0);
  if (day === undefined && date.getTime() <= now) date.setDate(date.getDate() + 1); // "um 9" after 9 → tomorrow
  return date.getTime() > now ? { at: date.getTime() } : {};
}

/**
 * A clock time in folded text: "um 17:00", "at 5pm", "gegen 9" – and unless `strict`, "17:30" or
 * "8 am" alone; undefined when none or invalid. A dotted date ("ab 1.10.") is no time.
 */
export function clockOf(folded: string, strict = false): { hour: number; minute: number } | undefined {
  const text = folded.replace(DOTTED_DATE, (date, day: string, month: string) => (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 ? ' ' : date));
  const match = /\b(?:um|at|ab|gegen)\s+(\d{1,2})(?::|\.)?(\d{2})?\s*(uhr|am|pm)?\b/.exec(text)
    ?? (strict ? null : /\b(\d{1,2}):(\d{2})\s*(uhr|am|pm)?\b/.exec(text) ?? /\b(\d{1,2})()\s*(uhr|am|pm)\b/.exec(text));
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (match[3] === 'pm' && hour < 12) hour += 12;
  if (match[3] === 'am' && hour === 12) hour = 0;
  return hour > 23 || minute > 59 ? undefined : { hour, minute };
}

const DOTTED_DATE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?![\d.])/g;
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|marz|mai|juni|juli|oktober|dezember|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|okt|nov|dec|dez)\\b\\.?';
const MONTH_INDEX: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, dez: 11 };
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sonntag: 0, monday: 1, montag: 1, tuesday: 2, dienstag: 2, wednesday: 3, mittwoch: 3,
  thursday: 4, donnerstag: 4, friday: 5, freitag: 5, saturday: 6, samstag: 6, sonnabend: 6,
};
const WEEKDAY = new RegExp(`\\b(?:on|by|until|till|before|next|this|every|am|bis|vor|zum|nachsten|kommenden|diesen|jeden)\\s+(${Object.keys(WEEKDAYS).join('|')})s?\\b`);

/**
 * F05: the day a to-do text names, as local midnight (epoch ms): an ISO or dotted date, "25 October",
 * "October 25", today / tomorrow / the day after, "in 3 days", "on Friday" (the next one). A date
 * without a year that has passed means next year; one with a past year is none.
 */
export function parseDay(text: string, now: number): number | undefined {
  const folded = foldText(stripUrls(text));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const on = (year: number | undefined, month: number, day: number): number | undefined => {
    const date = new Date(year ?? today.getFullYear(), month, day);
    if (date.getMonth() !== month || date.getDate() !== day) return undefined; // 31.02.
    if (date.getTime() < today.getTime()) return year === undefined ? new Date(date.getFullYear() + 1, month, day).getTime() : undefined;
    return date.getTime();
  };
  const year = (raw: string | undefined) => (raw ? (raw.length === 2 ? 2000 + Number(raw) : Number(raw)) : undefined);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(folded);
  const dotted = new RegExp(DOTTED_DATE.source).exec(folded);
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+)?${MONTH}(?:\\s+(\\d{4}))?`).exec(folded);
  const monthDay = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`).exec(folded);
  const explicit = (iso && on(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    ?? (dotted && on(year(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1])))
    ?? (dayMonth && on(year(dayMonth[3]), MONTH_INDEX[dayMonth[2].slice(0, 3)], Number(dayMonth[1])))
    ?? (monthDay && on(year(monthDay[3]), MONTH_INDEX[monthDay[1].slice(0, 3)], Number(monthDay[2])));
  if (explicit) return explicit;
  const after = (days: number) => { const date = new Date(today); date.setDate(date.getDate() + days); return date.getTime(); };
  if (/\b(day after tomorrow|ubermorgen)\b/.test(folded)) return after(2);
  if (/\b(tomorrow|morgen)\b/.test(folded) && !/\bheute morgen\b/.test(folded)) return after(1);
  if (/\b(today|tonight|heute)\b/.test(folded)) return after(0);
  const inDays = /\bin\s+(\d{1,3})\s+(days?|tagen?)\b/.exec(folded);
  if (inDays) return after(Number(inDays[1]));
  const weekday = WEEKDAY.exec(folded);
  if (weekday) return after((WEEKDAYS[weekday[1]] - today.getDay() + 7) % 7 || 7);
  return undefined;
}

/** The text without its links (a date or time inside a URL is none). */
export function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, ' ');
}

/** Deterministic keyword fallback (DE + EN). Order matters: the most specific intent wins. */
export function fallbackWidget(text: string, now: number): UiBlock {
  const folded = foldText(text);
  const title = excerpt(text.split(/\r?\n/)[0] ?? text, 120);
  const has = (pattern: RegExp) => pattern.test(folded);
  const when = parseWhen(text, now);
  // "timer" alone is a thing ("Buy a kitchen timer"): a timer only with a time or a duration ("timer 10 min").
  const timed = has(/\btimer\b/) && (when.at !== undefined || when.duration !== undefined);
  if (has(/\b(erinner\w*|remind\w*|reminder|wecker|alarm)\b/) || timed || has(/\b(um|at)\s+\d{1,2}([:.]\d{2})?\s*(uhr|am|pm)?\b/)) {
    const block: UiBlock = { type: 'timer', label: title };
    if (when.at) block.at = new Date(when.at).toISOString();
    if (when.duration) block.duration = when.duration;
    return block;
  }
  if (has(/\b(video\w*|kamera|camera|teleprompter|film\w*)\b/)) return { type: 'record', mode: 'video', instructions: title };
  if (has(/\b(aufnehm\w*|aufnahme|nimm\w*\s.*\bauf|sprich\w*|einsprech\w*|record\w*|voice|audio|sprachnachricht)\b/)) {
    return { type: 'record', mode: 'audio', instructions: title };
  }
  if (has(/\b(hochlad\w*|lade\s.*\bhoch|schick\w* mir|upload\w*|datei\w*|file|files)\b/)) return { type: 'upload', label: title };
  if (has(/\b(freigeb\w*|freigabe|bezahl\w*|zahl\w*|approve\w*|approval|genehmig\w*|pay)\b/)) return { type: 'approve', action: title }; // the person's own payment: the card with its amount (Yes / No)
  if (has(/\b(prufe\w*|pruf\w*|anschau\w*|ansehen|review\w*|check\s+the|look at)\b/)) return { type: 'review', src: '', question: title };
  const items = text.split(/\r?\n|,|;/).map(item => item.trim()).filter(Boolean);
  if (items.length >= 2) return { type: 'checklist', items };
  return { type: 'confirm', instructions: title };
}

/** The options of a choice nothing else gave options (widgetOfType) – the text's own win (widget-fill.ts). */
export const DEFAULT_OPTIONS: readonly string[] = YES_NO;

/** A minimal valid block of `type` for an existing to-do (the "Show as…" menu). */
export function widgetOfType(type: string, title: string, previous?: UiBlock): UiBlock {
  const base: Partial<UiBlock> = {};
  if (previous?.id) base.id = previous.id;
  if (previous?.due) base.due = previous.due;
  switch (type as BlockType) {
    case 'timer': return { ...base, type: 'timer', label: title, ...(previous?.at ? { at: previous.at } : {}) };
    case 'record': return { ...base, type: 'record', mode: typeof previous?.mode === 'string' ? previous.mode : 'audio', instructions: title };
    case 'upload': return { ...base, type: 'upload', label: title };
    case 'approve': return { ...base, type: 'approve', action: title };
    case 'review': return { ...base, type: 'review', src: typeof previous?.src === 'string' ? previous.src : '', question: title };
    case 'checklist': return { ...base, type: 'checklist', items: title.split(/,|;/).map(item => item.trim()).filter(Boolean) };
    case 'choice': return { ...base, type: 'choice', question: title, options: Array.isArray(previous?.options) ? previous.options : [...DEFAULT_OPTIONS] };
    case 'form': return { ...base, type: 'form', fields: [{ name: 'text', label: title, kind: 'longtext' }] };
    case 'confirm': return { ...base, type: 'confirm', instructions: title };
    default: throw new Error(`not an ask block type: ${type}`);
  }
}

/** Why an ask block lands on the human's list (T9). */
export function humanReasonFor(block: UiBlock): HumanReason {
  switch (block.type) {
    case 'approve': return 'taste'; // B-078: an agent's yes/no is the person's taste; 'approval' stays the host's (access requests)
    case 'record': case 'confirm': case 'timer': case 'upload': return 'physical';
    case 'form': return Array.isArray(block.fields) && block.fields.some(field => (field as { kind?: string }).kind === 'secret') ? 'credential' : 'taste';
    case 'review': return 'review';
    default: return 'taste';
  }
}

/** Short verb-first title for a to-do created from a block. */
export function titleForBlock(block: UiBlock): string {
  const text = [block.title, block.question, block.action, block.label, block.instructions, block.script ? 'Record with teleprompter' : undefined]
    .find(value => typeof value === 'string' && value.trim()) as string | undefined;
  if (text) return excerpt(text, 120);
  switch (block.type) {
    case 'record': return block.mode === 'video' ? 'Record a video' : block.mode === 'screen' ? 'Record the screen' : 'Record audio';
    case 'upload': return 'Upload files';
    case 'checklist': return listTitle(block.items, (item) => (typeof item === 'string' ? item : (item as { text?: unknown })?.text)) ?? 'Checklist';
    case 'review': return 'Review';
    case 'form': return listTitle(block.fields, (field) => (field as { label?: unknown; name?: unknown })?.label ?? (field as { name?: unknown })?.name) ?? 'Fill in';
    default: return 'Confirm';
  }
}

/** "Charge the camera, Clean the desk +1" – the content says more than the widget name. */
function listTitle(items: unknown, text: (item: unknown) => unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const names = items.map(text).filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
  if (!names.length) return undefined;
  const shown = names.slice(0, 2).join(', ');
  return excerpt(names.length > 2 ? `${shown} +${names.length - 2}` : shown, 120);
}

/** ISO datetime or ISO duration (relative to `from`) → epoch ms. */
export function parseDue(due: unknown, from: number): number | undefined {
  if (typeof due !== 'string' || !due.trim()) return undefined;
  const duration = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(due.trim());
  if (duration && due.trim().length > 1) {
    const [, d, h, m, s] = duration.map(value => Number(value ?? 0));
    return from + (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
  }
  const at = Date.parse(due);
  return Number.isFinite(at) ? at : undefined;
}
