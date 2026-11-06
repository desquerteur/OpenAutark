// Time-based one-time codes (X05): RFC 4648 base32, RFC 4226 HOTP and RFC 6238 TOTP with
// node:crypto only, the stored form of a 2FA setup key, the variants the leak redactor looks for,
// and the setup keys a page shows (browser/place.ts masks them, browser/secret-tools.ts stores one).
// Owns: parsing and validating setup keys (an otpauth://totp link or a bare key), code computation
// and the detection rules. Never: logs, keeps or returns a key – every refusal is a bad_request with
// a fixed text that never quotes the input.
//
// Decisions:
// * Accepted: SHA1/SHA256/SHA512, 6–8 digits, a period of 15–120 s, 16–128 base32 characters
//   (spaces, dashes and '=' are ignored, any case). Issuer and account of a link are dropped.
// * Detection: otpauth://totp links always count. Base32 runs count only on a text with a 2FA
//   word ("QR code" or "scan" alone is none: menus and shops show QR codes) – a run of 4 or more
//   groups of 4 in one case (separated by one or two spaces – also no-break or thin spaces, as
//   innerText keeps &nbsp; – or dashes), or a compact run of 16–128 that contains a digit. A
//   grouped run whose every group reads like a word (has a vowel, no digit: "keep your data safe")
//   never counts in lower case; masking (looksLikeSetupKey) still counts such upper-case runs and
//   compact upper-case runs without a digit. Mask generously, capture strictly.
// * Redaction (seedPattern): the key in any case and any grouping, so a saved key is replaced
//   however a page or a tool spells it.

