// Repository for `split_groups` and `splits` (B-057, migration 084): the groups an agent split its work into and their
// parts. Plain SQL, epoch ms; `after`, `fork` and `branch` are JSON columns, `ultra` and `worktree` 0/1. A group's
// `parts` and a split's `of` are not stored – both are the number of the group's split rows (a group and its splits
// are saved in one transaction by the split service). The origin is stored like a run's (source / source_label).
// Patches (updateSplit / updateGroup): a key that is present changes the column – present with `undefined` clears it
// (NULL) – and an absent key keeps it.
// Owns: SQL and row↔SplitGroup/Split mapping. Never: lifecycle rules, events or limits (runtime/splits/**).

import { json, toJson, type Db, type Row } from '../db/database.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { Split, SplitGroup, SplitGroupStatus, SplitStatus } from '../../shared/model/splits.ts';
import type { Origin } from '../../shared/model/origin.ts';
import { compact, nul, opt, optNumber } from './rows.ts';

export interface SplitGroupQuery {
  agentId?: string;
  parentRunId?: string;
  conversationId?: string;
  /** The groups split by a turn on this task. */
  taskId?: string;
  thread?: string;
  statuses?: readonly SplitGroupStatus[];
  /** Newest first; without a limit every matching group. */
  limit?: number;
}

export interface SplitQuery {
  groupId?: string;
  /** Several groups at once (a list view of groups). */
  groupIds?: readonly string[];
  agentId?: string;
  statuses?: readonly SplitStatus[];
}

/** What updateSplit may change (identity, place in the group and creation time never change). */
export type SplitPatch = Partial<Omit<Split, 'id' | 'groupId' | 'agentId' | 'idx' | 'of' | 'createdAt'>>;
/** What updateGroup may change. */
export type SplitGroupPatch = Partial<Pick<SplitGroup, 'status' | 'startedAt' | 'endedAt' | 'gatheredAt' | 'cwd' | 'modeKey' | 'ultra'>>;

const GROUP_SELECT = 'SELECT g.*, (SELECT COUNT(*) FROM splits c WHERE c.group_id = g.id) AS part_count FROM split_groups g';
const SPLIT_SELECT = 'SELECT s.*, (SELECT COUNT(*) FROM splits c WHERE c.group_id = s.group_id) AS part_count FROM splits s';

const GROUP_COLUMNS: Record<keyof SplitGroupPatch, { column: string; value: (v: unknown) => SQLInputValue }> = {
  status: { column: 'status', value: (v) => nul(v as string | undefined) },
  startedAt: { column: 'started_at', value: (v) => nul(v as number | undefined) },
  endedAt: { column: 'ended_at', value: (v) => nul(v as number | undefined) },
  gatheredAt: { column: 'gathered_at', value: (v) => nul(v as number | undefined) },
  cwd: { column: 'cwd', value: (v) => nul(v as string | undefined) },
  modeKey: { column: 'mode_key', value: (v) => nul(v as string | undefined) },
  ultra: { column: 'ultra', value: (v) => (v ? 1 : 0) },
};

const jsonOrNull = (v: unknown): SQLInputValue => (v === undefined ? null : toJson(v));
const SPLIT_COLUMNS: Record<keyof SplitPatch, { column: string; value: (v: unknown) => SQLInputValue }> = {
  title: { column: 'title', value: (v) => String(v ?? '') },
  brief: { column: 'brief', value: (v) => String(v ?? '') },
  returns: { column: 'returns', value: (v) => nul(v as string | undefined) },
  context: { column: 'context', value: (v) => String(v ?? 'fork') },
  model: { column: 'model', value: (v) => nul(v as string | undefined) },
  effort: { column: 'effort', value: (v) => nul(v as string | undefined) },
  after: { column: '"after"', value: (v) => toJson(v ?? []) },
  worktree: { column: 'worktree', value: (v) => (v ? 1 : 0) },
  status: { column: 'status', value: (v) => String(v ?? 'pending') },
  attempts: { column: 'attempts', value: (v) => Number(v ?? 0) },
  error: { column: 'error', value: (v) => nul(v as string | undefined) },
  fork: { column: 'fork', value: jsonOrNull },
  branch: { column: 'branch', value: jsonOrNull },
  startedAt: { column: 'started_at', value: (v) => nul(v as number | undefined) },
  endedAt: { column: 'ended_at', value: (v) => nul(v as number | undefined) },
};

