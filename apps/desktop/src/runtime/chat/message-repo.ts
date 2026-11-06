// Repository for the canonical message log and its full-text index.
// Owns: SQL for `messages` and `messages_fts` (rowid-linked, German-folded text), the re-seq of one
// message (B-047 D4: a run's answer moves to the end of its chat – the seq the service reserved
// is new, so UNIQUE(conversation_id, seq) holds, and the rowid, which links the FTS row, stays) and
// the reads of what a run posted (its other text posts, its status update rate). B-075: a run's row is written while it
// streams (writeLive: body and meta only, never once it is finished) and stays out of the index until then; the chat
// summaries read the streaming rows (liveRows); the start-up reconcile takes only rows of runs of this PC.
// Never: emits events or assigns seq on its own (the service reserves seq in its transaction).

import { bool, int, json, toJson, type Db } from '../db/database.ts';
import { nul, opt, optNumber } from '../store/rows.ts';
import { foldText, ftsQuery } from '../../shared/text/normalize.ts';
import type { Attachment, LiveRun, Message, MessageMeta } from '../../shared/model/chat.ts';

type Row = Record<string, unknown>;

export function toMessage(row: Row): Message {
  const message: Message = {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    seq: Number(row.seq),
    authorId: String(row.author_id),
    authorKind: String(row.author_kind) as Message['authorKind'],
    kind: String(row.kind) as Message['kind'],
    body: String(row.body),
    attachments: json<Attachment[]>(row.attachments, []),
    mentions: json<string[]>(row.mentions, []),
    priority: String(row.priority) as Message['priority'],
    state: String(row.state) as Message['state'],
    silent: bool(row.silent),
    meta: json<MessageMeta>(row.meta, {}),
    createdAt: Number(row.created_at),
  };
  const replyTo = opt<string>(row.reply_to);
  const runId = opt<string>(row.run_id);
  const taskId = opt<string>(row.task_id);
  const editedAt = optNumber(row.edited_at);
  if (replyTo) message.replyTo = replyTo;
  if (runId) message.runId = runId;
  if (taskId) message.taskId = taskId;
  if (editedAt !== undefined) message.editedAt = editedAt;
  return message;
}

/** Text that goes into the FTS index (folded); status lines and rows still streaming (B-075) are not indexed. */
function indexText(message: Pick<Message, 'kind' | 'body' | 'attachments' | 'state'>): string {
  if (message.kind === 'status' || message.state === 'streaming') return '';
  return foldText([message.body, ...message.attachments.map(file => file.name)].join(' ')).trim();
}

