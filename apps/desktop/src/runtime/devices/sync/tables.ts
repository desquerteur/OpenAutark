// The tables linked PCs share, row by row (rows.ts moves them): stored files' metadata (their bytes: blobs.ts),
// spaces, people, chats with their members, agents, tasks, schedules, accounts (metadata; a plan's login: logins.ts),
// messages (a streaming answer too, with its live values), the chats' shared notes and the knowledge rows (chat
// observations, old versions of memory files; no embeddings) – in this order, so what a row points at arrives before
// it. Per table: its key (`key`, default id), what never leaves this PC (`skip`: per-PC counters, cursors, live
// state), what travels but is no change on its own (`soft`: updated_at), the row as it
// leaves (`view`), how an incoming one is written – through the repositories that keep the full-text indexes
// (messages, tasks) or as an upsert of its columns – and the service event that follows. Which rows an employee's
// PC gets: the chats its person is or was in (so a removal arrives), their messages the person may read, the tasks
// the person may read (people/access.ts – so a reassignment in their chats arrives; what comes back: employee.ts).
// A schedule's due time is set only on the PC that fires it
// (placeSchedules). Not synced (per PC): devices, tokens, push subscriptions, runs, wakes, context items, engine
// sessions, kv, vectors, drafts, splits, spend, bridges, the model catalog (each PC lists what its accounts run) – the
// devices, phone tokens and push subscriptions of my own PCs travel in the roster (roster.ts). The owner's read cursor
// travels with the chat's members as the last read message's id (B-078; a person's stays per PC). Not yet: calendar rows (the calendar service keeps its task blocks in memory),
// the media library. Secrets travel encrypted (secrets.ts), files and settings in files.ts.
// Owns: these rules. Never: decides who wins (stamps.ts) or sends anything (rows.ts).

import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { RuntimeServices } from '../../contracts.ts';
import type { ConversationSettings } from '../../../shared/model/chat.ts';
import type { NotesUpdated } from '../../../shared/model/notes.ts';
import { json, type Db, type Row } from '../../db/database.ts';
import { mayReadMessage, mayReadTask } from '../../people/access.ts';
import { ConversationRepo } from '../../chat/conversation-repo.ts';
import { MessageRepo, toMessage } from '../../chat/message-repo.ts';
import { TaskRepo, toTask } from '../../tasks/repo.ts';
import { SpaceRepo } from '../../store/spaces.ts';
import { ScheduleRepo } from '../../schedules/repo.ts';
import { deleteRows, getRow, toItem } from '../../knowledge/rows.ts';
import { ownHomes } from '../../accounts/cli-homes.ts';
import type { ProviderId } from '../../../shared/model/providers.ts';
import { KvRepo } from '../../store/kv.ts';
import { firesHere } from './home.ts';
import '../../contracts/people.ts';

/** A row as it travels: column → JSON value. */
export type Wire = Record<string, unknown>;

/** How a batch is written: `first` – the first link-up's history (it counts as read). */
export interface Apply { s: RuntimeServices; first: boolean }

export interface Table {
  name: string;
  /** The row's key column (default 'id'); the unit's id is its value. */
  key?: string;
  skip?: readonly string[];
  soft?: readonly string[];
  /** The row as it leaves this PC; undefined: this row stays here. */
  view?(row: Wire, self: string, s: RuntimeServices): Wire | undefined;
  /** Writes an incoming row; true when a reference it named is not here yet (it was left out). */
  write?(row: Wire, ctx: Apply, existed: boolean): boolean | void;
  /** Removes a row the other PC removed (with its event). */
  drop(id: string, ctx: Apply): void;
  /** The service event after a write. */
  emit(id: string, ctx: Apply, existed: boolean): void;
  /** Before a local row leaves: this PC's own fix-up (a schedule that fires elsewhere). */
  settle?(id: string, s: RuntimeServices): void;
  /** Whether an employee's PC gets the row (absent: never). */
  employee?(row: Wire, personId: string, db: Db): boolean;
  /**
   * A part that merges on its own and is never a row edit (the owner's read cursor): `strip` leaves it out of what is
   * compared and stamped, `part` is what of it travels, `take` merges it from every incoming row, winning or not
   * (true when something moved here).
   */
  merged?: { strip(row: Wire): Wire; part(row: Wire): unknown; take(row: Wire, ctx: Apply): boolean };
}

