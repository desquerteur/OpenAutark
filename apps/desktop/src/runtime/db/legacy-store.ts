// How the pre-rebuild JSON store (schema 1–7, legacy/src/settings.cjs) is told apart from B-044's own
// <data>/settings.json at the same path: the legacy store always has a numeric `schema` field and writes it first;
// the open data folder's settings file never has one. Read by the legacy import (import-v7.ts) and the settings
// settings file (settings/service.ts), which leaves a legacy store alone until the import has moved it aside.
// Owns: these two checks. Never: reads, imports or moves files.

/** The legacy store writes its format first (`{ "schema": 7, …`; \s also skips a BOM). */
const LEGACY_HEAD = /^\s*\{\s*"schema"\s*:\s*[1-7]\s*[,}]/;

/** True for a parsed legacy store (schema 1–7). */
export function isLegacyStore(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = (value as Record<string, unknown>).schema;
  return typeof schema === 'number' && Number.isInteger(schema) && schema >= 1 && schema <= 7;
}

/** True when a file's first characters are a legacy store's (for a file too large to parse). */
export function looksLegacy(head: string): boolean {
  return LEGACY_HEAD.test(head);
}
