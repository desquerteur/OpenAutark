// Repository for `spaces` (company, personal brand, private life …).
// Owns: SQL and row↔Space mapping. Never: validation or events (org/service.ts).

import type { Db, Row } from '../db/database.ts';
import type { Space } from '../../shared/model/org.ts';
import { compact, nul, opt, optNumber } from './rows.ts';

function toSpace(row: Row): Space {
  return compact({
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as Space['kind'],
    color: opt<string>(row.color),
    sort: Number(row.sort),
    createdAt: Number(row.created_at),
    archivedAt: optNumber(row.archived_at),
  });
}

export class SpaceRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  list(includeArchived = false): Space[] {
    const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
    return this.db.all(`SELECT * FROM spaces ${where} ORDER BY sort, created_at, rowid`).map(toSpace);
  }

  get(id: string): Space | undefined {
    const row = this.db.get('SELECT * FROM spaces WHERE id = ?', [id]);
    return row ? toSpace(row) : undefined;
  }

  upsert(space: Space): void {
    this.db.run(
      `INSERT INTO spaces (id, name, kind, color, sort, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, color = excluded.color,
         sort = excluded.sort, archived_at = excluded.archived_at`,
      [space.id, space.name, space.kind, nul(space.color), space.sort, space.createdAt, nul(space.archivedAt)],
    );
  }

  maxSort(): number {
    return Number(this.db.get<{ value: number | null }>('SELECT MAX(sort) AS value FROM spaces')?.value ?? -1);
  }
}