function originOf(row: Row): Origin | undefined {
  const source = opt<string>(row.source);
  return source ? { source, label: opt<string>(row.source_label) ?? source } : undefined;
}

function toGroup(row: Row): SplitGroup {
  return compact({
    id: String(row.id),
    agentId: String(row.agent_id),
    parentRunId: String(row.parent_run_id),
    conversationId: opt<string>(row.conversation_id),
    taskId: opt<string>(row.task_id),
    origin: originOf(row),
    thread: String(row.thread),
    modeKey: opt<string>(row.mode_key),
    cwd: opt<string>(row.cwd),
    goal: String(row.goal),
    ultra: Number(row.ultra) === 1,
    status: row.status as SplitGroupStatus,
    parts: Number(row.part_count ?? 0),
    createdAt: Number(row.created_at),
    startedAt: optNumber(row.started_at),
    endedAt: optNumber(row.ended_at),
    gatheredAt: optNumber(row.gathered_at),
  });
}

function toSplit(row: Row): Split {
  const after = json<unknown>(row.after, []);
  return compact({
    id: String(row.id),
    groupId: String(row.group_id),
    agentId: String(row.agent_id),
    idx: Number(row.idx),
    of: Number(row.part_count ?? 0),
    title: String(row.title),
    brief: String(row.brief),
    returns: opt<string>(row.returns),
    context: row.context as Split['context'],
    model: opt<string>(row.model),
    effort: opt<Split['effort']>(row.effort),
    after: Array.isArray(after) ? after.map(Number).filter((n) => Number.isInteger(n)) : [],
    worktree: Number(row.worktree) === 1,
    status: row.status as SplitStatus,
    attempts: Number(row.attempts ?? 0),
    error: opt<string>(row.error),
    fork: json<Split['fork']>(row.fork, undefined),
    branch: json<Split['branch']>(row.branch, undefined),
    createdAt: Number(row.created_at),
    startedAt: optNumber(row.started_at),
    endedAt: optNumber(row.ended_at),
  });
}