const columns = new WeakMap<Db, Map<string, Set<string>>>();

function columnsOf(db: Db, table: string): Set<string> {
  let tables = columns.get(db);
  if (!tables) columns.set(db, (tables = new Map()));
  let known = tables.get(table);
  if (!known) tables.set(table, (known = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name))));
  return known;
}

export const sqlValue = (value: unknown): SQLInputValue =>
  value === undefined || value === null ? null : typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint' ? value : JSON.stringify(value);

/** Inserts or updates the columns of `row` this table has (a newer PC's extra columns are left out). */
export function upsert(db: Db, table: string, row: Wire, key: readonly string[] = ['id']): void {
  const known = columnsOf(db, table);
  const cols = Object.keys(row).filter((column) => known.has(column));
  const set = cols.filter((column) => !key.includes(column)).map((column) => `"${column}" = excluded."${column}"`);
  db.run(
    `INSERT INTO ${table} (${cols.map((column) => `"${column}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(${key.join(', ')}) ${set.length ? `DO UPDATE SET ${set.join(', ')}` : 'DO NOTHING'}`,
    cols.map((column) => sqlValue(row[column])),
  );
}

/** The row as it leaves this PC (undefined: missing, or it stays here). */
export function readRow(s: RuntimeServices, table: Table, id: string, self: string): Wire | undefined {
  const raw = s.db.get<Row>(`SELECT * FROM ${table.name} WHERE ${table.key ?? 'id'} = ?`, [id]);
  if (!raw) return undefined;
  const row: Wire = { ...raw };
  for (const column of table.skip ?? []) delete row[column];
  return table.view ? table.view(row, self, s) : row;
}

/** What is compared of a row: everything but its soft columns. */
export function compared(table: Table, row: Wire): Wire {
  const out = table.merged ? table.merged.strip(row) : { ...row };
  for (const column of table.soft ?? []) delete out[column];
  return out;
}

const exists = (db: Db, table: string, id: unknown) => typeof id === 'string' && Boolean(db.get(`SELECT 1 FROM ${table} WHERE id = ?`, [id]));

/** Read cursors that named a message not here yet: `<chat>/<member>` → that message's id. */
const READ_WAITS = 'sync.read';

/** A message just arrived: the read cursors that waited for it move onto it. */
function readWaits(s: RuntimeServices, chat: string, messageId: string): void {
  const kv = new KvRepo(s.db);
  for (const { key } of s.db.all<{ key: string }>('SELECT key FROM kv WHERE ns = ? AND substr(key, 1, ?) = ? AND value = ?', [READ_WAITS, chat.length + 1, `${chat}/`, JSON.stringify(messageId)])) {
    void new ConversationRepo(s.db).takeRead(chat, key.slice(chat.length + 1), messageId);
    kv.delete(READ_WAITS, key);
  }
}

// A stored file's metadata (id = the bytes' sha256, so a row never changes its content); its use count and text
// cache are this PC's. Its bytes come when first needed (blobs.ts); each PC clears its own unused files.
const files: Table = {
  name: 'files', skip: ['refs', 'text_preview'],
  drop: () => {},
  emit: () => {},
};

const spaces: Table = {
  name: 'spaces',
  drop: () => {}, // spaces are archived, never deleted
  emit: (id, { s }) => { const space = new SpaceRepo(s.db).get(id); if (space) s.bus.emit('space.upserted', space); },
};

const people: Table = {
  name: 'people', soft: ['updated_at'],
  drop: () => {}, // people are revoked, never deleted
  emit: (id, { s }) => { const person = s.people?.get(id); if (person) s.bus.emit('person.upserted', person); },
};