import { createHmac } from 'node:crypto';
import { WorkforceError } from '../../shared/errors.ts';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParams {
  key: Buffer;
  /** The key as given, upper-case base32 without separators or padding (the stored form). */
  base32: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 7 | 8;
  period: number; // seconds
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGORITHMS: readonly TotpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

export const TOTP_INVALID = 'This is not a valid 2FA setup key. Paste the otpauth:// link or the key shown under "enter key manually".';
export const TOTP_HOTP = 'Only time-based (TOTP) keys are supported.';
export const TOTP_LENGTH = 'A 2FA setup key has 16 to 128 characters.';
export const TOTP_CHARS = 'A 2FA setup key uses only the letters A–Z and the digits 2–7.';
export const TOTP_DIGITS = 'Only 6-, 7- or 8-digit codes are supported.';
export const TOTP_PERIOD = 'Only code periods of 15 to 120 seconds are supported.';
export const TOTP_ALGORITHM = 'Only the SHA1, SHA256 and SHA512 algorithms are supported.';

const refuse = (message: string): never => { throw new WorkforceError('bad_request', message); };

/** The key without spaces, dashes and '=' padding, upper-case – refused unless it is 16–128 base32 characters. */
function cleanKey(input: string): string {
  const key = input.replace(/[\s=-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(key)) refuse(TOTP_CHARS);
  if (key.length < 16 || key.length > 128) refuse(TOTP_LENGTH);
  return key;
}

/** RFC 4648 base32 (any case; spaces, dashes and '=' ignored); throws bad_request on other characters. */
export function base32Decode(input: string): Buffer {
  const text = input.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) refuse(TOTP_CHARS);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4648 base32 without padding. */
export function base32Encode(data: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
}

function paramsOf(base32: string, algorithm: string | null, digits: string | null, period: string | null): TotpParams {
  const alg = (algorithm ?? 'SHA1').toUpperCase().replace('-', '') as TotpAlgorithm;
  if (!ALGORITHMS.includes(alg)) refuse(TOTP_ALGORITHM);
  const d = digits === null ? 6 : Number(digits);
  if (d !== 6 && d !== 7 && d !== 8) refuse(TOTP_DIGITS);
  const p = period === null ? 30 : Number(period);
  if (!Number.isInteger(p) || p < 15 || p > 120) refuse(TOTP_PERIOD);
  const key = cleanKey(base32);
  return { key: base32Decode(key), base32: key, algorithm: alg, digits: d as TotpParams['digits'], period: p };
}

/** A 2FA setup key from an otpauth://totp link or a bare base32 key (see the header). */
export function parseTotp(input: string): TotpParams {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) refuse(TOTP_INVALID);
  if (!/^otpauth:/i.test(text)) return paramsOf(text, null, null, null);
  let url: URL;
  try { url = new URL(text); } catch { return refuse(TOTP_INVALID); }
  const type = url.host.toLowerCase();
  if (type === 'hotp') refuse(TOTP_HOTP);
  if (type !== 'totp') refuse(TOTP_INVALID);
  const secret = url.searchParams.get('secret');
  if (!secret) refuse(TOTP_INVALID);
  return paramsOf(secret!, url.searchParams.get('algorithm'), url.searchParams.get('digits'), url.searchParams.get('period'));
}

/** RFC 4226: HMAC over the 8-byte big-endian counter, dynamic truncation, `digits` decimal digits. */
export function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm = 'SHA1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(counter))));
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238: the code for the window `nowMs` falls in, and how long that window still lasts. */
export function totpCode(params: Pick<TotpParams, 'key' | 'algorithm' | 'digits' | 'period'>, nowMs: number): { code: string; remainingMs: number } {
  const periodMs = params.period * 1000;
  const counter = Math.floor(nowMs / periodMs);
  return { code: hotp(params.key, counter, params.digits, params.algorithm), remainingMs: (counter + 1) * periodMs - nowMs };
}

/** The stored (encrypted) value: canonical JSON {"k":BASE32,"a":"SHA1","d":6,"p":30}. */
export function serializeTotp(params: TotpParams): string {
  return JSON.stringify({ k: params.base32, a: params.algorithm, d: params.digits, p: params.period });
}

/** The parameters of a stored value (serializeTotp); throws bad_request when it is not one. */
export function readTotp(stored: string): TotpParams {
  let value: { k?: unknown; a?: unknown; d?: unknown; p?: unknown };
  try { value = JSON.parse(stored) as typeof value; } catch { return refuse(TOTP_INVALID); }
  if (typeof value?.k !== 'string') refuse(TOTP_INVALID);
  return paramsOf(value.k as string, typeof value.a === 'string' ? value.a : null, value.d === undefined ? null : String(value.d), value.p === undefined ? null : String(value.p));
}

/** An otpauth://totp link for the parameters (no issuer or account) – how a key moves inside the runtime. */
export function toOtpauth(params: TotpParams): string {
  return `otpauth://totp/key?secret=${params.base32}&algorithm=${params.algorithm}&digits=${params.digits}&period=${params.period}`;
}

/** How the key may be written in text the redactor checks: upper, lower, in groups of 4 (space or dash). */
export function seedVariants(params: Pick<TotpParams, 'base32'>): string[] {
  const upper = params.base32;
  const groups = upper.match(/.{1,4}/g) ?? [upper];
  const out = new Set<string>();
  for (const form of [upper, groups.join(' '), groups.join('-')]) { out.add(form); out.add(form.toLowerCase()); }
  return [...out];
}

/** What may stand between the characters of a written key: spaces (also no-break and thin ones), tabs and dashes. */
const SEPARATOR = String.raw`[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000-]`;
const SEPARATORS = new RegExp(`${SEPARATOR}+`);

/** The key in any spelling the redactor replaces: any case, any grouping (up to two separators between characters). */
export function seedPattern(params: Pick<TotpParams, 'base32'>): RegExp {
  return new RegExp([...params.base32].join(`${SEPARATOR}{0,2}`), 'gi');
}

// ------------------------------------------------------------------ setup keys on a page

const CONTEXT = /authenticator|two[- ]?factor|\b2fa\b|2-step|two-step|\bmfa\b|\btotp\b|setup key|secret key|enter\b[^.\n]{0,30}\b(?:key|secret)\b[^.\n]{0,20}\bmanually|manually enter\b[^.\n]{0,30}\b(?:key|secret)\b|can['’]?t scan|cannot scan/i;
/** The 2FA words that name a setup page for sure (the screenshot refusal pairs them with scan / QR code). */
export const STRONG_2FA = /authenticator|two[- ]?factor|\b2fa\b|2-step|two-step|\bmfa\b|\btotp\b|setup key|secret key/i;
const OTPAUTH = /otpauth:\/\/[^\s"'<>`)\]]+/gi;
/** 4+ groups of 4 in one case (one or two separators between), a shorter last group allowed (a 26-character key ends in "yz"). */
const groupedRun = (chars: string) => `${chars}{4}(?:${SEPARATOR}{1,2}${chars}{4}){3,31}(?:${SEPARATOR}{1,2}${chars}{1,3})?`;
const GROUPED = new RegExp(`(?<![A-Za-z0-9])(?:${groupedRun('[A-Z2-7]')}|${groupedRun('[a-z2-7]')})(?![A-Za-z0-9])`, 'g');
const COMPACT = /(?<![A-Za-z0-9])(?:[A-Z2-7]{16,128}|[a-z2-7]{16,128})={0,6}(?![A-Za-z0-9])/g;

/** Does the text read like a 2FA setup page (see CONTEXT)? */
export function has2faContext(text: string): boolean {
  return CONTEXT.test(text);
}

const wordLike = (group: string) => /[aeiouy]/i.test(group) && !/[2-7]/.test(group);

interface Candidate { text: string; params?: TotpParams; uri: boolean }

function tryParse(value: string): TotpParams | undefined {
  try { return parseTotp(value); } catch { return undefined; }
}

/**
 * Every run in `text` that may be a setup key, with its parse when it is a valid one: links
 * always; with a 2FA word (in `text` or `context`) grouped runs and compact runs (`loose`: also
 * upper-case runs without a digit, and upper-case grouped runs that read like words – never
 * lower-case prose).
 */
function candidates(text: string, loose: boolean, context = ''): Candidate[] {
  const out: Candidate[] = (text.match(OTPAUTH) ?? []).map((uri) => ({ text: uri, params: tryParse(uri), uri: true }));
  if (!has2faContext(text) && !has2faContext(context)) return out;
  const rest = text.replace(OTPAUTH, ' ');
  for (const run of rest.match(GROUPED) ?? []) {
    if ((!loose || run === run.toLowerCase()) && run.split(SEPARATORS).every(wordLike)) continue;
    out.push({ text: run, params: tryParse(run), uri: false });
  }
  for (const run of rest.match(COMPACT) ?? []) {
    if (!/[2-7]/.test(run) && !(loose && run === run.toUpperCase())) continue;
    out.push({ text: run, params: tryParse(run), uri: false });
  }
  return out;
}

/** The distinct setup keys in `text` (one entry per key; a link's parameters win), links first. */
export function findSetupKeys(text: string, context = ''): TotpParams[] {
  const found = candidates(text ?? '', false, context).filter((entry) => entry.params);
  const byKey = new Map<string, TotpParams>();
  for (const entry of [...found.filter((item) => item.uri), ...found.filter((item) => !item.uri)]) {
    if (!byKey.has(entry.params!.base32)) byKey.set(entry.params!.base32, entry.params!);
  }
  return [...byKey.values()];
}

/** The runs to mask in `text` (masking rules: generous), longest first. */
export function looksLikeSetupKey(text: string, context = ''): string[] {
  const runs = candidates(text ?? '', true, context).map((entry) => entry.text);
  return [...new Set(runs)].sort((a, b) => b.length - a.length);
}