/** `column IN (?, …)` with its params, or nothing for an empty / absent list. */
function within(column: string, values: readonly string[] | undefined, where: string[], params: SQLInputValue[]): void {
  if (!values) return;
  if (!values.length) { where.push('0'); return; }
  where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

export class SplitRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  /** Insert or replace a group's stored fields (its `parts` is derived, never written). */
  saveGroup(group: SplitGroup): void {
    this.db.run(
      `INSERT INTO split_groups (id, agent_id, parent_run_id, conversation_id, task_id, source, source_label, thread, mode_key, cwd,
         goal, ultra, status, created_at, started_at, ended_at, gathered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, task_id = excluded.task_id,
         source = excluded.source, source_label = excluded.source_label, thread = excluded.thread, mode_key = excluded.mode_key,
         cwd = excluded.cwd, goal = excluded.goal, ultra = excluded.ultra, status = excluded.status,
         started_at = excluded.started_at, ended_at = excluded.ended_at, gathered_at = excluded.gathered_at`,
      [
        group.id, group.agentId, group.parentRunId, nul(group.conversationId), nul(group.taskId), nul(group.origin?.source),
        nul(group.origin?.label), group.thread, nul(group.modeKey), nul(group.cwd), group.goal, group.ultra ? 1 : 0, group.status,
        group.createdAt, nul(group.startedAt), nul(group.endedAt), nul(group.gatheredAt),
      ],
    );
  }

  getGroup(id: string): SplitGroup | undefined {
    const row = this.db.get(`${GROUP_SELECT} WHERE g.id = ?`, [id]);
    return row ? toGroup(row) : undefined;
  }

  listGroups(query: SplitGroupQuery = {}): SplitGroup[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.agentId !== undefined) { where.push('g.agent_id = ?'); params.push(query.agentId); }
    if (query.parentRunId !== undefined) { where.push('g.parent_run_id = ?'); params.push(query.parentRunId); }
    if (query.conversationId !== undefined) { where.push('g.conversation_id = ?'); params.push(query.conversationId); }
    if (query.taskId !== undefined) { where.push('g.task_id = ?'); params.push(query.taskId); }
    if (query.thread !== undefined) { where.push('g.thread = ?'); params.push(query.thread); }
    within('g.status', query.statuses, where, params);
    let sql = `${GROUP_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY g.created_at DESC, g.rowid DESC`;
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(Math.max(1, Math.floor(query.limit))); }
    return this.db.all(sql, params).map(toGroup);
  }

  /** Insert or replace a split's stored fields (its `of` is derived, never written). */
  saveSplit(split: Split): void {
    this.db.run(
      `INSERT INTO splits (id, group_id, agent_id, idx, title, brief, returns, context, model, effort, "after", worktree, fork, branch,
         status, attempts, error, created_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, brief = excluded.brief, returns = excluded.returns,
         context = excluded.context, model = excluded.model, effort = excluded.effort, "after" = excluded."after",
         worktree = excluded.worktree, fork = excluded.fork, branch = excluded.branch, status = excluded.status,
         attempts = excluded.attempts, error = excluded.error, started_at = excluded.started_at, ended_at = excluded.ended_at`,
      [
        split.id, split.groupId, split.agentId, split.idx, split.title, split.brief, nul(split.returns), split.context,
        nul(split.model), nul(split.effort), toJson(split.after ?? []), split.worktree ? 1 : 0, jsonOrNull(split.fork),
        jsonOrNull(split.branch), split.status, split.attempts, nul(split.error), split.createdAt, nul(split.startedAt), nul(split.endedAt),
      ],
    );
  }

  getSplit(id: string): Split | undefined {
    const row = this.db.get(`${SPLIT_SELECT} WHERE s.id = ?`, [id]);
    return row ? toSplit(row) : undefined;
  }

  /** In creation order, a group's splits by idx. */
  listSplits(query: SplitQuery = {}): Split[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.groupId !== undefined) { where.push('s.group_id = ?'); params.push(query.groupId); }
    within('s.group_id', query.groupIds, where, params);
    if (query.agentId !== undefined) { where.push('s.agent_id = ?'); params.push(query.agentId); }
    within('s.status', query.statuses, where, params);
    const sql = `${SPLIT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at, s.group_id, s.idx`;
    return this.db.all(sql, params).map(toSplit);
  }

  /** Changes the named fields (see the header for absent vs undefined); the split after it, or undefined when unknown. */
  updateSplit(id: string, patch: SplitPatch): Split | undefined {
    this.update('splits', id, patch, SPLIT_COLUMNS);
    return this.getSplit(id);
  }

  /** Changes the named fields of a group; the group after it, or undefined when unknown. */
  updateGroup(id: string, patch: SplitGroupPatch): SplitGroup | undefined {
    this.update('split_groups', id, patch, GROUP_COLUMNS);
    return this.getGroup(id);
  }

  private update<P extends object>(table: string, id: string, patch: P, columns: Record<keyof P, { column: string; value: (v: unknown) => SQLInputValue }>): void {
    const keys = (Object.keys(patch) as Array<keyof P>).filter((key) => key in columns);
    if (!keys.length) return;
    const sets = keys.map((key) => `${columns[key].column} = ?`).join(', ');
    this.db.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...keys.map((key) => columns[key].value(patch[key])), id]);
  }
}
