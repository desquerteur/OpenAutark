// Calendar rows (migration 068 calendar_events; B-041 track A1): SQL for the members' local calendar and the
// mirrored rows of connected sources (shared/model/calendar.ts CalendarEvent). A task's block goes with its task
// (task_id … ON DELETE CASCADE); a block row has no title and no notes (the view reads the task). A row of a
// hidden source (calendar_sources.visible = 0) is left out of the window and the busy spans. Also used by the
// sources sync (track G) for its mirrored rows (bySource, bySeries, byExternal, deleteBySource).
// Owns: SQL for calendar_events and the staleness read of calendar_sources. Never: emits events, touches tasks,
// stores task text, or decides who may change a row (runtime/calendar/service.ts).

import { bool, int, type Db } from '../db/database.ts';
import { nul, opt } from '../store/rows.ts';
import { LOCAL_SOURCE_ID, type CalendarEvent } from '../../shared/model/calendar.ts';

type Row = Record<string, unknown>;

/** Rows of the app itself, or of a source the person shows (alias `e`). */
const SHOWN = `(e.source_id = '${LOCAL_SOURCE_ID}' OR e.source_id IN (SELECT id FROM calendar_sources WHERE visible = 1))`;
/** Ids per IN (…) list (well under SQLite's parameter limit). */
const CHUNK = 500;

