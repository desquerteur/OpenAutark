// The sync clock: one stamp per synced unit (a row, a secret, a settings section) in kv ns 'sync' – {at, h}: when it
// last changed (this PC's clock, or the clock of the PC it came from) and a hash of what was sent, so an event
// that changes nothing that travels (a status, the echo of a row just applied) sends nothing. `r` hashes a merged part
// (the owner's read cursor, tables.ts `merged`): it travels with the same `at`, so a read never wins over an edit.
// Last writer wins: the later `at`; at the same `at` the larger hash, except for two units nobody changed since
// the link (at 0) – then the PC that joined takes the other one's (a fresh PC adopts the existing setup).
// kv's updated_at is this PC's time of storing a stamp: a link-up sends what was stored after that PC's cursor
// (ns 'sync.sent', the start of the last complete link-up with it).
// Owns: these stamps, the cursors and the hash. Never: reads a synced row's content (only which keys have no stamp)
// or writes one.

import { createHash } from 'node:crypto';
import type { Clock } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import { KvRepo } from '../../store/kv.ts';

/** `r`: the hash of a table's merged part (tables.ts `merged`, the owner's read cursor) – it travels without a new `at`. */
export interface Stamp { at: number; h: string; gone?: true; r?: string }

const NS = 'sync';
const SENT = 'sync.sent';

/** A stable hash of a JSON value (object keys sorted). */
export function hashOf(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable((item as Record<string, unknown>)[key])]));
  };
  return createHash('sha1').update(JSON.stringify(stable(value) ?? null)).digest('hex');
}

export class Stamps {
  private readonly db: Db;
  private readonly kv: KvRepo;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.kv = new KvRepo(db);
    this.clock = clock;
  }

  get(key: string): Stamp | undefined { return this.kv.get<Stamp>(NS, key); }

  set(key: string, stamp: Stamp): void { this.kv.set(NS, key, stamp, this.clock.now()); }

  drop(key: string): void { this.kv.delete(NS, key); }

  /** The stamp of a change made here now (never older than the last one). */
  next(old: Stamp | undefined, h: string, gone?: boolean): Stamp {
    return { at: Math.max(this.clock.now(), (old?.at ?? 0) + 1), h, ...(gone ? { gone: true as const } : {}) };
  }

  /** Keys under `prefix` stored after `after` (this PC's time), oldest first. */
  since(prefix: string, after: number): Array<{ key: string; stamp: Stamp }> {
    return this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM kv WHERE ns = ? AND updated_at > ? AND substr(key, 1, ?) = ? ORDER BY updated_at, key',
      [NS, after, prefix.length, prefix],
    ).map((row) => ({ key: row.key, stamp: JSON.parse(row.value) as Stamp }));
  }

  /** The keys (`key` column) of `table`'s rows that `where` picks and that have no stamp: rows that never travelled. */
  unstamped(table: string, key: string, where: string): string[] {
    return this.db.all<{ id: string }>(
      `SELECT t.${key} AS id FROM ${table} t WHERE ${where} AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.ns = ? AND kv.key = ? || t.${key})`,
      [NS, `${table}/`],
    ).map((row) => String(row.id));
  }

  cursor(peer: string): number | undefined { return this.kv.get<number>(SENT, peer); }
  setCursor(peer: string, at: number): void { this.kv.set(SENT, peer, at, this.clock.now()); }
  dropCursor(peer: string): void { this.kv.delete(SENT, peer); }
}

/** Whether an incoming unit replaces the local one (see the header); `joined`: this PC joined the sender. */
export function wins(incoming: Stamp, local: Stamp | undefined, joined: boolean): boolean {
  if (!local) return true;
  if (incoming.at !== local.at) return incoming.at > local.at;
  if (incoming.at === 0) return joined;
  return incoming.h > local.h;
}
