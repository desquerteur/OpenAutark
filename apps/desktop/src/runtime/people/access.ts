// What a person may read and use (F-52) – the one rule set behind every person call and every event
// a person's device receives:
//  * chats: only chats where the person is an active member; messages from the time they joined,
//    unless the chat shares its whole history (settings.history 'full');
//  * tasks: assigned to them, created or assigned by them, or in a chat they belong to – there, like
//    messages, only tasks made from their join on unless the chat shares its whole history;
//  * files: attached to a message they may read, the image avatars of active agents and people, and
//    the files they uploaded themselves (person_uploads);
//  * agents: to work with (add to chats, give tasks): active agents of the spaces their scopes name
//    ('all' includes agents without a space); to see as colleagues additionally the agents of their
//    chats, their own manager and the agents reporting to them (visibleAgents).
// The owner (CEO) sees every chat, people's own chats included.
// Owns: these checks (SQL reads only). Never: writes, events or a check based on what a client claims.

import type { Conversation, ConversationSettings, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { Db } from '../db/database.ts';

type MemberRow = { conversation_id: string; joined_at: number; read_seq: number };

/** The person's active membership of a chat, if any. */
export function membership(db: Db, personId: string, conversationId: string): { joinedAt: number; readSeq: number } | undefined {
  const row = db.get<MemberRow>('SELECT conversation_id, joined_at, read_seq FROM members WHERE conversation_id = ? AND member_id = ? AND left_at IS NULL', [conversationId, personId]);
  return row ? { joinedAt: Number(row.joined_at), readSeq: Number(row.read_seq) } : undefined;
}

/** Ids of the chats the person is an active member of. */
export function chatIdsOf(db: Db, personId: string): Set<string> {
  return new Set(db.all<MemberRow>('SELECT conversation_id FROM members WHERE member_id = ? AND left_at IS NULL', [personId]).map((row) => String(row.conversation_id)));
}

/** From when the person sees a chat's messages (0 = its whole history). */
export function visibleFrom(chat: Pick<Conversation, 'settings'>, joinedAt: number): number {
  return chat.settings.history === 'full' ? 0 : joinedAt;
}

function fullHistory(settingsJson: unknown): boolean {
  try { return (JSON.parse(String(settingsJson)) as ConversationSettings).history === 'full'; } catch { return false; }
}

/** May the person see this message (member now, and it is from their visible time on)? */
export function mayReadMessage(db: Db, personId: string, chat: Pick<Conversation, 'id' | 'settings'>, message: Pick<Message, 'createdAt'>): boolean {
  const member = membership(db, personId, chat.id);
  return Boolean(member && message.createdAt >= visibleFrom(chat, member.joinedAt));
}

type ReadableTask = Pick<Task, 'conversationId' | 'assigneeKind' | 'assigneeId' | 'createdBy' | 'assignedBy' | 'createdAt'>;

/** Tasks the person may read: theirs, made or handed on by them, or of one of their chats from their visible time on. */
export function mayReadTask(db: Db, personId: string, task: ReadableTask): boolean {
  if (task.assigneeKind === 'human' && task.assigneeId === personId) return true;
  if (task.createdBy === personId || task.assignedBy === personId) return true;
  if (!task.conversationId) return false; // a chat-free task (B-054): only its parties read it
  const row = db.get<{ joined_at: number; settings: string }>(
    'SELECT m.joined_at, c.settings FROM members m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.member_id = ? AND m.left_at IS NULL',
    [task.conversationId, personId],
  );
  return Boolean(row) && (fullHistory(row!.settings) || task.createdAt >= Number(row!.joined_at));
}

/** SQL condition (alias t) for the tasks a person may read – the same rule as mayReadTask. */
export function readableTasksSql(personId: string): { sql: string; params: string[] } {
  return {
    sql: `((t.assignee_kind = 'human' AND t.assignee_id = ?) OR t.created_by = ? OR t.assigned_by = ?
      OR EXISTS (SELECT 1 FROM members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = t.conversation_id AND m.member_id = ? AND m.left_at IS NULL
          AND (t.created_at >= m.joined_at OR json_extract(c.settings, '$.history') = 'full')))`,
    params: [personId, personId, personId, personId],
  };
}

/** A stored file the person may fetch: attached to a message of one of their chats from their visible time on, or an avatar. */
export function mayReadFile(db: Db, personId: string, fileId: string, options: { ownUploads?: boolean } = {}): boolean {
  if (!/^[0-9a-f]{64}$/i.test(fileId)) return false;
  const id = fileId.toLowerCase();
  const rows = db.all<{ settings: string; joined_at: number; created_at: number }>(
    `SELECT c.settings, m.joined_at, msg.created_at FROM messages msg
       JOIN members m ON m.conversation_id = msg.conversation_id AND m.member_id = ? AND m.left_at IS NULL
       JOIN conversations c ON c.id = msg.conversation_id
     WHERE msg.attachments <> '[]' AND EXISTS (SELECT 1 FROM json_each(msg.attachments) a WHERE json_extract(a.value, '$.fileId') = ?) LIMIT 20`,
    [personId, id],
  );
  if (rows.some((row) => fullHistory(row.settings) || Number(row.created_at) >= Number(row.joined_at))) return true;
  return avatarFile(db, id) || (options.ownUploads !== false && uploadedBy(db, personId, id));
}

/** The person uploaded this file (into `conversationId`, when given – people/uploads.ts). */
export function uploadedBy(db: Db, personId: string, fileId: string, conversationId?: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(fileId)) return false;
  try {
    return Boolean(conversationId === undefined
      ? db.get('SELECT 1 FROM person_uploads WHERE person_id = ? AND file_id = ? LIMIT 1', [personId, fileId.toLowerCase()])
      : db.get('SELECT 1 FROM person_uploads WHERE person_id = ? AND file_id = ? AND conversation_id = ? LIMIT 1', [personId, fileId.toLowerCase(), conversationId]));
  } catch {
    return false; // a database without the table
  }
}

