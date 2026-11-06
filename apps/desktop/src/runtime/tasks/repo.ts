// Repository for tasks (incl. checklist steps and human to-dos) and `tasks_fts`.
// Owns: row ↔ model mapping, list queries, the atomic claim statement (it records the claiming
// agent as assigned_by, T08), the FTS index. A task's chat changes only at insert or through chat deletion (B-054).
// An agent's list query can be narrowed to what it may read (filter.readableBy, tasks/access.ts).
// B-041 (migration 068): My day's columns – estimate, focus timer, window/prep (JSON), private (0/1).
// B-054 (migration 082): conversation_id is nullable (a chat-free task), space_id (chat-free tasks only) and the
// origin (source/source_label); a space filter reads the chat's space, else the task's own.
// Never: emits events, posts chat lines or wakes agents (tasks/service.ts does).

import { json, toJson, type Db } from '../db/database.ts';
import { nul, opt, optNumber } from '../store/rows.ts';
import { foldText, ftsQuery } from '../../shared/text/normalize.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { Task, TaskFilter, TaskLedger, TaskResult } from '../../shared/model/tasks.ts';
import type { TaskPrep, TaskWindow } from '../../shared/model/calendar.ts';
import type { Origin } from '../../shared/model/origin.ts';
import { readableSql } from './access.ts';
import { readableTasksSql } from '../people/access.ts';

type Row = Record<string, unknown>;