const conversations: Table = {
  name: 'conversations', skip: ['last_message_at', 'last_seq'], soft: ['updated_at'],
  // B-078: the owner's read cursor travels as `read_id` (the last message read; seqs are per PC), so a read on one of my
  // devices clears the badge on all; one naming a message not here yet waits for it (messages.write, kv ns 'sync.read').
  // It is no edit of the chat: outside the compared row, merged by the furthest from every row that comes (`merged`).
  view: (row, _self, s) => ({ ...row, members: new ConversationRepo(s.db).syncMembers(String(row.id)) }),
  merged: {
    strip: (row) => (Array.isArray(row.members) ? { ...row, members: (row.members as Wire[]).map(({ read_id: _read, ...member }) => member) } : { ...row }),
    part: (row) => (Array.isArray(row.members) ? (row.members as Wire[]) : []).flatMap((member) => (typeof member.read_id === 'string' ? [[member.member_id, member.read_id]] : [])),
    take: (row, { s }) => {
      const convs = new ConversationRepo(s.db);
      let moved = false;
      for (const member of Array.isArray(row.members) ? (row.members as Wire[]) : []) {
        if (typeof member.read_id !== 'string' || typeof member.member_id !== 'string') continue;
        const taken = convs.takeRead(String(row.id), member.member_id, member.read_id);
        if (taken === 'missing') new KvRepo(s.db).set(READ_WAITS, `${row.id}/${member.member_id}`, member.read_id, s.clock.now());
        moved ||= taken === 'moved';
      }
      return moved;
    },
  },
  write: (row, { s }) => {
    const { members, ...conversation } = row;
    upsert(s.db, 'conversations', conversation);
    // A member that joins here has read what is here (its cursor is this PC's seq, never the other PC's); a read_id is
    // taken after the write (`merged.take`, rows.ts).
    for (const member of Array.isArray(members) ? (members as Wire[]) : []) {
      s.db.run(
        `INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at, left_at)
         VALUES (?, ?, ?, ?, (SELECT last_seq FROM conversations WHERE id = ?), ?, ?)
         ON CONFLICT(conversation_id, member_id) DO UPDATE SET kind = excluded.kind, role = excluded.role, joined_at = excluded.joined_at, left_at = excluded.left_at`,
        [sqlValue(row.id), sqlValue(member.member_id), sqlValue(member.kind), sqlValue(member.role), sqlValue(row.id), sqlValue(member.joined_at), sqlValue(member.left_at)],
      );
    }
  },
  drop: (id, { s }) => s.chats.remove(id),
  emit: (id, { s }) => { if (s.chats.get(id)) s.bus.emit('conversation.upserted', s.chats.summary(id)); },
  employee: (row, personId) => Array.isArray(row.members) && (row.members as Wire[]).some((member) => member.member_id === personId),
};

const agents: Table = {
  name: 'agents', skip: ['status_note'], soft: ['updated_at'],
  // A home-less agent lives on this PC; of its live status only a pause travels.
  view: (row, self) => ({ ...row, device_id: row.device_id ?? self, status: row.status === 'paused' ? 'paused' : 'idle' }),
  write: (row, { s }, existed) => {
    const local = existed ? s.db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', [sqlValue(row.id)])?.status : undefined;
    const status = row.status === 'paused' ? 'paused' : local && local !== 'paused' ? local : 'idle';
    const manager = row.manager_id && !exists(s.db, 'agents', row.manager_id);
    const space = row.space_id && !exists(s.db, 'spaces', row.space_id);
    upsert(s.db, 'agents', { ...row, status, ...(manager ? { manager_id: null } : {}), ...(space ? { space_id: null } : {}) });
    return Boolean(manager || space);
  },
  drop: () => {}, // agents are archived, never deleted
  emit: (id, { s }) => { const agent = s.org.get(id); if (agent) s.bus.emit('agent.upserted', agent); },
};

const tasks: Table = {
  name: 'tasks', skip: ['client_id'], soft: ['updated_at'],
  write: (row, { s }) => {
    const repo = new TaskRepo(s.db);
    const chat = row.conversation_id && !exists(s.db, 'conversations', row.conversation_id);
    const parent = row.parent_id && !exists(s.db, 'tasks', row.parent_id);
    const task = toTask({ ...row, ...(chat ? { conversation_id: null } : {}), ...(parent ? { parent_id: null } : {}) });
    const current = repo.get(task.id);
    if (current) repo.save(task, current.rev); else repo.insert(task);
    return Boolean(chat || parent);
  },
  drop: (id, { s }) => {
    const repo = new TaskRepo(s.db);
    const task = repo.get(id);
    repo.delete(id);
    s.bus.emit('task.removed', { id, ...(task?.conversationId ? { conversationId: task.conversationId } : {}) });
  },
  emit: (id, { s }) => { const view = s.tasks.get(id); if (view) s.bus.emit('task.upserted', view); },
  employee: (row, personId, db) => mayReadTask(db, personId, toTask(row)),
};

/**
 * Puts the due time of each active schedule (of `ownerId`, else all) where it fires (home.ts firesHere): armed on that
 * PC, none on every other – after a schedule arrives or leaves, an agent's home moves or a PC is linked or removed.
 */
