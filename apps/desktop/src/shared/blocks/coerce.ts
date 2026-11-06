// Value coercions for model-written ```ui props: strings, numbers, booleans, money, durations.
// Owns: the forgiving conversions shared by the validator, renderers and the runtime
// (e.g. parseDuration for timers). Never: throws – unreadable input returns undefined.

import type { PropSpec } from './catalog.ts';

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- coercions

export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'ja'].includes(lower)) return true;
    if (['false', 'no', 'n', '0', 'off', 'nein'].includes(lower)) return false;
  }
  return undefined;
}

/** Parses "12", "12,5", "1.2k", "45%" (→ 45). Returns undefined for non-numbers. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*([+-]?[\d.,\s]*\d)\s*([kKmM%]?)\s*$/.exec(value.replace(/[€$£¥]/g, ''));
  if (!match) return undefined;
  let digits = match[1].replace(/\s/g, '');
  // "1.234,5" (de) vs "1,234.5" (en): the last separator is the decimal point.
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma > lastDot) digits = digits.replace(/\./g, '').replace(',', '.');
  else digits = digits.replace(/,/g, '');
  let number = Number(digits);
  if (!Number.isFinite(number)) return undefined;
  if (match[2] === 'k' || match[2] === 'K') number *= 1000;
  if (match[2] === 'm' || match[2] === 'M') number *= 1_000_000;
  return number;
}

export function coerce(value: unknown, prop: PropSpec): unknown {
  switch (prop.type) {
    case 'string': {
      if (isObj(value) && typeof value.text === 'string') return value.text;
      if (Array.isArray(value)) return value.map(v => str(v) ?? '').filter(Boolean).join('\n') || undefined;
      return str(value);
    }
    case 'number': return toNumber(value);
    case 'boolean': return toBool(value);
    case 'string[]': {
      const list = Array.isArray(value) ? value : [value];
      const out = list.map(v => (isObj(v) ? str(v.text ?? v.label ?? v.title) : str(v))).filter((v): v is string => Boolean(v));
      return out.length ? out : undefined;
    }
    case 'object': return isObj(value) ? value : (typeof value === 'string' || typeof value === 'number' ? value : undefined);
    case 'object[]': {
      const list = Array.isArray(value) ? value : [value];
      return list.filter(v => v !== null && v !== undefined);
    }
    default: return value;
  }
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'block';
}

/** Alias names carry meaning (teleprompter → video recorder, warning → warning tone …). */
export const ENUM_ALIASES: Record<string, string> = {
  pie: 'donut', doughnut: 'donut', column: 'bar', columns: 'bar', bars: 'bar', histogram: 'bar', lines: 'line',
  points: 'scatter', point: 'scatter', dots: 'scatter',
  ok: 'success', good: 'success', error: 'danger', critical: 'danger', warn: 'warning', tip: 'info', neutral: 'info',
  in_progress: 'running', working: 'running', active: 'running', complete: 'done', completed: 'done', finished: 'done',
  webcam: 'video', camera: 'video', voice: 'audio', mic: 'audio', microphone: 'audio', desktop: 'screen',
  user: 'front', selfie: 'front', environment: 'back', rear: 'back',
  day: 'daily', weekday: 'weekdays', week: 'weekly',
};


export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const CURRENCY_SIGNS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY' };

/** {value,currency} from 12, "12 €", "€12.50", "USD 5", {value:"12",currency:"eur"}. */
export function normalizeAmount(value: unknown): { value: number; currency: string } | undefined {
  if (isObj(value)) {
    const amount = toNumber(value.value ?? value.amount);
    if (amount === undefined) return undefined;
    return { value: amount, currency: (str(value.currency) ?? 'EUR').toUpperCase().slice(0, 3) };
  }
  if (typeof value === 'number') return { value, currency: 'EUR' };
  if (typeof value !== 'string') return undefined;
  const sign = Object.keys(CURRENCY_SIGNS).find(s => value.includes(s));
  const code = /\b([A-Za-z]{3})\b/.exec(value)?.[1];
  const amount = toNumber(value.replace(/[A-Za-z€$£¥\s]/g, ''));
  if (amount === undefined) return undefined;
  return { value: amount, currency: sign ? CURRENCY_SIGNS[sign] : (code ?? 'EUR').toUpperCase() };
}

export const UNIT_MS: Array<[RegExp, number]> = [
  [/^(s|secs?|seconds?|sek|sekunden?)$/, 1000],
  [/^(m|mins?|minutes?|minuten?)$/, 60_000],
  [/^(h|hrs?|hours?|std|stunden?)$/, 3_600_000],
  [/^(d|days?|tage?n?)$/, 86_400_000],
  [/^(w|wks?|weeks?|wochen?)$/, 604_800_000],
];

/**
 * Duration in ms from ISO 8601 ("PT1H30M", "P1D"), "90s", "10m", "1h30m", "10 minutes",
 * "1 hour and 5 min", or a bare number of seconds. Undefined when unreadable.
 */
export function parseDuration(text: string): number | undefined {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const iso = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (iso) {
    if (value.length < 2 || /T$/i.test(value)) return undefined;
    const [w, d, h, m, s] = iso.slice(1).map(v => (v === undefined ? 0 : Number(v)));
    const ms = ((((w * 7 + d) * 24 + h) * 60 + m) * 60 + s) * 1000;
    return ms > 0 ? ms : undefined;
  }
  // Human forms: every token must be "<number><unit>", joined by spaces, commas, and/und.
  const rest = value.toLowerCase().replace(/\b(and|und)\b/g, ' ').replace(/,(?!\d)/g, ' ');
  const re = /(\d+(?:[.,]\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = 0;
  for (let match = re.exec(rest); match; match = re.exec(rest)) {
    const unit = UNIT_MS.find(([pattern]) => pattern.test(match[2]));
    if (!unit) return undefined;
    total += Number(match[1].replace(',', '.')) * unit[1];
    consumed += match[0].replace(/\s/g, '').length;
  }
  if (consumed !== rest.replace(/\s/g, '').length) return undefined;
  return total > 0 ? total : undefined;
}

