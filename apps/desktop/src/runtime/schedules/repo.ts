// Repository for `schedules`.
// Owns: row ↔ model mapping and the compare-and-swap "take this occurrence" statement that
// prevents double fires (also across processes sharing the DB). B-044: who paused a schedule
// (Schedule.pausedBy) is kept in the payload column's JSON under `pausedBy` – no column of its own.
// Never: computes times or fires anything.

import { bool, int, json, toJson, type Db } from '../db/database.ts';
import { nul, opt, optNumber } from '../store/rows.ts';
import type { Schedule } from '../../shared/model/tasks.ts';

type Row = Record<string, unknown>;

/** The payload column: the payload plus who paused the schedule. */
const payloadColumn = (s: Schedule) => toJson(s.pausedBy ? { ...s.payload, pausedBy: s.pausedBy } : s.payload);

export function toSchedule(row: Row): Schedule {
  const { pausedBy, ...payload } = json<Schedule['payload'] & { pausedBy?: unknown }>(row.payload, {}) ?? {};
  const schedule: Schedule = {
    id: String(row.id), ownerId: String(row.owner_id), kind: String(row.kind) as Schedule['kind'], title: String(row.title),
    spec: json<Schedule['spec']>(row.spec, {}), payload,
    runs: Number(row.runs), active: bool(row.active), createdAt: Number(row.created_at),
  };
  if (typeof pausedBy === 'string' && pausedBy) schedule.pausedBy = pausedBy;
  const conversationId = opt<string>(row.conversation_id);
  const taskId = opt<string>(row.task_id);
  const nextAt = optNumber(row.next_at);
  const lastAt = optNumber(row.last_at);
  if (conversationId) schedule.conversationId = conversationId;
  if (taskId) schedule.taskId = taskId;
  if (nextAt !== undefined) schedule.nextAt = nextAt;
  if (lastAt !== undefined) schedule.lastAt = lastAt;
  return schedule;
}

export class ScheduleRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Schedule | undefined {
    const row = this.db.get<Row>('SELECT * FROM schedules WHERE id = ?', [id]);
    return row ? toSchedule(row) : undefined;
  }

  insert(s: Schedule): void {
    this.db.run(
      `INSERT INTO schedules (id, owner_id, conversation_id, task_id, kind, title, spec, payload, next_at, last_at, runs, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.ownerId, nul(s.conversationId), nul(s.taskId), s.kind, s.title, toJson(s.spec), payloadColumn(s), nul(s.nextAt),
        nul(s.lastAt), s.runs, int(s.active), s.createdAt],
    );
  }

  save(s: Schedule): void {
    this.db.run(
      'UPDATE schedules SET title = ?, spec = ?, payload = ?, next_at = ?, last_at = ?, runs = ?, active = ? WHERE id = ?',
      [s.title, toJson(s.spec), payloadColumn(s), nul(s.nextAt), nul(s.lastAt), s.runs, int(s.active), s.id],
    );
  }

  /**
   * Takes the occurrence `expectedNext` of a schedule: moves next_at forward and records the
   * run in ONE conditional UPDATE. Only one caller can win for a given occurrence.
   */
  take(id: string, expectedNext: number, update: { nextAt?: number; lastAt: number; addRuns: number; active: boolean; lease: string }): boolean {
    return this.db.run(
      `UPDATE schedules SET next_at = ?, last_at = ?, runs = runs + ?, active = ?, lease = ?
       WHERE id = ? AND active = 1 AND next_at = ?`,
      [nul(update.nextAt), update.lastAt, update.addRuns, int(update.active), update.lease, id, expectedNext],
    ).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM schedules WHERE id = ?', [id]).changes > 0;
  }

  list(filter: { conversationId?: string; ownerId?: string; taskId?: string } = {}): Schedule[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.conversationId) { where.push('conversation_id = ?'); params.push(filter.conversationId); }
    if (filter.ownerId) { where.push('owner_id = ?'); params.push(filter.ownerId); }
    if (filter.taskId) { where.push('task_id = ?'); params.push(filter.taskId); }
    return this.db.all<Row>(
      `SELECT * FROM schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY active DESC, COALESCE(next_at, 9e15), created_at`,
      params,
    ).map(toSchedule);
  }

  due(now: number, limit = 100): Schedule[] {
    return this.db.all<Row>(
      'SELECT * FROM schedules WHERE active = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?',
      [now, limit],
    ).map(toSchedule);
  }

  nextAt(): number | undefined {
    const row = this.db.get<{ t: number | null }>('SELECT MIN(next_at) AS t FROM schedules WHERE active = 1 AND next_at IS NOT NULL');
    return row?.t === null || row?.t === undefined ? undefined : Number(row.t);
  }

  activeCount(ownerId: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE owner_id = ? AND active = 1', [ownerId])?.n ?? 0);
  }
}
