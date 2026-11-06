// What an employee's PC and the CEO's PC say to each other beyond the person's scope (tables.ts `employee`).
// Ids: the CEO's PC speaks to that PC in the person's terms, like the person's phone (people/perspective.ts):
// there 'human' is the person and the CEO is 'owner'; a task of the person has no assignee id there (it is
// "mine"). What comes back is mapped to this PC's ids before anything is checked. A message's secret handles
// (meta.secrets) belong to the owner's vault and are dropped in both directions, as in people/perspective.ts.
// Back: the employee's PC sends only what its person did in what came from that PC – their own lines in those
// chats and their changes of the tasks assigned to them (origin marks, kv ns 'sync.origin'). The CEO's PC takes
// only those rows, checked on its own data like a line from the person's phone (a finished text line of theirs, a
// chat they are in that is not archived, an edit only of their own text line; the task assigned to the person
// here and in the row); anything else is left out quietly, so nothing answers it and nothing repeats.
// B-078 (D20): on a PC that is only the person's seat there (seatAt), their own open to-dos (not "Only me") travel to
// the company too, as tasks assigned to them there,
// and a status change of their task runs the task service's path on the CEO's PC (heldStatus, moveStatus), as from
// their phone: the follow-ups and wakes happen there.
// Owns: the id mapping on this link, the way back and its checks. Never: writes synced rows or sends.

import { HUMAN_ID } from '../../../shared/ids.ts';
import { OWNER_ALIAS } from '../../../shared/model/people.ts';
import type { TaskStatus } from '../../../shared/model/tasks.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import { membership } from '../../people/access.ts';
import { realId, viewId } from '../../people/perspective.ts';
import { KvRepo } from '../../store/kv.ts';
import { DevicesRepo } from '../repo.ts';
import type { Wire } from './tables.ts';

/** A row as it travels (rows.ts Item). */
interface Unit { t: string; id: string; row?: Wire; gone?: true }

const ORIGIN = 'sync.origin';
/** The person's own to-dos that went to their company once (task key → that PC). */
const OWN = 'sync.own';
/** Per employer link: whether this PC is only the person's seat there (seatAt). */
const SEAT = 'sync.seat';
/** Columns that hold a member id, per table. */
const IDS: Readonly<Record<string, readonly string[]>> = {
  conversations: ['created_by'],
  messages: ['author_id'],
  tasks: ['created_by', 'assigned_by'],
};

/** A JSON column with `change` applied; the same text when nothing changed. */
function mapJson(value: unknown, change: (parsed: unknown) => unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const next = change(parsed);
    return JSON.stringify(next) === JSON.stringify(parsed) ? value : JSON.stringify(next);
  } catch { return value; }
}

/** The unit in the person's terms (`toPerson`, on the way to their PC) or back in this PC's terms. */
export function asPerson<T extends Unit>(item: T, personId: string, toPerson: boolean): T {
  if (!item.row) return item;
  const map = (id: unknown) => (typeof id !== 'string' ? id : toPerson ? viewId(personId, id) : realId(personId, id));
  const row: Wire = { ...item.row };
  for (const column of IDS[item.t] ?? []) if (column in row) row[column] = map(row[column]);
  if (item.t === 'conversations') {
    // The owner's read cursor (B-078) is for my own devices only.
    if (Array.isArray(row.members)) row.members = (row.members as Wire[]).map(({ read_id: _read, ...member }) => ({ ...member, member_id: map(member.member_id) }));
    row.settings = mapJson(row.settings, (settings) => {
      const pair = (settings as { directPair?: unknown } | null)?.directPair;
      return Array.isArray(pair) ? { ...(settings as object), directPair: pair.map(map) } : settings;
    });
  }
  if (item.t === 'messages') {
    row.mentions = mapJson(row.mentions, (list) => (Array.isArray(list) ? list.map(map) : list));
    row.meta = mapJson(row.meta, (meta) => {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
      const { secrets: _secrets, ...rest } = meta as Record<string, unknown>;
      return rest;
    });
  }
  if (item.t === 'tasks') {
    // A human task without an id is the owner's: on the person's PC the person's own, here the CEO's.
    if (row.assignee_kind === 'human') {
      const id = row.assignee_id ?? null;
      row.assignee_id = toPerson ? (id === personId ? null : id === null || id === HUMAN_ID ? OWNER_ALIAS : id)
        : id === null || id === HUMAN_ID ? personId : id === OWNER_ALIAS ? null : id;
    }
    row.waiting_on = mapJson(row.waiting_on, (waiting) => {
      const on = waiting as { id?: unknown } | null;
      return on && typeof on.id === 'string' ? { ...on, id: map(on.id) } : waiting;
    });
  }
  return { ...item, row };
}

