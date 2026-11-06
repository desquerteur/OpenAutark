// Durable agent wake queue (table `wakes`). Event wakes are due now; retries/backoff later.
// Coalescing: wakes for the same agent with the same coalesce key merge into ONE unclaimed
// row (earliest due time wins, notes are joined, the stronger reason is kept). The key is
// encoded in the row id (`wk_c<hash>`) so no extra column is needed; claiming renames the row
// to a unique id (`wk_c<hash>.<unique>`), which frees the key for the next wake while the
// claimed one runs – and lets release()/reconcile() put it back under its own key.
// Report wakes (T08, org/reports.ts): two 'report' wakes merge line by line – each line once, the
// first line (the instruction) stays first, the oldest result lines go first past the size cap –
// so one manager turn reports a bundle of results; the earliest due time wins as for every merge.
// Provisional wakes (C3, chat/delivery.ts): cancelKey() withdraws the one unclaimed row under a
// coalesce key (a claimed one keeps running) – the lead's fallback wake once a decision is made.
// Origin (B-054, shared/model/origin.ts): stored in source/source_label (migration 082). On a merge the older
// origin wins, like the chat and the task. A wake with neither chat nor task keys by its source too, so a
// mail, task news and a review never merge into one row.
// Owns: SQL for `wakes`, the claim/done cycle and change notifications.
// Never: runs agents or timers (the dispatcher claims; the scheduler arms the single timer).

import { newId } from '../../shared/ids.ts';
import type { Db } from '../db/database.ts';
import type { Clock, Wake, WakeQueue, WakeRequest } from '../contracts.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import { cleanOrigin, type Origin } from '../../shared/model/origin.ts';

type Row = Record<string, unknown>;

/** Higher wins when two wakes merge. */
const STRENGTH: Record<WakeReason, number> = {
  answer: 9, message: 8, approval: 7, task: 6, event: 6, child: 5, handoff: 4, schedule: 3, review: 2, report: 2, retry: 1, manual: 0, setup: 0,
  split: 0, // B-057: a split's run – never a queued wake
};

const MAX_NOTE = 4000;
const CLAIMED = '.'; // claimed id = `<coalesce id>.<unique>`

function toWake(row: Row): Wake {
  const wake: Wake = {
    id: String(row.id), agentId: String(row.agent_id), reason: String(row.reason) as WakeReason,
    dueAt: Number(row.due_at), createdAt: Number(row.created_at), attempts: Number(row.attempts),
  };
  if (row.conversation_id !== null) wake.conversationId = String(row.conversation_id);
  if (row.task_id !== null) wake.taskId = String(row.task_id);
  if (row.note !== null) wake.note = String(row.note);
  if (row.claimed_at !== null) wake.claimedAt = Number(row.claimed_at);
  const origin = originOf(row);
  if (origin) wake.origin = origin;
  return wake;
}

/** The stored origin of a wakes row (source_label falls back to the source). */
function originOf(row: Row): Origin | undefined {
  if (row.source === null || row.source === undefined) return undefined;
  return { source: String(row.source), label: row.source_label === null || row.source_label === undefined ? String(row.source) : String(row.source_label) };
}

/** Small stable hash (FNV-1a 64 → base36) for coalesce ids. */
function hashKey(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36).padStart(13, '0');
}

/** Row id of the unclaimed wake under a coalesce key (a claimed row appends `.<unique>`). */
function coalesceId(agentId: string, key: string): string {
  return `wk_c${hashKey(`${agentId}\u0000${key}`)}`;
}

/** B-059: the row id a claimed wake has again once released – its coalesce id (an unclaimed id is its own). */
export function releasedId(id: string): string {
  const cut = id.indexOf(CLAIMED);
  return cut > 0 ? id.slice(0, cut) : id;
}

export class WakeQueueImpl implements WakeQueue {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly listeners = new Set<(change: { agentId: string; dueAt?: number }) => void>();

  constructor(deps: { db: Db; clock: Clock }) {
    this.db = deps.db;
    this.clock = deps.clock;
  }

  wake(request: WakeRequest): void {
    const now = this.clock.now();
    const dueAt = request.dueAt ?? now;
    const origin = cleanOrigin(request.origin);
    // Default key: identical wakes (same reason/chat/task) are redundant and merge; with neither chat nor task the
    // source keys them too (B-054), so two sources never fold into one row.
    const own = request.conversationId || request.taskId || !origin ? '' : `:${origin.source}`;
    const key = request.coalesceKey ?? `${request.reason}:${request.conversationId ?? ''}:${request.taskId ?? ''}${own}`;
    const id = coalesceId(request.agentId, key);
    this.upsert(id, {
      agentId: request.agentId, reason: request.reason, conversationId: request.conversationId, taskId: request.taskId,
      note: request.note, dueAt, createdAt: now, attempts: 0, origin,
    });
    this.changed(request.agentId, dueAt);
  }

