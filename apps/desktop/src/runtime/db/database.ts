// Thin wrapper around node:sqlite (built into Node 24 / Electron 44). All SQL goes through
// here so a later swap (e.g. better-sqlite3) is a one-file change.
// Owns: connection, pragmas, prepared-statement cache, transactions, JSON column helpers.
// Never: business logic. Repositories in src/runtime/store/* build on this.

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Row = Record<string, unknown>;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.raw = new DatabaseSync(path, { timeout: 5000, readOnly: options.readonly ?? false });
    if (!options.readonly) {
      this.raw.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -16000;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA secure_delete = ON; -- deleted rows (forgotten knowledge, removed chats) leave no bytes behind
      `);
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      if (this.cache.size > 400) this.cache.clear(); // bounded; statements are cheap to re-prepare
      this.cache.set(sql, statement);
    }
    return statement;
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const statement = this.statement(sql);
    return (Array.isArray(params) ? statement.get(...params) : statement.get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const statement = this.statement(sql);
    return (Array.isArray(params) ? statement.all(...params) : statement.all(params)) as T[];
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number | bigint } {
    const statement = this.statement(sql);
    const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` in a transaction (nested calls join the outer one via savepoints). B-059 #20: a COMMIT or RELEASE that
   * fails (disk full, I/O error) is rolled back like a failing `fn` – SQLite may have rolled back already, so that
   * rollback is best effort –, the original error is thrown and the depth drops exactly once, so the next tx() works.
   */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error) {
      try { this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* already rolled back by SQLite */ }
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    try { this.raw.exec('PRAGMA optimize'); } catch { /* best effort */ }
    this.cache.clear();
    this.raw.close();
  }
}

/** Parses a JSON column; returns `fallback` for null/invalid values. */
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/** Serializes a value for a JSON column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** SQLite has no booleans: 0/1 helpers. */
export const bool = (value: unknown): boolean => value === 1 || value === 1n || value === true;
export const int = (value: boolean): number => (value ? 1 : 0);