export function toTask(row: Row): Task {
  const task: Task = {
    id: String(row.id),
    title: String(row.title),
    notes: String(row.notes),
    status: String(row.status) as Task['status'],
    assigneeKind: String(row.assignee_kind) as Task['assigneeKind'],
    createdBy: String(row.created_by),
    priority: Number(row.priority) as Task['priority'],
    ledger: json<TaskLedger>(row.ledger, {}),
    attempts: Number(row.attempts),
    sort: Number(row.sort),
    rev: Number(row.rev),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  const set = <K extends keyof Task>(key: K, value: Task[K] | undefined) => { if (value !== undefined) task[key] = value; };
  set('conversationId', opt<string>(row.conversation_id));
  set('spaceId', opt<string>(row.space_id));
  set('origin', originOf(row));
  set('messageId', opt<string>(row.message_id));
  set('parentId', opt<string>(row.parent_id));
  set('assigneeId', opt<string>(row.assignee_id));
  set('dueAt', optNumber(row.due_at));
  set('goal', opt<string>(row.goal));
  set('doneWhen', opt<string>(row.done_when));
  set('mode', opt<string>(row.mode));
  set('widget', row.widget === null ? undefined : json<UiBlock | undefined>(row.widget, undefined));
  set('humanReason', opt<Task['humanReason']>(row.human_reason));
  set('waitingOn', row.waiting_on === null ? undefined : json<Task['waitingOn']>(row.waiting_on, undefined));
  set('result', row.result === null ? undefined : json<TaskResult | undefined>(row.result, undefined));
  set('startedAt', optNumber(row.started_at));
  set('completedAt', optNumber(row.completed_at));
  set('assignedBy', opt<string>(row.assigned_by));
  set('estimateMin', optNumber(row.estimate_min));
  set('estimateSource', opt<Task['estimateSource']>(row.estimate_source));
  set('spentMs', optNumber(row.spent_ms));
  set('timerStartedAt', optNumber(row.timer_started_at));
  set('window', row.window === null || row.window === undefined ? undefined : json<TaskWindow | undefined>(row.window, undefined));
  set('prep', row.prep === null || row.prep === undefined ? undefined : json<TaskPrep | undefined>(row.prep, undefined));
  if (Number(row.private) === 1) task.private = true; // 0 = absent (compact rows)
  const after = json<string[]>(row.depends_on, []);
  if (after.length) task.dependsOn = after; // [] = absent (compact rows)
  return task;
}

/** B-054: the stored origin (source_label falls back to the source). */
function originOf(row: Row): Origin | undefined {
  const source = opt<string>(row.source);
  return source === undefined ? undefined : { source: String(source), label: String(opt<string>(row.source_label) ?? source) };
}

/** B-041 columns (migration 068) as statement parameters, in the order of DAY_COLUMNS. */
const DAY_COLUMNS = `estimate_min, estimate_source, spent_ms, timer_started_at, "window", prep, private`;
const dayValues = (t: Task) => [nul(t.estimateMin), nul(t.estimateSource), nul(t.spentMs), nul(t.timerStartedAt),
  t.window ? toJson(t.window) : null, t.prep ? toJson(t.prep) : null, t.private ? 1 : 0];
/** B-054 columns (migration 082) at insert: space_id, source, source_label. The space is stored only without a chat. */
const ownValues = (t: Task) => [t.conversationId ? null : nul(t.spaceId), nul(t.origin?.source), nul(t.origin?.source ? t.origin.label : undefined)];

const STATUS_RANK = `CASE status WHEN 'needs_you' THEN 0 WHEN 'working' THEN 1 WHEN 'blocked' THEN 2 WHEN 'waiting' THEN 3
  WHEN 'open' THEN 4 WHEN 'done' THEN 5 ELSE 6 END`;
/** When a finished task finished (rows without completed_at fall back like the UI's finishedAt). */
const FINISHED_AT = 'COALESCE(t.completed_at, t.updated_at)';

export class TaskRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Task | undefined {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
    return row ? toTask(row) : undefined;
  }

  byClientId(clientId: string): Task | undefined {
    const row = this.db.get<Row>('SELECT * FROM tasks WHERE client_id = ?', [clientId]);
    return row ? toTask(row) : undefined;
  }

  insert(t: Task, clientId?: string): void {
    this.db.run(
      `INSERT INTO tasks (id, conversation_id, message_id, parent_id, title, notes, status, assignee_kind, assignee_id, created_by,
         priority, due_at, goal, done_when, mode, widget, human_reason, waiting_on, result, ledger, attempts, sort, rev,
         client_id, created_at, updated_at, started_at, completed_at, assigned_by, ${DAY_COLUMNS}, space_id, source, source_label, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, nul(t.conversationId), nul(t.messageId), nul(t.parentId), t.title, t.notes, t.status, t.assigneeKind, nul(t.assigneeId), t.createdBy,
        t.priority, nul(t.dueAt), nul(t.goal), nul(t.doneWhen), nul(t.mode), t.widget ? toJson(t.widget) : null,
        nul(t.humanReason), t.waitingOn ? toJson(t.waitingOn) : null, t.result ? toJson(t.result) : null, toJson(t.ledger), t.attempts,
        t.sort, t.rev, nul(clientId), t.createdAt, t.updatedAt, nul(t.startedAt), nul(t.completedAt), nul(t.assignedBy), ...dayValues(t),
        ...ownValues(t), toJson(t.dependsOn ?? [])],
    );
    this.index(t);
  }

  /**
   * Writes all mutable fields with optimistic concurrency: only when `rev` still matches. The chat is not one of
   * them (B-054: set at insert, detached only by chat deletion), so a stale copy never re-points a detached row;
   * the space is kept only on a chat-free row, and an absent space or origin keeps the stored one.
   */
  save(t: Task, expectedRev: number): boolean {
    const changes = this.db.run(
      `UPDATE tasks SET message_id = ?, title = ?, notes = ?, status = ?, assignee_kind = ?, assignee_id = ?, priority = ?, due_at = ?,
         goal = ?, done_when = ?, mode = ?, widget = ?, human_reason = ?, waiting_on = ?, result = ?, ledger = ?,
         attempts = ?, sort = ?, rev = ?, updated_at = ?, started_at = ?, completed_at = ?, assigned_by = ?,
         estimate_min = ?, estimate_source = ?, spent_ms = ?, timer_started_at = ?, "window" = ?, prep = ?, private = ?, depends_on = ?,
         space_id = CASE WHEN conversation_id IS NULL THEN COALESCE(?, space_id) END,
         source = COALESCE(?, source), source_label = CASE WHEN ? IS NULL THEN source_label ELSE ? END
       WHERE id = ? AND rev = ?`,
      [nul(t.messageId), t.title, t.notes, t.status, t.assigneeKind, nul(t.assigneeId), t.priority, nul(t.dueAt),
        nul(t.goal), nul(t.doneWhen), nul(t.mode), t.widget ? toJson(t.widget) : null, nul(t.humanReason),
        t.waitingOn ? toJson(t.waitingOn) : null, t.result ? toJson(t.result) : null, toJson(t.ledger), t.attempts, t.sort, t.rev,
        t.updatedAt, nul(t.startedAt), nul(t.completedAt), nul(t.assignedBy), ...dayValues(t), toJson(t.dependsOn ?? []), nul(t.spaceId),
        nul(t.origin?.source), nul(t.origin?.source), nul(t.origin?.source ? t.origin.label : undefined), t.id, expectedRev],
    ).changes;
    if (changes) this.index(t);
    return changes > 0;
  }

  /**
   * Atomic claim: succeeds only for an open task that is team-assigned, unassigned, or already
   * assigned to this agent. One UPDATE statement = no race between agents or processes. The
   * claimer becomes the task's assigner (self-assignment: nobody else is woken when it is done).
   */
  claim(id: string, agentId: string, at: number): boolean {
    return this.db.run(
      `UPDATE tasks SET assignee_kind = 'agent', assignee_id = ?, assigned_by = ?, status = 'working', started_at = COALESCE(started_at, ?),
         rev = rev + 1, updated_at = ?
       WHERE id = ? AND status = 'open'
         AND (assignee_kind = 'team' OR (assignee_kind = 'agent' AND (assignee_id IS NULL OR assignee_id = ?)))`,
      [agentId, agentId, at, at, id, agentId],
    ).changes > 0;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM tasks_fts WHERE rowid IN (SELECT rowid FROM tasks WHERE id = ? OR parent_id = ?)', [id, id]);
    this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  }

  children(parentId: string): Task[] {
    return this.db.all<Row>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort, created_at', [parentId]).map(toTask);
  }

  childrenOf(ids: string[]): Map<string, Task[]> {
    const out = new Map<string, Task[]>();
    if (!ids.length) return out;
    const rows = this.db.all<Row>(`SELECT * FROM tasks WHERE parent_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, created_at`, ids);
    for (const row of rows) {
      const task = toTask(row);
      const list = out.get(task.parentId!) ?? [];
      list.push(task);
      out.set(task.parentId!, list);
    }
    return out;
  }

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (!filter.includeSteps) where.push('t.parent_id IS NULL');
    if (filter.conversationId) { where.push('t.conversation_id = ?'); params.push(filter.conversationId); }
    if (filter.status?.length) { where.push(`t.status IN (${filter.status.map(() => '?').join(',')})`); params.push(...filter.status); }
    if (filter.assigneeKind) { where.push('t.assignee_kind = ?'); params.push(filter.assigneeKind); }
    if (filter.assigneeId) { where.push('t.assignee_id = ?'); params.push(filter.assigneeId); }
    // B-054: the chat's space, else the chat-free task's own (a chat-free task without a space is in none).
    if (filter.spaceId) { where.push('COALESCE((SELECT c.space_id FROM conversations c WHERE c.id = t.conversation_id), t.space_id) = ?'); params.push(filter.spaceId); }
    if (filter.readableBy) { const readable = readableSql(filter.readableBy); where.push(readable.sql); params.push(...readable.params); } // agents' queries
    if (filter.readableByPerson) { const readable = readableTasksSql(filter.readableByPerson); where.push(readable.sql); params.push(...readable.params); } // F-52: a person's queries
    if (filter.search?.trim()) {
      const query = ftsQuery(filter.search);
      if (!query) return [];
      where.push('t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)');
      params.push(query);
    }
    // "Recently done" window: finished tasks only, newest first (finish time as the UI reads it).
    const recent = filter.completedSince !== undefined;
    if (recent) {
      where.push(`t.status IN ('done', 'cancelled') AND ${FINISHED_AT} >= ?`);
      params.push(filter.completedSince!);
    }
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const order = recent
      ? `${FINISHED_AT} DESC, t.created_at DESC`
      : `${STATUS_RANK.replaceAll('status', 't.status')}, t.priority DESC, COALESCE(t.due_at, 9e15), t.sort, t.created_at`;
    return this.db.all<Row>(
      `SELECT t.* FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`,
      params,
    ).map(toTask);
  }

  /**
   * The calm "My day" list: open human items, and those waiting for a ring – snoozed, or a
   * repeating timer ticked off until its next time (waiting_on.kind 'schedule'; the UI keeps them
   * under "Later", F04). Binding approvals first, then what rang, then the rest, the waiting ones
   * last (so a limit never drops a to-do due now for a later one); each by due → priority → age.
   */
  todos(limit: number, personId?: string): Task[] {
    // F-52: the owner's list has no assignee id; a person's list is theirs (runtime/people).
    const whose = personId ? 'assignee_id = ?' : `(assignee_id IS NULL OR assignee_id = 'human')`;
    return this.db.all<Row>(
      `SELECT * FROM tasks WHERE assignee_kind = 'human' AND ${whose}
         AND (status IN ('open', 'needs_you', 'working') OR (status = 'waiting' AND json_extract(waiting_on, '$.kind') = 'schedule'))
       ORDER BY CASE WHEN status = 'waiting' THEN 3 WHEN status = 'needs_you' THEN 1 ELSE 2 END,
         CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, priority DESC, created_at LIMIT ?`,
      personId ? [personId, limit] : [limit],
    ).map(toTask);
  }

  openFor(agentId: string): Task[] {
    return this.db.all<Row>(
      `SELECT * FROM tasks WHERE assignee_kind = 'agent' AND assignee_id = ? AND status NOT IN ('done', 'cancelled')
       ORDER BY priority DESC, COALESCE(due_at, 9e15), created_at`,
      [agentId],
    ).map(toTask);
  }

  /** The unfinished tasks that come after `id` (tasks/depends.ts). */
  dependents(id: string): Task[] {
    return this.db.all<Row>(`SELECT * FROM tasks WHERE depends_on LIKE ? AND status NOT IN ('done', 'cancelled')`, [`%"${id}"%`]).map(toTask);
  }

  byStatus(status: Task['status']): Task[] {
    return this.db.all<Row>('SELECT * FROM tasks WHERE status = ? ORDER BY created_at', [status]).map(toTask);
  }

  /**
   * An open human to-do anchored to a block id in a chat (block "id" replaces earlier ones) – only one
   * the same author created: another agent's block with that id never replaces it (the to-do change
   * contract, concept-generative-chat-ui-adaptive-widgets 22).
   */
  openByBlockId(conversationId: string, blockId: string, createdBy: string): Task | undefined {
    const row = this.db.get<Row>(
      `SELECT * FROM tasks WHERE conversation_id = ? AND assignee_kind = 'human' AND status NOT IN ('done', 'cancelled')
       AND json_extract(widget, '$.id') = ? AND created_by = ? ORDER BY created_at DESC LIMIT 1`,
      [conversationId, blockId, createdBy],
    );
    return row ? toTask(row) : undefined;
  }

  private index(t: Task): void {
    this.db.run('DELETE FROM tasks_fts WHERE rowid = (SELECT rowid FROM tasks WHERE id = ?)', [t.id]);
    const text = foldText([t.title, t.notes, t.doneWhen ?? '', t.result?.summary ?? ''].join(' ')).trim();
    if (!text) return;
    this.db.run('INSERT INTO tasks_fts (rowid, task_id, text) SELECT rowid, id, ? FROM tasks WHERE id = ?', [text, t.id]);
  }
}