  cancel(agentId: string, filter: { taskId?: string; conversationId?: string } = {}): void {
    const where = ['agent_id = ?', 'claimed_at IS NULL'];
    const params: string[] = [agentId];
    if (filter.taskId) { where.push('task_id = ?'); params.push(filter.taskId); }
    if (filter.conversationId) { where.push('conversation_id = ?'); params.push(filter.conversationId); }
    if (this.db.run(`DELETE FROM wakes WHERE ${where.join(' AND ')}`, params).changes) this.changed(agentId);
  }

  /** Withdraws the unclaimed wake of `agentId` under `coalesceKey`; false when none waits (claimed or gone). */
  cancelKey(agentId: string, coalesceKey: string): boolean {
    const removed = this.db.run('DELETE FROM wakes WHERE id = ? AND claimed_at IS NULL', [coalesceId(agentId, coalesceKey)]).changes > 0;
    if (removed) this.changed(agentId);
    return removed;
  }

  /** Cancels unclaimed wakes of any agent for a task (task finished/removed). */
  cancelTask(taskId: string, reasons?: WakeReason[]): void {
    const rows = this.db.all<Row>(
      `SELECT id, agent_id FROM wakes WHERE task_id = ? AND claimed_at IS NULL ${reasons ? `AND reason IN (${reasons.map(() => '?').join(',')})` : ''}`,
      [taskId, ...(reasons ?? [])],
    );
    for (const row of rows) this.db.run('DELETE FROM wakes WHERE id = ?', [String(row.id)]);
    for (const agent of new Set(rows.map(row => String(row.agent_id)))) this.changed(agent);
  }

  pending(agentId?: string): number {
    const row = agentId
      ? this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wakes WHERE agent_id = ? AND claimed_at IS NULL', [agentId])
      : this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wakes WHERE claimed_at IS NULL');
    return Number(row?.n ?? 0);
  }

  list(agentId: string): Wake[] {
    return this.db.all<Row>('SELECT * FROM wakes WHERE agent_id = ? ORDER BY due_at, created_at', [agentId]).map(toWake);
  }

  claim(agentId: string, now = this.clock.now()): Wake[] {
    return this.db.tx(() => {
      const rows = this.db.all<Row>(
        'SELECT * FROM wakes WHERE agent_id = ? AND claimed_at IS NULL AND due_at <= ? ORDER BY due_at, created_at',
        [agentId, now],
      );
      const claimed: Wake[] = [];
      for (const row of rows) {
        const wake = toWake(row);
        const id = `${wake.id}${CLAIMED}${newId('wk', now).slice(3)}`;
        const changes = this.db.run(
          'UPDATE wakes SET id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND claimed_at IS NULL',
          [id, now, wake.id],
        ).changes;
        if (changes) claimed.push({ ...wake, id, claimedAt: now, attempts: wake.attempts + 1 });
      }
      return claimed;
    });
  }

  done(ids: string[]): void {
    for (const id of ids) this.db.run('DELETE FROM wakes WHERE id = ?', [id]);
  }

  release(ids: string[], dueAt?: number, notRun = false): void {
    const agents = new Set<string>();
    for (const id of ids) {
      const row = this.db.get<Row>('SELECT * FROM wakes WHERE id = ?', [id]);
      if (!row) continue;
      const wake = toWake(row);
      this.db.run('DELETE FROM wakes WHERE id = ?', [id]);
      // Back under its own key, merged with anything that arrived meanwhile. A wake that was claimed but not run (the
      // dispatcher picked another group) does not spend an attempt (B-054 P9 retry budget).
      this.requeue(notRun ? { ...wake, attempts: Math.max(0, wake.attempts - 1) } : wake, dueAt ?? wake.dueAt);
      agents.add(wake.agentId);
    }
    for (const agent of agents) this.changed(agent, dueAt);
  }

  dueAgents(now = this.clock.now()): string[] {
    return this.db
      .all<{ agent_id: string }>('SELECT DISTINCT agent_id FROM wakes WHERE claimed_at IS NULL AND due_at <= ? ORDER BY agent_id', [now])
      .map(row => String(row.agent_id));
  }

  /** Agents whose unclaimed wakes became due in (from, to]. */
  dueBetween(from: number, to: number): string[] {
    return this.db
      .all<{ agent_id: string }>('SELECT DISTINCT agent_id FROM wakes WHERE claimed_at IS NULL AND due_at > ? AND due_at <= ?', [from, to])
      .map(row => String(row.agent_id));
  }