export function placeSchedules(s: RuntimeServices, ownerId?: string): void {
  const rows = s.db.all<{ id: string; owner_id: string; spec: string; next_at: number | null }>(
    `SELECT id, owner_id, spec, next_at FROM schedules WHERE active = 1${ownerId ? ' AND owner_id = ?' : ''}`, ownerId ? [ownerId] : []);
  let moved = false;
  for (const row of rows) {
    const here = firesHere(s, String(row.owner_id));
    if (here === (row.next_at !== null)) continue;
    let next: number | null = null;
    try { next = here ? s.scheduler.next(JSON.parse(String(row.spec)), s.clock.now()) ?? null : null; } catch { continue; } // a spec that no longer computes stays as it is
    if (next === row.next_at) continue;
    s.db.run('UPDATE schedules SET next_at = ? WHERE id = ?', [next, row.id]);
    moved = true;
  }
  if (moved) s.scheduler.arm();
}

const schedules: Table = {
  name: 'schedules', skip: ['next_at', 'last_at', 'runs', 'lease'],
  // One PC fires a schedule; every other PC keeps its copy without a due time (placeSchedules).
  write: (row, { s }, existed) => {
    const spec = existed ? s.db.get<{ spec: string }>('SELECT spec FROM schedules WHERE id = ?', [sqlValue(row.id)])?.spec : undefined;
    upsert(s.db, 'schedules', row);
    if (!row.active || spec !== row.spec) s.db.run('UPDATE schedules SET next_at = NULL WHERE id = ?', [sqlValue(row.id)]);
    placeSchedules(s, String(row.owner_id));
  },
  settle: (id, s) => {
    const owner = s.db.get<{ owner_id: string }>('SELECT owner_id FROM schedules WHERE id = ?', [id])?.owner_id;
    if (owner) placeSchedules(s, owner);
  },
  drop: (id, { s }) => s.scheduler.remove(id),
  emit: (id, { s }) => { const schedule = new ScheduleRepo(s.db).get(id); if (schedule) s.bus.emit('schedule.upserted', schedule); s.scheduler.arm(); },
};

/** A CLI plan here that is the login `row` names: same provider and e-mail – any, for a CLI with one sign-in per PC. */
const sameLogin = (db: Db, row: Wire): boolean => db.all<{ email: string | null }>(
  "SELECT email FROM accounts WHERE provider = ? AND auth = 'cli' AND id <> ?", [sqlValue(row.provider), sqlValue(row.id)],
).some((other) => !ownHomes(row.provider as ProviderId) || (Boolean(row.email) && other.email === row.email));

const accounts: Table = {
  name: 'accounts', skip: ['state', 'limits', 'cooling_until', 'checked_at', 'device_id'], soft: ['home'],
  // A plan's login travels (logins.ts), also one this PC found in a CLI's default home; its home on another PC is that
  // PC's own folder for it (or the default home of a CLI with one sign-in per PC), and a login the other PC has itself
  // stays one account there. What else a PC found (an environment key, a local model server) stays on it.
  view: ({ detected, ...row }) => (detected && row.auth !== 'cli' ? undefined : row), // whether a PC found it is that PC's
  write: (row, { s }, existed) => {
    const { home, ...rest } = row;
    if (existed) { upsert(s.db, 'accounts', rest); return; }
    if (row.auth === 'cli' && sameLogin(s.db, row)) return;
    const own = row.auth === 'cli' ? ownHomes(row.provider as ProviderId) : Boolean(home);
    upsert(s.db, 'accounts', { ...rest, home: own ? path.join(s.paths.accounts, String(row.provider), String(row.id)) : null });
  },
  drop: (id, { s }) => { void s.accounts.remove(id).catch((error: unknown) => s.log.warn('synced account not removed', { id, error: String(error) })); },
  emit: (id, { s }) => { const account = s.accounts.get(id); if (account) s.bus.emit('account.upserted', account); },
};

