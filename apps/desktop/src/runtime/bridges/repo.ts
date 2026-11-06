// Bridge rows (`bridges` table, migrations 4 and 28): a chat linked to an external messenger
// chat, the vault handle of its bot token, its update cursor, its status and the owner's linked
// Telegram account (C9: user id, display name, link time).
// Owns: reads and writes of that table and the row → Bridge mapping.
// Never: holds or returns token values (only `secret_id`, which never leaves the runtime), hands
// the owner's Telegram user id to clients (Bridge.owner carries the name only) and never emits
// events (the service does).

import type { Db } from '../db/database.ts';
import type { Bridge, BridgeKind, BridgeOwner, BridgeStatus } from '../../shared/model/bridges.ts';

interface Row {
  id: string; kind: string; conversation_id: string; secret_id: string; external_chat_id: string;
  cursor: string | null; status: string; error: string | null; created_at: number; updated_at: number;
  owner_user_id?: string | null; owner_name?: string | null; owner_linked_at?: number | null;
}

/** A stored bridge with the runtime-only fields. */
export interface BridgeRecord extends Bridge {
  secretId: string;
  /** Next update offset; undefined = never read (the backlog is skipped on first start). */
  cursor?: string;
  /** C9: the Telegram user id whose messages post as the owner (set together with `owner`). */
  ownerUserId?: string;
}

/** The owner's Telegram account as stored (C9). */
export interface OwnerRecord extends BridgeOwner {
  userId: string;
}

function toRecord(row: Row): BridgeRecord {
  const record: BridgeRecord = {
    id: row.id, kind: row.kind as BridgeKind, conversationId: row.conversation_id, externalChatId: row.external_chat_id,
    status: row.status as BridgeStatus, createdAt: row.created_at, updatedAt: row.updated_at, secretId: row.secret_id,
  };
  if (row.error) record.error = row.error;
  if (row.cursor !== null) record.cursor = row.cursor;
  if (row.owner_user_id) {
    record.ownerUserId = row.owner_user_id;
    record.owner = { name: row.owner_name || 'Telegram user', linkedAt: row.owner_linked_at ?? row.updated_at };
  }
  return record;
}

/** The client-visible shape (no vault handle, no cursor, no Telegram user id). */
export function publicBridge(record: BridgeRecord): Bridge {
  const bridge: Bridge = {
    id: record.id, kind: record.kind, conversationId: record.conversationId, externalChatId: record.externalChatId,
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
  if (record.error) bridge.error = record.error;
  if (record.owner) bridge.owner = { name: record.owner.name, linkedAt: record.owner.linkedAt };
  return bridge;
}

/** Shared start offset of bridges that read the same bot; undefined when none was read yet. */
export function maxCursor(records: BridgeRecord[]): number | undefined {
  const cursors = records.map((record) => Number(record.cursor ?? NaN)).filter((cursor) => Number.isFinite(cursor) && cursor >= 0);
  return cursors.length ? Math.max(...cursors) : undefined;
}

export class BridgeRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(conversationId?: string): BridgeRecord[] {
    const rows = conversationId === undefined
      ? this.db.all<Row>('SELECT * FROM bridges ORDER BY created_at, id')
      : this.db.all<Row>('SELECT * FROM bridges WHERE conversation_id = ? ORDER BY created_at, id', [conversationId]);
    return rows.map(toRecord);
  }

  get(id: string): BridgeRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM bridges WHERE id = ?', [id]);
    return row ? toRecord(row) : undefined;
  }

  find(conversationId: string, kind: BridgeKind, externalChatId: string): BridgeRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM bridges WHERE conversation_id = ? AND kind = ? AND external_chat_id = ?', [conversationId, kind, externalChatId]);
    return row ? toRecord(row) : undefined;
  }

  insert(record: BridgeRecord): void {
    this.db.run(
      `INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, cursor, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.kind, record.conversationId, record.secretId, record.externalChatId, record.cursor ?? null,
        record.status, record.error ?? null, record.createdAt, record.updatedAt],
    );
  }

  /** Returns the updated record, or undefined when the row is gone or nothing changed. */
  setStatus(id: string, status: BridgeStatus, error: string | undefined, now: number): BridgeRecord | undefined {
    const current = this.get(id);
    if (!current || (current.status === status && current.error === error)) return undefined;
    this.db.run('UPDATE bridges SET status = ?, error = ?, updated_at = ? WHERE id = ?', [status, error ?? null, now, id]);
    return this.get(id);
  }

  /** Stores the shared update cursor of all bridges that read the same bot. */
  setCursor(ids: string[], cursor: string): void {
    this.db.tx(() => {
      for (const id of ids) this.db.run('UPDATE bridges SET cursor = ? WHERE id = ?', [cursor, id]);
    });
  }

  setExternalChatId(id: string, externalChatId: string, now: number): void {
    this.db.run('UPDATE bridges SET external_chat_id = ?, updated_at = ? WHERE id = ?', [externalChatId, now, id]);
  }

  /** C9: links (undefined: unlinks) the owner's Telegram account; the updated record, undefined when the row is gone. */
  setOwner(id: string, owner: OwnerRecord | undefined, now: number): BridgeRecord | undefined {
    this.db.run('UPDATE bridges SET owner_user_id = ?, owner_name = ?, owner_linked_at = ?, updated_at = ? WHERE id = ?',
      [owner?.userId ?? null, owner?.name ?? null, owner?.linkedAt ?? null, now, id]);
    return this.get(id);
  }

  remove(id: string): void {
    this.db.run('DELETE FROM bridges WHERE id = ?', [id]);
  }
}
