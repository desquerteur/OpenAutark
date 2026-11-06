// Small helpers shared by the repositories for mapping SQLite rows to model objects.
// Owns: null/undefined conversion and typed column readers. Never: SQL or business rules.

import type { SQLInputValue } from 'node:sqlite';

/** SQLite NULL → undefined (models use optional fields, never null). */
export function opt<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : (value as T);
}

export function optNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

/** undefined → NULL for parameters. */
export function nul(value: SQLInputValue | undefined): SQLInputValue {
  return value === undefined ? null : value;
}

/** Drops keys whose value is undefined (keeps model objects clean for deepEqual and JSON). */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
