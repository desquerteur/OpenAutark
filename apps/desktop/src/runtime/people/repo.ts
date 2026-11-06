// People repository (F-52, migration 41): rows of `people` and `people_audit` ↔ model, plus the
// small reads the org service uses to accept a person as an agent's manager (activePerson,
// personManagerId for the one cycle walk across people and agents, people/manager.ts).
// The owner's row ('human') holds title, avatar, manager and scopes; its name is the profile name
// (the service fills it in).
// Owns: SQL for these two tables. Never: tokens (people/tokens.ts), events or policy.

import { HUMAN_ID } from '../../shared/ids.ts';
import { DEFAULT_PERSON_SCOPES, type Person, type PersonAudit, type PersonScopes, type PersonStatus } from '../../shared/model/people.ts';
import type { Avatar } from '../../shared/model/org.ts';
import { json, toJson, type Db } from '../db/database.ts';

type Row = Record<string, unknown>;

const STATUSES: readonly PersonStatus[] = ['invited', 'active', 'revoked'];

/** Stored scopes → a complete, known set (unknown keys dropped, missing ones defaulted). */
export function cleanScopes(value: unknown): PersonScopes {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const spaces = raw.spaces === 'all' ? 'all'
    : Array.isArray(raw.spaces) ? [...new Set(raw.spaces.filter((id): id is string => typeof id === 'string' && id.length <= 64))].slice(0, 50)
    : DEFAULT_PERSON_SCOPES.spaces;
  return {
    spaces,
    startChats: typeof raw.startChats === 'boolean' ? raw.startChats : DEFAULT_PERSON_SCOPES.startChats,
    assignAgents: typeof raw.assignAgents === 'boolean' ? raw.assignAgents : DEFAULT_PERSON_SCOPES.assignAgents,
  };
}

function toPerson(row: Row): Person {
  const id = String(row.id);
  const person: Person = {
    id,
    name: String(row.name),
    title: String(row.title ?? ''),
    avatar: json<Avatar>(row.avatar, { kind: 'initials', value: '' }),
    status: (STATUSES as readonly string[]).includes(String(row.status)) ? row.status as PersonStatus : 'revoked',
    owner: id === HUMAN_ID,
    scopes: cleanScopes(json<unknown>(row.scopes, {})),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.manager_id !== null && row.manager_id !== undefined) person.managerId = String(row.manager_id);
  if (row.joined_at !== null && row.joined_at !== undefined) person.joinedAt = Number(row.joined_at);
  if (row.revoked_at !== null && row.revoked_at !== undefined) person.revokedAt = Number(row.revoked_at);
  return person;
}

/** True when `id` is a person who has not been revoked (an agent's or person's manager may be one). */
export function activePerson(db: Db, id: string): boolean {
  try {
    return Boolean(db.get(`SELECT 1 FROM people WHERE id = ? AND status <> 'revoked'`, [id]));
  } catch {
    return false; // a database without the table (it never had people)
  }
}

/** The manager of a person (or of the owner) as stored; undefined at the top or without the table. */
export function personManagerId(db: Db, id: string): string | undefined {
  try {
    const row = db.get<{ manager_id: string | null }>('SELECT manager_id FROM people WHERE id = ?', [id]);
    return row?.manager_id ? String(row.manager_id) : undefined;
  } catch {
    return undefined;
  }
}

export class PeopleRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Person | undefined {
    const row = this.db.get<Row>('SELECT * FROM people WHERE id = ?', [id]);
    return row ? toPerson(row) : undefined;
  }

  /** The owner first, then by name. */
  list(): Person[] {
    return this.db.all<Row>(`SELECT * FROM people ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, name COLLATE NOCASE, created_at`, [HUMAN_ID]).map(toPerson);
  }

  save(person: Person): void {
    this.db.run(
      `INSERT INTO people (id, name, title, avatar, manager_id, scopes, status, created_at, updated_at, joined_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, title = excluded.title, avatar = excluded.avatar, manager_id = excluded.manager_id,
         scopes = excluded.scopes, status = excluded.status, updated_at = excluded.updated_at, joined_at = excluded.joined_at, revoked_at = excluded.revoked_at`,
      [person.id, person.name, person.title, toJson(person.avatar), person.managerId ?? null, toJson(person.scopes), person.status,
        person.createdAt, person.updatedAt, person.joinedAt ?? null, person.revokedAt ?? null],
    );
  }

  /** People (and the owner) who report to `managerId`. */
  reports(managerId: string): Person[] {
    return this.db.all<Row>('SELECT * FROM people WHERE manager_id = ? ORDER BY name COLLATE NOCASE', [managerId]).map(toPerson);
  }

  audit(personId: string, at: number, actor: string, action: PersonAudit['action'], details: Record<string, unknown> = {}): void {
    this.db.run('INSERT INTO people_audit (person_id, at, actor, action, details) VALUES (?, ?, ?, ?, ?)', [personId, at, actor, action, toJson(details)]);
  }

  auditOf(personId: string, limit = 100): PersonAudit[] {
    return this.db.all<Row>('SELECT * FROM people_audit WHERE person_id = ? ORDER BY at DESC, id DESC LIMIT ?', [personId, Math.min(Math.max(limit, 1), 500)])
      .map((row) => ({ at: Number(row.at), actor: String(row.actor), action: String(row.action) as PersonAudit['action'], details: json<Record<string, unknown>>(row.details, {}) }));
  }
}