/** On an employee's PC: a chat or task that came from `peer` (marked when it arrives, unmarked when it goes). */
export function markOrigin(db: Db, item: Unit, peer: string, now: number): void {
  if (item.t !== 'conversations' && item.t !== 'tasks') return;
  const kv = new KvRepo(db);
  const key = `${item.t}/${item.id}`;
  if (item.gone) kv.delete(ORIGIN, key);
  else if (kv.get<string>(ORIGIN, key) !== peer) kv.set(ORIGIN, key, peer, now);
}

const cameFrom = (db: Db, key: string) => new KvRepo(db).get<string>(ORIGIN, key);

/** A to-do of the person's own on their PC that their company sees too: open and not "Only me". */
const ownOpen = (row: Wire) => !Number(row.private ?? 0) && !['done', 'cancelled'].includes(String(row.status));

/**
 * Whether this PC's company is only the person's seat at `peer` (started for it, "+" › Join a company as employee): no
 * agent and no task here is older than that link. A company that held the person's own life or business before it
 * joined keeps its own to-dos to itself. Decided once per link (kv ns 'sync.seat').
 */
export function seatAt(db: Db, peer: string, now = Date.now()): boolean {
  const kv = new KvRepo(db);
  const known = kv.get<boolean>(SEAT, peer);
  if (typeof known === 'boolean') return known;
  const pairedAt = new DevicesRepo(db).get(peer)?.pairedAt;
  if (!pairedAt) return false;
  const older = db.get(`SELECT 1 AS hit FROM agents WHERE created_at < ? UNION ALL SELECT 1 AS hit FROM tasks WHERE created_at < ? LIMIT 1`, [pairedAt, pairedAt]);
  const seat = older === undefined;
  kv.set(SEAT, peer, seat, now);
  return seat;
}

/** On an employee's seat PC: the person's own open to-dos (assigned to them, not "Only me"), for the first link-up. */
export function ownTodos(db: Db, peer: string): string[] {
  if (!seatAt(db, peer)) return [];
  return db.all<{ id: string }>("SELECT id FROM tasks WHERE assignee_kind = 'human' AND assignee_id IS NULL AND private = 0 AND status NOT IN ('done', 'cancelled')").map((row) => String(row.id));
}

/**
 * On an employee's PC: whether a changed row goes back to `peer` – this person's own line in a chat from there, their
 * change of a task from there that is theirs, or (D20, seat PCs only) a to-do of their own, open and not "Only me": once
 * it went there, its later changes (done) follow it.
 */
export function goesBack(item: Unit, peer: string, db: Db, now = Date.now()): boolean {
  const row = item.row;
  if (!row || item.gone) return false;
  if (item.t === 'messages') {
    const chat = String(row.conversation_id);
    return row.author_kind === 'human' && row.author_id === HUMAN_ID && cameFrom(db, `conversations/${chat}`) === peer && Boolean(membership(db, HUMAN_ID, chat));
  }
  if (item.t !== 'tasks' || row.assignee_kind !== 'human' || (row.assignee_id ?? null) !== null) return false;
  const origin = cameFrom(db, `tasks/${item.id}`);
  if (origin) return origin === peer;
  // Their own to-do (only from a seat PC): open, or done after it went there once; "Only me" keeps it here from then on.
  if (!seatAt(db, peer, now)) return false;
  const kv = new KvRepo(db);
  const sent = kv.get<string>(OWN, `tasks/${item.id}`);
  if (Number(row.private ?? 0) || (sent !== peer && !ownOpen(row))) return false;
  if (sent !== peer) kv.set(OWN, `tasks/${item.id}`, peer, now);
  return true;
}

/** A person's task status that changed on their PC: written through the task service here (moveStatus), not as a row. */
export interface StatusMove { id: string; status: string; result?: unknown }

/** On the CEO's PC: the task statuses that reached each person's PC (task status by `<peer>/<task id>`). */
const SENT = 'sync.sent';

/** On the CEO's PC: rows that reached the PC of a person (`peer`): the status of each task is remembered. */
export function noteSent(db: Db, peer: string, items: readonly Unit[], now: number): void {
  const kv = new KvRepo(db);
  for (const item of items) {
    if (item.t !== 'tasks' || !item.row) continue;
    const key = `${peer}/${item.id}`;
    if (kv.get<string>(SENT, key) !== String(item.row.status)) kv.set(SENT, key, String(item.row.status), now);
  }
}

