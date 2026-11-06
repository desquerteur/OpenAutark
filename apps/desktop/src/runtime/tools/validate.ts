// Small JSON-Schema validator for tool arguments (the subset our tool schemas use).
// Owns: type/required/enum/range/length/items/properties/additionalProperties/anyOf checks
// with short, model-readable error lines ("text: required").
// Never: coerces or mutates values, fetches $refs, or throws on unknown keywords (ignored).

import type { JsonSchema } from './types.ts';

type Schema = JsonSchema & {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
};

const MAX_ERRORS = 8;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function check(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return;
  const where = path || 'arguments';

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) {
    const ok = alternatives.some((option) => { const inner: string[] = []; check(value, option, path, inner); return inner.length === 0; });
    if (!ok) errors.push(`${where}: does not match any allowed shape`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${where}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push(`${where}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: too short (min ${schema.minLength})`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: too long (max ${schema.maxLength})`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${where}: must be a finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => check(item, schema.items!, `${where}[${index}]`, errors));
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) errors.push(`${path ? `${path}.` : ''}${key}: required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(record)) {
      const childPath = path ? `${path}.${key}` : key;
      if (properties[key]) {
        if (item !== undefined) check(item, properties[key], childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: unknown property`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(item, schema.additionalProperties, childPath, errors);
      }
    }
  }
}

/** Returns error lines (empty when valid). `undefined`/`null` args are validated as `{}`. */
export function validate(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  check(value ?? {}, schema as Schema, '', errors);
  return errors;
}
