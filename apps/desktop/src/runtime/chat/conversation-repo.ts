// Repository for conversations, members and drafts (SQL only).
// Owns: row ↔ model mapping and statements for `conversations`, `members`, `drafts`, and the members' form between
// linked PCs (read cursors by message id).
// Never: emits events, wakes agents or decides policy (that is chat/service.ts).

import { bool, int, json, toJson, type Db } from '../db/database.ts';
import { compact, nul, opt, optNumber } from '../store/rows.ts';
import type { Conversation, ConversationSettings, Member } from '../../shared/model/chat.ts';

type Row = Record<string, unknown>;

export function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    titleNamed: bool(row.title_named),
    spaceId: opt<string>(row.space_id),
    createdBy: String(row.created_by),
    pinned: bool(row.pinned),
    settings: json<ConversationSettings>(row.settings, {}),
    lastMessageAt: optNumber(row.last_message_at),
    lastSeq: Number(row.last_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: optNumber(row.archived_at),
  };
}

export function toMember(row: Row): Member {
  const member: Member = {
    conversationId: String(row.conversation_id),
    memberId: String(row.member_id),
    kind: String(row.kind) as Member['kind'],
    role: String(row.role) as Member['role'],
    readSeq: Number(row.read_seq),
    joinedAt: Number(row.joined_at),
  };
  if (row.left_at !== null && row.left_at !== undefined) member.leftAt = Number(row.left_at);
  return member;
}

