// Owns: a real SQLite adapter for local receiver tests. Never: provider credentials or remote data.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Statement } from '../src/types.ts';
class Query implements Statement {
  db: DatabaseSync; sql: string; args: unknown[] = [];
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]): Query { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return this.db.prepare(this.sql).get(...this.args as never[]) as T ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args as never[]) as T[] }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.args as never[]); return { meta: { changes: Number(result.changes) } }; }
}
export function databaseFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { db, binding: { prepare: (sql: string) => new Query(db, sql) } };
}