/**
 * On the CEO's PC: a person's task row from `peer` keeps the status here. Only a status the person set – one that
 * differs from the last status that reached their PC (without a record: from the one here) – goes to `moves`; a row
 * that carries an old status (an offline edit of the title) changes no status.
 */
export function heldStatus<T extends Unit>(db: Db, item: T, moves: StatusMove[], peer: string): T {
  if (item.t !== 'tasks' || !item.row) return item;
  const here = db.get<Wire>('SELECT status, completed_at, result, waiting_on FROM tasks WHERE id = ?', [item.id]);
  if (!here || here.status === item.row.status) return item;
  const sent = new KvRepo(db).get<string>(SENT, `${peer}/${item.id}`);
  if (String(item.row.status) !== (sent ?? String(here.status))) {
    let result: unknown;
    try { result = typeof item.row.result === 'string' ? JSON.parse(item.row.result) : undefined; } catch { result = undefined; }
    moves.push({ id: item.id, status: String(item.row.status), result });
  }
  return { ...item, row: { ...item.row, status: here.status, completed_at: here.completed_at, result: here.result, waiting_on: here.waiting_on } };
}

/** Runs a held status change as the person (their phone's path: the follow-ups, the creator's wake). */
export function moveStatus(s: Pick<RuntimeServices, 'tasks' | 'log'>, move: StatusMove, personId: string): void {
  try {
    if (move.status === 'done') {
      const summary = (move.result as { summary?: unknown } | undefined)?.summary;
      s.tasks.complete(move.id, { summary: typeof summary === 'string' && summary.trim() ? summary : 'Done', evidence: [], verification: 'reported_by_human' }, personId);
    } else {
      s.tasks.setStatus(move.id, move.status as TaskStatus, personId);
    }
  } catch (error) {
    s.log.warn('synced task status not applied', { taskId: move.id, error: String((error as Error)?.message ?? error) });
  }
}

/** On the CEO's PC: whether a row from the PC of `personId` (already in this PC's ids) is that person's to change. */
export function takenFrom(item: Unit, personId: string, db: Db): boolean {
  const row = item.row;
  if (!row || item.gone) return false;
  if (item.t === 'messages') {
    const chat = String(row.conversation_id);
    const here = db.get<{ author_id: string; conversation_id: string; kind: string }>('SELECT author_id, conversation_id, kind FROM messages WHERE id = ?', [item.id]);
    return row.author_kind === 'human' && row.author_id === personId && row.kind === 'text' && row.state === 'final'
      && Boolean(membership(db, personId, chat)) && !db.get('SELECT 1 FROM conversations WHERE id = ? AND archived_at IS NOT NULL', [chat])
      && (!here || (here.author_id === personId && here.conversation_id === chat && here.kind === 'text'));
  }
  // A task stays theirs on both sides; an update never moves its chat, parent or maker (TaskRepo.save). A new one is a
  // to-do of their own, open and not "Only me" (D20) – whoever made it on their PC (mostly an agent there, theirMaker).
  const theirs = (task: Wire | undefined) => task?.assignee_kind === 'human' && task.assignee_id === personId;
  if (item.t !== 'tasks' || !theirs(row)) return false;
  const here = db.get<Wire>('SELECT assignee_kind, assignee_id FROM tasks WHERE id = ?', [item.id]);
  return here ? theirs(here) : ownOpen(row);
}

/**
 * On the CEO's PC: a new to-do from the person's PC whose maker this PC does not know (an agent of their PC) is theirs
 * here – the person stands in as its maker, so its follow-ups and wakes reach someone who is here.
 */
export function theirMaker<T extends Unit>(db: Db, item: T, personId: string): T {
  if (item.t !== 'tasks' || !item.row || db.get('SELECT 1 FROM tasks WHERE id = ?', [item.id])) return item;
  const known = (id: string) => id === HUMAN_ID || id === personId || Boolean(db.get('SELECT 1 FROM agents WHERE id = ?', [id]) ?? db.get('SELECT 1 FROM people WHERE id = ?', [id]));
  const row: Wire = { ...item.row };
  for (const column of ['created_by', 'assigned_by']) if (typeof row[column] === 'string' && !known(row[column] as string)) row[column] = personId;
  return { ...item, row };
}