  nextDueAfter(after: number): number | undefined {
    const row = this.db.get<{ t: number | null }>('SELECT MIN(due_at) AS t FROM wakes WHERE claimed_at IS NULL AND due_at > ?', [after]);
    return row?.t === null || row?.t === undefined ? undefined : Number(row.t);
  }

  reconcile(): number {
    const rows = this.db.all<Row>('SELECT * FROM wakes WHERE claimed_at IS NOT NULL');
    for (const row of rows) {
      const wake = toWake(row);
      this.db.run('DELETE FROM wakes WHERE id = ?', [wake.id]);
      this.requeue(wake, Math.min(wake.dueAt, this.clock.now()));
    }
    return rows.length;
  }

  onChange(listener: (change: { agentId: string; dueAt?: number }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Inserts a wake under `id`, or merges it into the unclaimed row already there. `released`:
   * the wake was claimed before the row there arrived, so its note comes first.
   */
  private upsert(id: string, wake: Omit<Wake, 'id' | 'claimedAt'>, released = false): void {
    const existing = this.db.get<Row>('SELECT * FROM wakes WHERE id = ?', [id]);
    if (!existing) {
      this.db.run(
        `INSERT INTO wakes (id, agent_id, conversation_id, task_id, reason, note, due_at, created_at, attempts, source, source_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, wake.agentId, wake.conversationId ?? null, wake.taskId ?? null, wake.reason, wake.note ?? null, wake.dueAt, wake.createdAt, wake.attempts,
          wake.origin?.source ?? null, wake.origin?.label ?? null],
      );
      return;
    }
    const old = toWake(existing);
    const reason = STRENGTH[wake.reason] > STRENGTH[old.reason] ? wake.reason : old.reason;
    const join = wake.reason === 'report' && old.reason === 'report' ? joinLines : joinNotes;
    const note = released ? join(wake.note, old.note) : join(old.note, wake.note);
    const origin = old.origin ?? wake.origin; // the older origin wins, like the chat and the task
    this.db.run(
      `UPDATE wakes SET reason = ?, note = ?, due_at = ?, conversation_id = ?, task_id = ?, created_at = ?, attempts = ?, source = ?, source_label = ?
       WHERE id = ?`,
      [reason, note ?? null, Math.min(old.dueAt, wake.dueAt), old.conversationId ?? wake.conversationId ?? null, old.taskId ?? wake.taskId ?? null,
        Math.min(old.createdAt, wake.createdAt), Math.max(old.attempts, wake.attempts), origin?.source ?? null, origin?.label ?? null, id],
    );
  }

  /** Un-claims a wake: back under its coalesce key (kept as the claimed id's prefix). */
  private requeue(wake: Wake, dueAt: number): void {
    const cut = wake.id.indexOf(CLAIMED);
    const home = wake.claimedAt === undefined ? wake.id : cut > 0 ? wake.id.slice(0, cut) : undefined;
    if (!home) { this.wakeSilently(wake, dueAt); return; } // claimed by an older build: default key
    this.upsert(home, {
      agentId: wake.agentId, reason: wake.reason, conversationId: wake.conversationId, taskId: wake.taskId, note: wake.note,
      dueAt, createdAt: wake.createdAt, attempts: wake.attempts, origin: wake.origin,
    }, true);
  }

  private wakeSilently(wake: Wake, dueAt: number): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    try {
      this.wake({ agentId: wake.agentId, reason: wake.reason, conversationId: wake.conversationId, taskId: wake.taskId, note: wake.note, dueAt, origin: wake.origin });
    } finally {
      for (const listener of listeners) this.listeners.add(listener);
    }
  }

  private changed(agentId: string, dueAt?: number): void {
    for (const listener of this.listeners) {
      try { listener({ agentId, dueAt }); } catch { /* listeners must not break writers */ }
    }
  }
}

/** Report notes: `a`'s lines, then `b`'s new ones; past the cap the oldest lines after the first go. */
function joinLines(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const lines = a.split('\n');
  for (const line of b.split('\n')) if (!lines.includes(line)) lines.push(line);
  while (lines.length > 2 && lines.join('\n').length > MAX_NOTE) lines.splice(1, 1);
  const joined = lines.join('\n');
  return joined.length > MAX_NOTE ? joined.slice(0, MAX_NOTE) : joined;
}

function joinNotes(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b || a.split('\n\n').includes(b)) return a;
  const joined = `${a}\n\n${b}`;
  return joined.length > MAX_NOTE ? joined.slice(joined.length - MAX_NOTE) : joined;
}