// A streaming answer travels like any message (its live values in meta). One that ends here after other lines came –
// or a silent one (a background run's live row, whose seq never took the chat's place) – moves to the end: a fresh seq
// of this PC, as on the PC where it ran (chat/publish-message.ts), so no colleague's cursor here has passed it.
const messages: Table = {
  name: 'messages', skip: ['seq', 'client_id'],
  write: (row, ctx, existed) => {
    const { s } = ctx;
    const convs = new ConversationRepo(s.db);
    const msgs = new MessageRepo(s.db);
    const message = toMessage({ ...row, seq: 0 });
    if (existed) {
      const here = msgs.get(message.id)!;
      message.seq = here.seq;
      const ended = here.state !== message.state && message.state !== 'streaming';
      if (ended && ((here.state === 'streaming' && here.silent) || msgs.postedAfter(here.conversationId, here.id, here.seq))) {
        message.seq = convs.nextSeq(here.conversationId, s.clock.now());
        msgs.moveToSeq(message.id, message.seq);
        convs.advanceReadIfCaughtUp(here.conversationId, message.authorId, message.seq);
      }
      msgs.update(message);
      return;
    }
    const chat = convs.get(message.conversationId);
    if (!chat) throw new Error('its chat is not here');
    message.seq = convs.nextSeq(chat.id, Math.max(message.createdAt, chat.lastMessageAt ?? 0)); // a fresh seq of this PC
    msgs.insert(message);
    readWaits(s, chat.id, message.id);
    if (ctx.first) s.db.run('UPDATE members SET read_seq = ? WHERE conversation_id = ? AND read_seq = ?', [message.seq, chat.id, message.seq - 1]);
    else if (message.authorKind === 'human') convs.advanceRead(chat.id, message.authorId, message.seq);
    else convs.advanceReadIfCaughtUp(chat.id, message.authorId, message.seq);
  },
  drop: (id, { s }) => {
    const msgs = new MessageRepo(s.db);
    const message = msgs.get(id);
    msgs.delete(id);
    if (!message) return;
    s.bus.emit('message.removed', { id, conversationId: message.conversationId });
    if (s.chats.get(message.conversationId)) s.bus.emit('conversation.upserted', s.chats.summary(message.conversationId));
  },
  // No second delivery here: the PC where a message was written decided once whom it wakes (responders, guards),
  // and its wakes for agents at home on another PC travel there with the rows (rows.ts hand-over).
  emit: (id, { s }, existed) => {
    const message = s.chats.message(id);
    if (!message) return;
    s.bus.emit(existed ? 'message.updated' : 'message.created', message);
    if (s.chats.get(message.conversationId)) s.bus.emit('conversation.upserted', s.chats.summary(message.conversationId));
  },
  // The person's own rule (people/access.ts): their chats' messages from their join on, unless the chat shares its history.
  employee: (row, personId, db) => {
    const chat = db.get<{ id: string; settings: string }>('SELECT id, settings FROM conversations WHERE id = ?', [sqlValue(row.conversation_id)]);
    return Boolean(chat) && mayReadMessage(db, personId, { id: chat!.id, settings: json<ConversationSettings>(chat!.settings, {}) }, { createdAt: Number(row.created_at) });
  },
};

// A chat's shared notes (notes/store.ts: one text per chat, last write wins); they go with their chat.
const notes: Table = {
  name: 'chat_notes', key: 'conversation_id',
  write: (row, { s }) => {
    if (!exists(s.db, 'conversations', row.conversation_id)) throw new Error('its chat is not here');
    upsert(s.db, 'chat_notes', row, ['conversation_id']);
  },
  drop: () => {},
  emit: (id, { s }) => {
    const row = s.db.get<{ version: number; updated_at: number }>('SELECT version, updated_at FROM chat_notes WHERE conversation_id = ?', [id]);
    if (row) s.bus.emit('notes.updated', { conversationId: id, version: Number(row.version), updatedAt: Number(row.updated_at) } satisfies NotesUpdated);
  },
};

// Knowledge rows (chat observations, old versions of memory files – those files travel in files.ts); how often a row
// was used and its embedding are this PC's.
const knowledge: Table = {
  name: 'knowledge', skip: ['uses', 'last_used_at', 'embedding', 'embedding_profile'],
  drop: (id, { s }) => { deleteRows(s.db, [id]); s.bus.emit('knowledge.removed', { ids: [id] }); },
  emit: (id, { s }) => { const row = getRow(s.db, id); if (row) s.bus.emit('knowledge.upserted', toItem(row)); },
};

/** In apply order. */
export const TABLES: readonly Table[] = [files, spaces, people, conversations, agents, tasks, schedules, accounts, messages, notes, knowledge];
export const TABLE = new Map(TABLES.map((table) => [table.name, table]));