export function toEvent(row: Row): CalendarEvent {
  const event: CalendarEvent = {
    id: String(row.id), ownerId: String(row.owner_id), kind: String(row.kind) as CalendarEvent['kind'], startAt: Number(row.start_at), endAt: Number(row.end_at),
    sourceId: String(row.source_id), setBy: String(row.set_by) as CalendarEvent['setBy'], state: String(row.state) as CalendarEvent['state'],
    createdBy: String(row.created_by), rev: Number(row.rev), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
  const taskId = opt<string>(row.task_id);
  const title = opt<string>(row.title);
  const notes = opt<string>(row.notes);
  const tz = opt<string>(row.tz);
  const externalId = opt<string>(row.external_id);
  const etag = opt<string>(row.etag);
  if (taskId) event.taskId = taskId;
  if (title !== undefined) event.title = title;
  if (notes !== undefined) event.notes = notes;
  if (tz) event.tz = tz;
  if (externalId) event.externalId = externalId;
  if (etag) event.etag = etag;
  if (bool(row.all_day)) event.allDay = true;
  if (bool(row.read_only)) event.readOnly = true;
  return event;
}

/** The text columns of a row: a to-do block carries none (its task has the text). */
const textOf = (event: CalendarEvent) => (event.kind === 'todo' ? [null, null] : [nul(event.title), nul(event.notes)]);

export class CalendarRepo {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): CalendarEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_events WHERE id = ?', [id]);
    return row ? toEvent(row) : undefined;
  }

  insert(event: CalendarEvent): void {
    this.db.run(
      `INSERT INTO calendar_events (id, owner_id, kind, task_id, title, notes, start_at, end_at, all_day, tz, source_id, external_id, etag, set_by, state,
         read_only, created_by, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.ownerId, event.kind, nul(event.taskId), ...textOf(event), event.startAt, event.endAt, int(event.allDay === true), nul(event.tz),
        event.sourceId, nul(event.externalId), nul(event.etag), event.setBy, event.state, int(event.readOnly === true), event.createdBy, event.rev,
        event.createdAt, event.updatedAt],
    );
  }

  /** Writes a changed row that was read at `rev` (event.rev is its new one); false when it changed meanwhile. */
  save(event: CalendarEvent, rev: number): boolean {
    return this.db.run(
      `UPDATE calendar_events SET title = ?, notes = ?, start_at = ?, end_at = ?, all_day = ?, tz = ?, external_id = ?, etag = ?, set_by = ?, state = ?,
         read_only = ?, rev = ?, updated_at = ? WHERE id = ? AND rev = ?`,
      [...textOf(event), event.startAt, event.endAt, int(event.allDay === true), nul(event.tz), nul(event.externalId), nul(event.etag), event.setBy,
        event.state, int(event.readOnly === true), event.rev, event.updatedAt, event.id, rev],
    ).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM calendar_events WHERE id = ?', [id]).changes > 0;
  }

  /** The owner's shown rows overlapping [from, to), by start. */
  inRange(ownerId: string, from: number, to: number): CalendarEvent[] {
    return this.db.all<Row>(
      `SELECT e.* FROM calendar_events e WHERE e.owner_id = ? AND e.start_at < ? AND e.end_at > ? AND ${SHOWN} ORDER BY e.start_at, e.end_at, e.id`,
      [ownerId, to, from],
    ).map(toEvent);
  }

  /** The block of a task (the newest when an older one is left over). */
  byTask(taskId: string): CalendarEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_events WHERE task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', [taskId]);
    return row ? toEvent(row) : undefined;
  }

  /** The blocks of these tasks, newest last (batched). */
  byTasks(taskIds: readonly string[]): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    for (let at = 0; at < taskIds.length; at += CHUNK) {
      const ids = taskIds.slice(at, at + CHUNK);
      out.push(...this.db.all<Row>(`SELECT * FROM calendar_events WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at, id`, ids).map(toEvent));
    }
    return out;
  }

  /** A mirrored row by its source and the source's own id (sources sync). */
  byExternal(sourceId: string, externalId: string): CalendarEvent | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_events WHERE source_id = ? AND external_id = ?', [sourceId, externalId]);
    return row ? toEvent(row) : undefined;
  }

  /** Every mirrored row of a source (also outside any window – a sync drops the ones that vanished). */
  bySource(sourceId: string): CalendarEvent[] {
    return this.db.all<Row>('SELECT * FROM calendar_events WHERE source_id = ? ORDER BY start_at, id', [sourceId]).map(toEvent);
  }

  /** Rows of a source whose external id is `externalId` or one of its instances ("<id>_<time>", Google's recurring events). */
  bySeries(sourceId: string, externalId: string): CalendarEvent[] {
    const like = `${externalId.replace(/[\\%_]/g, (char) => `\\${char}`)}\\_%`;
    return this.db.all<Row>(`SELECT * FROM calendar_events WHERE source_id = ? AND (external_id = ? OR external_id LIKE ? ESCAPE '\\')`, [sourceId, externalId, like]).map(toEvent);
  }

  /** Removes every row of a source (a removed connection); the removed ids. */
  deleteBySource(sourceId: string): string[] {
    const ids = this.db.all<{ id: string }>('SELECT id FROM calendar_events WHERE source_id = ?', [sourceId]).map((row) => row.id);
    this.db.run('DELETE FROM calendar_events WHERE source_id = ?', [sourceId]);
    return ids;
  }

  /** Every task block (id, owner, task) – what a cascade can take away without an event. */
  taskBlocks(): Array<{ id: string; ownerId: string; taskId: string }> {
    return this.db.all<{ id: string; owner_id: string; task_id: string }>('SELECT id, owner_id, task_id FROM calendar_events WHERE task_id IS NOT NULL')
      .map((row) => ({ id: row.id, ownerId: row.owner_id, taskId: row.task_id }));
  }

  /** Which of these row ids still exist. */
  existing(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (let at = 0; at < ids.length; at += CHUNK) {
      const part = ids.slice(at, at + CHUNK);
      for (const row of this.db.all<{ id: string }>(`SELECT id FROM calendar_events WHERE id IN (${part.map(() => '?').join(',')})`, part)) out.add(row.id);
    }
    return out;
  }

  /** Shown sources of the owner not synced since `before` (a source never synced counts from when it was added). */
  staleSources(ownerId: string, before: number): string[] {
    return this.db.all<{ id: string }>(
      'SELECT id FROM calendar_sources WHERE owner_id = ? AND visible = 1 AND COALESCE(last_sync_at, created_at) < ? ORDER BY created_at, id', [ownerId, before],
    ).map((row) => row.id);
  }
}
