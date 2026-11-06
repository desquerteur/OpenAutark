// Repositories for the generic key/value tables: `kv` (namespaced JSON values) and `meta`
// (app-level markers such as schema version and one-time import flags).
// Owns: SQL for kv/meta. Never: interprets values (callers own their namespaces).

import { json, toJson, type Db } from '../db/database.ts';

export class KvRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get<T>(ns: string, key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [ns, key]);
    return row ? json<T | undefined>(row.value, undefined) : undefined;
  }

  set(ns: string, key: string, value: unknown, at: number): void {
    this.db.run(
      `INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [ns, key, toJson(value), at],
    );
  }

  delete(ns: string, key: string): boolean {
    return this.db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [ns, key]).changes > 0;
  }

  list<T>(ns: string): Array<{ key: string; value: T; updatedAt: number }> {
    return this.db
      .all<{ key: string; value: string; updated_at: number }>('SELECT key, value, updated_at FROM kv WHERE ns = ? ORDER BY key', [ns])
      .map((row) => ({ key: row.key, value: json<T>(row.value, undefined as T), updatedAt: Number(row.updated_at) }));
  }
}

export class MetaRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;
  }

  set(key: string, value: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }
}