/**
 * A readable file as the person knows it – the name and time of their own latest upload of
 * it, else of an attachment of it they may read – never the name and time it was first stored under by
 * someone else (identical bytes share one stored file). An avatar keeps the stored ref.
 */
export function personFileView<T extends { id: string; name: string; createdAt: number }>(db: Db, personId: string, ref: T): T {
  const id = ref.id.toLowerCase();
  try {
    const own = db.get<{ name: string; created_at: number }>('SELECT name, created_at FROM person_uploads WHERE person_id = ? AND file_id = ? ORDER BY created_at DESC LIMIT 1', [personId, id]);
    if (own) return { ...ref, name: String(own.name), createdAt: Number(own.created_at) };
  } catch { /* a database without the table */ }
  const rows = db.all<{ name: string | null; settings: string; joined_at: number; created_at: number }>(
    `SELECT json_extract(a.value, '$.name') AS name, c.settings, m.joined_at, msg.created_at FROM messages msg
       JOIN members m ON m.conversation_id = msg.conversation_id AND m.member_id = ? AND m.left_at IS NULL
       JOIN conversations c ON c.id = msg.conversation_id, json_each(msg.attachments) a
     WHERE msg.attachments <> '[]' AND json_extract(a.value, '$.fileId') = ? ORDER BY msg.created_at LIMIT 20`,
    [personId, id],
  );
  const seen = rows.find((row) => fullHistory(row.settings) || Number(row.created_at) >= Number(row.joined_at));
  return seen ? { ...ref, name: String(seen.name || 'file'), createdAt: Number(seen.created_at) } : ref;
}

/** The image avatar of an active agent or of a person still in the organisation (the shared UI shows them). */
function avatarFile(db: Db, fileId: string): boolean {
  const image = `json_extract(avatar, '$.kind') = 'image' AND json_extract(avatar, '$.value') = ?`;
  if (db.get(`SELECT 1 FROM agents WHERE archived_at IS NULL AND ${image} LIMIT 1`, [fileId])) return true;
  try { return Boolean(db.get(`SELECT 1 FROM people WHERE status <> 'revoked' AND ${image} LIMIT 1`, [fileId])); } catch { return false; }
}

/** May the person work with this agent (add it to chats, give it tasks)? */
export function mayUseAgent(person: Pick<Person, 'scopes' | 'status'>, agent: Pick<Agent, 'spaceId' | 'archivedAt'> | undefined): boolean {
  if (!agent || agent.archivedAt !== undefined || person.status === 'revoked') return false;
  const spaces = person.scopes.spaces;
  if (spaces === 'all') return true;
  return agent.spaceId !== undefined && spaces.includes(agent.spaceId);
}

/** Which agents the person sees as colleagues: those they may use, those of their chats, their manager and their reports. */
export function visibleAgents(db: Db, person: Pick<Person, 'id' | 'scopes' | 'status' | 'managerId'>): (agent: Pick<Agent, 'id' | 'spaceId' | 'archivedAt' | 'managerId'> | undefined) => boolean {
  const inChats = new Set(db.all<{ member_id: string }>(
    `SELECT DISTINCT b.member_id FROM members a JOIN members b ON b.conversation_id = a.conversation_id
     WHERE a.member_id = ? AND a.left_at IS NULL AND b.left_at IS NULL AND b.kind = 'agent'`, [person.id],
  ).map((row) => String(row.member_id)));
  return (agent) => Boolean(agent) && person.status !== 'revoked'
    && (mayUseAgent(person, agent) || inChats.has(agent!.id) || agent!.id === person.managerId || agent!.managerId === person.id);
}

/** May the person see this space (the spaces their scopes name)? */
export function maySeeSpace(person: Pick<Person, 'scopes'>, spaceId: string): boolean {
  return person.scopes.spaces === 'all' || person.scopes.spaces.includes(spaceId);
}

/**
 * Unread for a person: visible, non-silent, finished messages after their cursor they did not write – and
 * how many of them are important (B-050 K4: the person's red badge), one query as MessageRepo.unreadCounts.
 */
export function personUnreadCounts(db: Db, personId: string, conversationId: string, readSeq: number, from: number): { unread: number; important: number } {
  const row = db.get<{ n: number; important: number | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN priority = 'important' THEN 1 ELSE 0 END) AS important FROM messages
     WHERE conversation_id = ? AND seq > ? AND created_at >= ? AND silent = 0 AND state != 'streaming' AND author_id != ?`,
    [conversationId, readSeq, from, personId],
  );
  return { unread: Number(row?.n ?? 0), important: Number(row?.important ?? 0) };
}
