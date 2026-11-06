// Repository for `agents`.
// Owns: SQL and row↔Agent mapping (JSON columns: avatar, skills, model_policy; the old `variant`, `budget` and
// `based_on` columns stay in the table, unread and unwritten – a new row takes their defaults).
// F-52: an agent's manager may be a person of the organisation – stored in person_manager_id
// (migration 42; manager_id references agents), both read as Agent.managerId.
// Never: validation, org rules or events (org/service.ts).

import { json, toJson, type Db, type Row } from '../db/database.ts';
import type { Agent } from '../../shared/model/org.ts';
import { compact, nul, opt, optNumber } from './rows.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { isPersonId } from '../../shared/model/people.ts';

function toAgent(row: Row): Agent {
  return compact({
    id: String(row.id),
    name: String(row.name),
    role: String(row.role ?? ''),
    avatar: json<Agent['avatar']>(row.avatar, { kind: 'initials', value: '?', color: 0 }),
    spaceId: opt<string>(row.space_id),
    managerId: opt<string>(row.person_manager_id) ?? opt<string>(row.manager_id), // F-52: a person, else an agent
    team: opt<string>(row.team),
    instructions: String(row.instructions ?? ''),
    mode: String(row.mode),
    skills: json<string[]>(row.skills, []),
    modelPolicy: json<Agent['modelPolicy']>(row.model_policy, {}),
    deviceId: opt<string>(row.device_id),
    status: row.status as Agent['status'],
    statusNote: opt<string>(row.status_note),
    template: opt<string>(row.template),
    voice: opt<string>(row.voice),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: optNumber(row.archived_at),
  });
}

const COLUMNS = `id, name, role, avatar, space_id, manager_id, team, instructions, mode, skills, model_policy,
  device_id, status, status_note, template, created_by, created_at, updated_at, archived_at, voice`;

export class AgentRepo {
  private readonly db: Db;
  private personColumn = false;
  constructor(db: Db) { this.db = db; }

  /** F-52: the person_manager_id column exists (migration 42, or compose/people.ts on a database that skipped it). */
  private hasPersonColumn(): boolean {
    if (!this.personColumn) this.personColumn = this.db.all<{ name: string }>('PRAGMA table_info(agents)').some((column) => column.name === 'person_manager_id');
    return this.personColumn;
  }

  list(includeArchived = false): Agent[] {
    const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
    return this.db.all(`SELECT * FROM agents ${where} ORDER BY created_at, rowid`).map(toAgent);
  }

  get(id: string): Agent | undefined {
    const row = this.db.get('SELECT * FROM agents WHERE id = ?', [id]);
    return row ? toAgent(row) : undefined;
  }

  /** Total rows including archived ones (seed check). */
  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents')?.n ?? 0);
  }

  /** Direct reports (not archived). */
  reports(managerId: string): Agent[] {
    return this.db.all('SELECT * FROM agents WHERE manager_id = ? AND archived_at IS NULL ORDER BY created_at, rowid', [managerId]).map(toAgent);
  }

  /** Inserts or fully replaces the row. */
  save(agent: Agent): void {
    const toPerson = isPersonId(agent.managerId);
    if (toPerson || this.hasPersonColumn()) {
      if (!this.hasPersonColumn()) throw new WorkforceError('unavailable', 'Restart the app to let agents report to people.');
      this.saveRow({ ...agent, managerId: toPerson ? undefined : agent.managerId });
      this.db.run('UPDATE agents SET person_manager_id = ? WHERE id = ?', [toPerson ? agent.managerId! : null, agent.id]);
      return;
    }
    this.saveRow(agent);
  }

  private saveRow(agent: Agent): void {
    this.db.run(
      `INSERT INTO agents (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, avatar = excluded.avatar,
         space_id = excluded.space_id, manager_id = excluded.manager_id, team = excluded.team,
         instructions = excluded.instructions, mode = excluded.mode, skills = excluded.skills,
         model_policy = excluded.model_policy,
         device_id = excluded.device_id, status = excluded.status, status_note = excluded.status_note,
         template = excluded.template, updated_at = excluded.updated_at, archived_at = excluded.archived_at,
         voice = excluded.voice`,
      [
        agent.id, agent.name, agent.role, toJson(agent.avatar), nul(agent.spaceId), nul(agent.managerId), nul(agent.team),
        agent.instructions, agent.mode, toJson(agent.skills), toJson(agent.modelPolicy),
        nul(agent.deviceId), agent.status, nul(agent.statusNote), nul(agent.template),
        agent.createdBy, agent.createdAt, agent.updatedAt, nul(agent.archivedAt), nul(agent.voice),
      ],
    );
  }

  /** Cheap status write (called often while agents work). */
  setStatus(id: string, status: Agent['status'], note: string | undefined, at: number): boolean {
    return this.db.run('UPDATE agents SET status = ?, status_note = ?, updated_at = ? WHERE id = ?', [status, nul(note), at, id]).changes > 0;
  }

  /**
   * B-059 #21: at start no turn runs yet – a 'working'/'waiting' status and its step note a crash or power loss left
   * behind are stale and become 'idle' (a pause or an error stays). Returns how many agents changed.
   */
  resetBusy(at: number): number {
    return Number(this.db.run(`UPDATE agents SET status = 'idle', status_note = NULL, updated_at = ? WHERE status IN ('working', 'waiting')`, [at]).changes);
  }
}