export class MessageRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): Message | undefined {
    const row = this.db.get<Row>('SELECT * FROM messages WHERE id = ?', [id]);
    return row ? toMessage(row) : undefined;
  }

  byClientId(conversationId: string, clientId: string): Message | undefined {
    const row = this.db.get<Row>('SELECT * FROM messages WHERE conversation_id = ? AND client_id = ?', [conversationId, clientId]);
    return row ? toMessage(row) : undefined;
  }

  insert(m: Message, clientId?: string): void {
    this.db.run(
      `INSERT INTO messages (id, conversation_id, seq, author_id, author_kind, kind, body, attachments, mentions, priority,
         reply_to, run_id, task_id, state, silent, meta, client_id, created_at, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.id, m.conversationId, m.seq, m.authorId, m.authorKind, m.kind, m.body, toJson(m.attachments), toJson(m.mentions),
        m.priority, nul(m.replyTo), nul(m.runId), nul(m.taskId), m.state, int(m.silent), toJson(m.meta), nul(clientId),
        m.createdAt, nul(m.editedAt)],
    );
    this.index(m);
  }

  /** Persists mutable fields (body/state/meta/edit) and refreshes the index. */
  update(m: Message): void {
    this.db.run(
      'UPDATE messages SET body = ?, state = ?, meta = ?, edited_at = ?, attachments = ?, mentions = ?, kind = ?, silent = ?, priority = ? WHERE id = ?',
      [m.body, m.state, toJson(m.meta), nul(m.editedAt), toJson(m.attachments), toJson(m.mentions), m.kind, int(m.silent), m.priority, m.id],
    );
    this.index(m);
  }

  /** B-075: a streaming row's body and meta (no index, no other field); false when it is no longer streaming (finished, removed). */
  writeLive(id: string, body: string, meta: MessageMeta): boolean {
    return this.db.run(`UPDATE messages SET body = ?, meta = ? WHERE id = ? AND state = 'streaming'`, [body, toJson(meta), id]).changes > 0;
  }

  /** Re-seq (B-047 D4): `seq` was just reserved by the service (ConversationRepo.nextSeq), so it is free. */
  moveToSeq(id: string, seq: number): void {
    this.db.run('UPDATE messages SET seq = ? WHERE id = ?', [seq, id]);
  }

  delete(id: string): void {
    this.unindex(id);
    this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /** Removes index rows of a whole conversation (before the cascade delete). */
  unindexConversation(conversationId: string): void {
    this.db.run('DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE conversation_id = ?)', [conversationId]);
  }

  private index(m: Message): void {
    this.unindex(m.id);
    const text = indexText(m);
    if (!text) return;
    this.db.run(
      'INSERT INTO messages_fts (rowid, message_id, conversation_id, text) SELECT rowid, id, conversation_id, ? FROM messages WHERE id = ?',
      [text, m.id],
    );
  }

  private unindex(id: string): void {
    this.db.run('DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = ?)', [id]);
  }

  /** Page of a conversation in ascending seq order. */
  page(conversationId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    if (options.afterSeq !== undefined) {
      return this.db
        .all<Row>('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [conversationId, options.afterSeq, limit])
        .map(toMessage);
    }
    const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .all<Row>('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [conversationId, before, limit])
      .map(toMessage)
      .reverse();
  }

  /** Unread for a reader: after its cursor, not silent, not streaming, not authored by itself. */
  unread(conversationId: string, readerId: string, readSeq: number): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND silent = 0 AND state != 'streaming' AND author_id != ?`,
      [conversationId, readSeq, readerId],
    );
    return Number(row?.n ?? 0);
  }

  /** unread() plus how many of them are marked important (priority 'important') – one query, for list rows. */
  unreadCounts(conversationId: string, readerId: string, readSeq: number): { unread: number; important: number } {
    const row = this.db.get<{ n: number; important: number | null }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN priority = 'important' THEN 1 ELSE 0 END) AS important FROM messages
       WHERE conversation_id = ? AND seq > ? AND silent = 0 AND state != 'streaming' AND author_id != ?`,
      [conversationId, readSeq, readerId],
    );
    return { unread: Number(row?.n ?? 0), important: Number(row?.important ?? 0) };
  }

  /** Last visible (non-silent) message, for list previews. */
  last(conversationId: string): Message | undefined {
    const row = this.db.get<Row>(
      'SELECT * FROM messages WHERE conversation_id = ? AND silent = 0 ORDER BY seq DESC LIMIT 1',
      [conversationId],
    );
    return row ? toMessage(row) : undefined;
  }

  /** B-078: a thread's replies – finished, non-silent lines that are no status line – and the author of the newest. */
  replies(conversationId: string): { count: number; authorId?: string } {
    const where = `conversation_id = ? AND silent = 0 AND kind != 'status' AND state != 'streaming'`;
    const row = this.db.get<{ n: number; last: string | null }>(
      `SELECT COUNT(*) AS n, (SELECT author_id FROM messages WHERE ${where} ORDER BY seq DESC LIMIT 1) AS last FROM messages WHERE ${where}`,
      [conversationId, conversationId],
    );
    const count = Number(row?.n ?? 0);
    return row?.last ? { count, authorId: String(row.last) } : { count };
  }

  /** Streaming rows of this PC (no run, or a run in its own journal) – a synced row of another PC's run is that PC's to end (B-075). */
  streaming(): Message[] {
    return this.db.all<Row>(`SELECT * FROM messages WHERE state = 'streaming' AND (run_id IS NULL OR run_id IN (SELECT id FROM runs))`).map(toMessage);
  }

  /** B-075: the runs at work in these chats – their agents' rows in state 'streaming', by chat, in seq order. */
  liveRows(conversationIds: readonly string[]): Map<string, LiveRun[]> {
    const out = new Map<string, LiveRun[]>();
    if (!conversationIds.length) return out;
    const rows = this.db.all<Row>(
      `SELECT id, conversation_id, author_id, run_id, meta, created_at FROM messages
       WHERE conversation_id IN (SELECT value FROM json_each(?)) AND state = 'streaming' AND author_kind = 'agent' AND run_id IS NOT NULL ORDER BY seq`,
      [JSON.stringify(conversationIds)]);
    for (const row of rows) {
      const live = json<MessageMeta>(row.meta, {}).live;
      const run: LiveRun = { runId: String(row.run_id), agentId: String(row.author_id), messageId: String(row.id), startedAt: live?.startedAt ?? Number(row.created_at) };
      if (live?.note) run.note = live.note;
      if (live?.model) run.model = live.model;
      if (live?.effort) run.effort = live.effort;
      if (live?.taskId) run.taskId = live.taskId;
      const chat = String(row.conversation_id);
      out.set(chat, [...(out.get(chat) ?? []), run]);
    }
    return out;
  }

  /** Whether anything other than message `id` was posted in the chat after `seq` (its answer then moves to the end). */
  postedAfter(conversationId: string, id: string, seq: number): boolean {
    return Boolean(this.db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ? AND id != ? LIMIT 1', [conversationId, seq, id]));
  }

  /** bm25-ranked full-text search over folded text. */
  search(text: string, options: { conversationId?: string; memberId?: string; limit?: number; excludeConversations?: readonly string[] }): Message[] {
    const query = ftsQuery(text);
    if (!query) return [];
    const where = ['messages_fts MATCH ?'];
    const params: Array<string | number> = [query];
    if (options.conversationId) { where.push('m.conversation_id = ?'); params.push(options.conversationId); }
    if (options.memberId) {
      where.push('EXISTS (SELECT 1 FROM members mb WHERE mb.conversation_id = m.conversation_id AND mb.member_id = ? AND mb.left_at IS NULL)');
      params.push(options.memberId);
    }
    if (options.excludeConversations?.length) { where.push('m.conversation_id NOT IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(options.excludeConversations)); } // F-52: chats out of a turn's reach
    params.push(Math.min(Math.max(options.limit ?? 20, 1), 200));
    return this.db
      .all<Row>(
        `SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE ${where.join(' AND ')} ORDER BY bm25(messages_fts) ASC, m.created_at DESC LIMIT ?`,
        params,
      )
      .map(toMessage);
  }
}

/** B-047 D4 safety net: whether run `runId` posted a final text message into the chat besides `exceptId` (its own answer). */
export function runPosted(db: Db, conversationId: string, runId: string, exceptId?: string): boolean {
  return Boolean(db.get(
    `SELECT 1 FROM messages WHERE conversation_id = ? AND run_id = ? AND kind = 'text' AND state = 'final' AND id != ? LIMIT 1`,
    [conversationId, runId, exceptId ?? ''],
  ));
}

/** How many status updates run `runId` posted (chat.send status, any chat) and when the latest was written. */
export function runStatusLines(db: Db, runId: string): { count: number; lastAt?: number } {
  const row = db.get<{ n: number; last: number | null }>(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE run_id = ? AND kind = 'status'`, [runId]);
  const last = row?.last;
  return { count: Number(row?.n ?? 0), ...(last !== null && last !== undefined ? { lastAt: Number(last) } : {}) };
}
