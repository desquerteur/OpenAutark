// Parameter checks for RPC handlers. Clients include phones and browsers (untrusted input),
// so every handler reads its params through these helpers instead of trusting the static types.
// Owns: small, typed readers that throw `bad_request` with the offending parameter name.
// Never: business rules (services validate meaning), logging of values (params may hold secrets).

import { WorkforceError } from '../../shared/errors.ts';

export type Obj = Record<string, unknown>;

const isPlain = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Ids are generated (`ch_…`) or imported from the legacy store (any short token, e.g. "manager"). */
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

export function bad(key: string, expected: string): never {
  throw new WorkforceError('bad_request', `Invalid parameter "${key}": expected ${expected}.`, { details: { param: key } });
}

/** The params object (`void` methods and omitted params become `{}`). */
export function input(params: unknown): Obj {
  if (params === undefined || params === null) return {};
  if (!isPlain(params)) bad('params', 'an object');
  return params;
}

/** Rejects keys outside `allowed` so typos never silently do nothing. */
export function onlyKeys(o: Obj, allowed: readonly string[], key = 'params'): void {
  for (const name of Object.keys(o)) {
    if (!allowed.includes(name)) bad(`${key}.${name}`, `one of ${allowed.join(', ')}`);
  }
}

interface TextOptions { max?: number; allowEmpty?: boolean; multiline?: boolean }

/** A required string (trimmed check for emptiness; the value itself is returned as sent). */
export function text(o: Obj, key: string, options: TextOptions = {}): string {
  const value = o[key];
  const max = options.max ?? 10_000;
  if (typeof value !== 'string') bad(key, 'a string');
  if (!options.allowEmpty && !value.trim()) bad(key, 'a non-empty string');
  if (value.length > max) bad(key, `at most ${max} characters`);
  if (!options.multiline && /[\r\n]/.test(value)) bad(key, 'a single line');
  return value;
}

export function optText(o: Obj, key: string, options: TextOptions = {}): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : text(o, key, options);
}

/** An entity id (generated or imported). */
export function id(o: Obj, key = 'id'): string {
  const value = o[key];
  if (typeof value !== 'string' || !ID.test(value)) bad(key, 'an id');
  return value;
}

export function optId(o: Obj, key: string): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : id(o, key);
}

const FILE_ID = /^[0-9a-f]{64}$/;

/** A blob store file id (sha256, lowercase hex). Added by R4 contracts. */
export function fileId(o: Obj, key = 'fileId'): string {
  const value = o[key];
  if (typeof value !== 'string' || !FILE_ID.test(value)) bad(key, 'a file id');
  return value;
}

export function isIdLike(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * Member ids a client names (mentions, members to remove): an id, or an existing outside member's 'ext:' id –
 * a bridged contact ('ext:tg:<id>:<name> (Telegram)') or a connector's sender keeps its label, spaces and
 * all: one line of at most 160 characters (as chat-files/parse.ts isMemberId).
 */
export function optMemberIds(o: Obj, key: string, maxItems = 200): string[] | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) bad(key, 'a list of member ids');
  if (value.length > maxItems) bad(key, `at most ${maxItems} entries`);
  const ok = (entry: unknown) => isIdLike(entry) || (typeof entry === 'string' && entry.startsWith('ext:') && entry.length <= 160 && !/[\u0000-\u001f\u007f]/.test(entry));
  for (const entry of value) if (!ok(entry)) bad(key, 'a list of member ids');
  return [...new Set(value as string[])];
}

interface NumberOptions { min?: number; max?: number; integer?: boolean }

export function num(o: Obj, key: string, options: NumberOptions = {}): number {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(key, 'a number');
  if ((options.integer ?? true) && !Number.isInteger(value)) bad(key, 'an integer');
  if (options.min !== undefined && value < options.min) bad(key, `a number ≥ ${options.min}`);
  if (options.max !== undefined && value > options.max) bad(key, `a number ≤ ${options.max}`);
  return value;
}

export function optNum(o: Obj, key: string, options: NumberOptions = {}): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : num(o, key, options);
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') bad(key, 'true or false');
  return value;
}

export function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const value = o[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) bad(key, `one of ${values.join(', ')}`);
  return value as T;
}

export function optOneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T | undefined {
  return o[key] === undefined || o[key] === null ? undefined : oneOf(o, key, values);
}

/** An array of ids (deduplicated, order kept). */
export function ids(o: Obj, key: string, maxItems = 200): string[] {
  const value = o[key];
  if (!Array.isArray(value)) bad(key, 'a list of ids');
  if (value.length > maxItems) bad(key, `at most ${maxItems} entries`);
  for (const entry of value) if (!isIdLike(entry)) bad(key, 'a list of ids');
  return [...new Set(value as string[])];
}

export function optIds(o: Obj, key: string, maxItems = 200): string[] | undefined {
  return o[key] === undefined || o[key] === null ? undefined : ids(o, key, maxItems);
}

/** A list of short strings. */
export function optStrings(o: Obj, key: string, options: { maxItems?: number; max?: number } = {}): string[] | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  const maxItems = options.maxItems ?? 100;
  const max = options.max ?? 200;
  if (!Array.isArray(value) || value.length > maxItems) bad(key, `a list of at most ${maxItems} strings`);
  for (const entry of value) if (typeof entry !== 'string' || entry.length > max || CONTROL.test(entry)) bad(key, `strings of at most ${max} characters`);
  return value as string[];
}

export function obj(o: Obj, key: string): Obj {
  const value = o[key];
  if (!isPlain(value)) bad(key, 'an object');
  return value;
}

export function optObj(o: Obj, key: string): Obj | undefined {
  return o[key] === undefined || o[key] === null ? undefined : obj(o, key);
}

/** JSON size of a value (for caps on stored client state); `Infinity` when not serializable. */
export function jsonSize(value: unknown): number {
  try { return JSON.stringify(value ?? null).length; } catch { return Number.POSITIVE_INFINITY; }
}

/** Ensures a JSON-able value stays under `max` characters once serialized. */
export function capJson(key: string, value: unknown, max: number): void {
  if (jsonSize(value) > max) bad(key, `JSON data of at most ${Math.round(max / 1024)} KB`);
}

export function notFound(what: string, details?: Record<string, unknown>): never {
  throw new WorkforceError('not_found', `${what} not found.`, details ? { details } : {});
}