export class ConversationRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Conversation | undefined {
    const row = this.db.get<Row>('SELECT * FROM conversations WHERE id = ?', [id]);
    return row ? compact(toConversation(row)) : undefined;
  }

  insert(c: Conversation): void {
    this.db.run(
      `INSERT INTO conversations (id, title, title_named, space_id, created_by, pinned, settings, last_message_at, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.title, int(c.titleNamed), nul(c.spaceId), c.createdBy, int(c.pinned), toJson(c.settings), nul(c.lastMessageAt), c.lastSeq, c.createdAt, c.updatedAt],
    );
  }

  update(c: Conversation): void {
    this.db.run(
      `UPDATE conversations SET title = ?, title_named = ?, space_id = ?, pinned = ?, settings = ?, updated_at = ?, archived_at = ? WHERE id = ?`,
      [c.title, int(c.titleNamed), nul(c.spaceId), int(c.pinned), toJson(c.settings), c.updatedAt, nul(c.archivedAt), c.id],
    );
  }

  /**
   * Reserves the next per-conversation seq (call inside a transaction). `quiet` leaves the chat's
   * last_message_at and updated_at alone – a row only agents read (C6: the notice of the person's
   * edit or delete, chat/message-edits.ts) must not move the chat up the person's list.
   */
  nextSeq(id: string, at: number, options: { quiet?: boolean } = {}): number {
    const row = options.quiet
      ? this.db.get<{ last_seq: number }>('UPDATE conversations SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq', [id])
      : this.db.get<{ last_seq: number }>(
        'UPDATE conversations SET last_seq = last_seq + 1, last_message_at = ?, updated_at = ? WHERE id = ? RETURNING last_seq',
        [at, at, id],
      );
    if (!row) throw new Error(`conversation ${id} missing`);
    return Number(row.last_seq);
  }

  /** Visible list rows: not archived, pinned first, most recent activity first. */
  list(options: { includeArchived?: boolean; forMember?: string } = {}): Conversation[] {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeArchived) where.push('c.archived_at IS NULL');
    if (options.forMember) {
      where.push('EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.member_id = ? AND m.left_at IS NULL)');
      params.push(options.forMember);
    }
    const sql = `SELECT c.* FROM conversations c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC`;
    return this.db.all<Row>(sql, params).map(row => compact(toConversation(row)));
  }

  delete(id: string): void {
    this.db.run('DELETE FROM conversations WHERE id = ?', [id]);
  }

  // ------------------------------------------------------------- members

  members(conversationId: string, includeLeft = false): Member[] {
    return this.db
      .all<Row>(
        `SELECT * FROM members WHERE conversation_id = ? ${includeLeft ? '' : 'AND left_at IS NULL'} ORDER BY joined_at, CASE kind WHEN 'human' THEN 0 ELSE 1 END, member_id`,
        [conversationId],
      )
      .map(toMember);
  }

  /** Active members of many conversations at once (list projection). */
  membersOf(ids: string[]): Map<string, Member[]> {
    const out = new Map<string, Member[]>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.all<Row>(
        `SELECT * FROM members WHERE left_at IS NULL AND conversation_id IN (${chunk.map(() => '?').join(',')}) ORDER BY joined_at, CASE kind WHEN 'human' THEN 0 ELSE 1 END, member_id`,
        chunk,
      );
      for (const row of rows) {
        const member = toMember(row);
        const list = out.get(member.conversationId) ?? [];
        list.push(member);
        out.set(member.conversationId, list);
      }
    }
    return out;
  }

  member(conversationId: string, memberId: string): Member | undefined {
    const row = this.db.get<Row>('SELECT * FROM members WHERE conversation_id = ? AND member_id = ?', [conversationId, memberId]);
    return row ? toMember(row) : undefined;
  }

  /** Inserts or re-activates a member. */
  upsertMember(m: Member): void {
    this.db.run(
      `INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(conversation_id, member_id) DO UPDATE SET kind = excluded.kind, role = excluded.role,
         read_seq = MAX(members.read_seq, excluded.read_seq), joined_at = excluded.joined_at, left_at = NULL`,
      [m.conversationId, m.memberId, m.kind, m.role, m.readSeq, m.joinedAt],
    );
  }

  setRole(conversationId: string, memberId: string, role: Member['role']): void {
    this.db.run('UPDATE members SET role = ? WHERE conversation_id = ? AND member_id = ?', [role, conversationId, memberId]);
  }

  leave(conversationId: string, memberId: string, at: number): boolean {
    return this.db.run(
      'UPDATE members SET left_at = ? WHERE conversation_id = ? AND member_id = ? AND left_at IS NULL',
      [at, conversationId, memberId],
    ).changes > 0;
  }

  /** Cursor only moves forward. Returns true when it moved. */
  advanceRead(conversationId: string, memberId: string, seq: number): boolean {
    return this.db.run(
      'UPDATE members SET read_seq = ? WHERE conversation_id = ? AND member_id = ? AND read_seq < ?',
      [seq, conversationId, memberId, seq],
    ).changes > 0;
  }

  /**
   * B-078: the members as they travel between linked PCs (devices/sync/tables.ts) – the owner's read cursor as `read_id`,
   * the id of the last message read, since seqs are per PC (a person's cursor stays with each PC).
   */
  syncMembers(conversationId: string): Row[] {
    return this.db.all<Row>(
      `SELECT m.member_id, m.kind, m.role, m.joined_at, m.left_at, CASE WHEN m.member_id = 'human' THEN (SELECT x.id FROM messages x
         WHERE x.conversation_id = m.conversation_id AND x.seq <= m.read_seq ORDER BY x.seq DESC LIMIT 1) END AS read_id
       FROM members m WHERE m.conversation_id = ? ORDER BY m.member_id`, [conversationId],
    ).map(({ read_id, ...member }) => (read_id ? { ...member, read_id } : member));
  }

  /** B-078: a read cursor from another PC – onto that message's seq here, never back; 'missing' when the message is not here. */
  takeRead(conversationId: string, memberId: string, messageId: string): 'moved' | 'kept' | 'missing' {
    const seq = this.db.get<{ seq: number }>('SELECT seq FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId])?.seq;
    if (seq === undefined) return 'missing';
    return this.advanceRead(conversationId, memberId, Number(seq)) ? 'moved' : 'kept';
  }

  /** Moves the cursor onto `seq` only when the member had seen everything before it. */
  advanceReadIfCaughtUp(conversationId: string, memberId: string, seq: number): void {
    this.db.run(
      'UPDATE members SET read_seq = ? WHERE conversation_id = ? AND member_id = ? AND read_seq = ?',
      [seq, conversationId, memberId, seq - 1],
    );
  }

  // ------------------------------------------------------------- drafts

  draft(conversationId: string): { text: string; attachments: unknown[] } | undefined {
    const row = this.db.get<Row>('SELECT text, attachments FROM drafts WHERE conversation_id = ?', [conversationId]);
    return row ? { text: String(row.text), attachments: json<unknown[]>(row.attachments, []) } : undefined;
  }

  drafts(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = this.db.all<Row>(`SELECT conversation_id, text FROM drafts WHERE conversation_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of rows) if (String(row.text)) out.set(String(row.conversation_id), String(row.text));
    return out;
  }

  saveDraft(conversationId: string, text: string, attachments: unknown[], at: number, secrets: string[] = []): void {
    if (!text.trim() && !attachments.length && !secrets.length) {
      this.db.run('DELETE FROM drafts WHERE conversation_id = ?', [conversationId]);
      return;
    }
    this.db.run(
      `INSERT INTO drafts (conversation_id, text, attachments, updated_at, secret_ids) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, attachments = excluded.attachments, updated_at = excluded.updated_at, secret_ids = excluded.secret_ids`,
      [conversationId, text, toJson(attachments), at, toJson(secrets)],
    );
  }

  /** Open top-level tasks per conversation (list badge). */
  openTasks(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const rows = this.db.all<Row>(
      `SELECT conversation_id, COUNT(*) AS n FROM tasks WHERE parent_id IS NULL AND status NOT IN ('done', 'cancelled')
       AND conversation_id IN (${ids.map(() => '?').join(',')}) GROUP BY conversation_id`,
      ids,
    );
    for (const row of rows) out.set(String(row.conversation_id), Number(row.n));
    return out;
  }
}
