// Repository for the media library: `media` rows (joined with `files` for the size) and their
// `media_fts` mirror (German-folded name, description and tags; FTS rowid = media rowid).
// Owns: SQL, row ↔ MediaInfo mapping, the search query and the visibility clause for agents;
// MM6: removing a row with its FTS mirror (Blobs.remove), re-linking a row whose chat was
// deleted, and the clean-up's lookups (a chat's file ids, rows linked to deleted chats).
// Never: business rules beyond visibility (MediaLibrary validates and emits events), file
// bytes, or writes to other tables.
//
// Visibility for agents: media of chats the agent is an active member of (archived ones too,
// C2), plus media not linked to any chat that carry a description or tags. Uploads
// record no uploader, so an untouched global file (tool output, export, import) stays
// private; it is shared once the human describes or tags it (see MediaLibrary.describe).
// The owner sees every file; audienceSql is the one rule for both.

import type { Db } from '../db/database.ts';
import { json, toJson } from '../db/database.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { MediaFilter, MediaInfo, MediaKind } from '../../shared/model/media.ts';
import { foldText, searchTokens } from '../knowledge/normalize.ts';
import { compact, nul, opt, optNumber } from '../store/rows.ts';

export interface MediaRow {
  file_id: string; conversation_id: string | null; kind: string; mime: string; name: string;
  width: number | null; height: number | null; duration_ms: number | null; pages: number | null;
  description: string | null; tags: string | null; described_by: string | null; described_at: number | null;
  created_at: number; updated_at: number; size: number | null;
}

/** Who reads: the owner (everything but the people's own chats, F-52) or one agent (see the visibility rule above). */
export type MediaAudience = { kind: 'owner' } | { kind: 'agent'; agentId: string };

export interface NewMedia {
  fileId: string; name: string; mime: string; kind: MediaKind; conversationId?: string;
  width?: number; height?: number; durationMs?: number; now: number;
}

export interface MeasuredFacts { kind?: MediaKind; width?: number; height?: number; durationMs?: number; pages?: number }

const SELECT = `SELECT m.file_id, m.conversation_id, m.kind, m.mime, m.name, m.width, m.height, m.duration_ms, m.pages,
  m.description, m.tags, m.described_by, m.described_at, m.created_at, m.updated_at, f.size
  FROM media m JOIN files f ON f.id = m.file_id`;

const AGENT_SCOPE = `(m.conversation_id IN (
    SELECT mb.conversation_id FROM members mb WHERE mb.member_id = ? AND mb.left_at IS NULL)
  OR (m.conversation_id IS NULL AND m.described_by IS NOT NULL))`;

/** The audience's rule as SQL over `media m`: the owner – everything; an agent – its chats' and shared global media. */
export function audienceSql(audience: MediaAudience): { sql: string; params: string[] } {
  if (audience.kind !== 'agent') return { sql: '1 = 1', params: [] };
  return { sql: AGENT_SCOPE, params: [audience.agentId] };
}

export function toInfo(row: MediaRow): MediaInfo {
  const tags = json<string[]>(row.tags, []);
  return compact({
    fileId: row.file_id,
    conversationId: opt<string>(row.conversation_id),
    kind: row.kind as MediaKind,
    mime: row.mime,
    name: row.name,
    size: optNumber(row.size),
    width: optNumber(row.width),
    height: optNumber(row.height),
    durationMs: optNumber(row.duration_ms),
    pages: optNumber(row.pages),
    description: opt<string>(row.description),
    tags: tags.length ? tags : undefined,
    describedBy: opt<string>(row.described_by),
    describedAt: optNumber(row.described_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/** FTS5 MATCH from free text: quoted prefix tokens, all required (AND) or any (OR). */
export function matchQuery(text: string, mode: 'all' | 'any'): string | undefined {
  const tokens = searchTokens(text).slice(0, 12);
  if (!tokens.length) return undefined;
  return tokens.map((token) => `"${token.replace(/"/g, '')}"*`).join(mode === 'all' ? ' ' : ' OR ');
}

export class MediaRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(fileId: string): MediaInfo | undefined {
    const row = this.db.get<MediaRow>(`${SELECT} WHERE m.file_id = ?`, [fileId]);
    return row ? toInfo(row) : undefined;
  }

  /** True when the agent may see this row (see the visibility rule in the header). */
  visibleTo(fileId: string, agentId: string): boolean {
    const scope = audienceSql({ kind: 'agent', agentId });
    return Boolean(this.db.get(`SELECT 1 AS ok FROM media m WHERE m.file_id = ? AND ${scope.sql}`, [fileId, ...scope.params]));
  }

  /** Creates the row once (same content again keeps the first row). True when created. */
  insert(media: NewMedia): boolean {
    return this.db.tx(() => {
      const { changes } = this.db.run(
        `INSERT INTO media (file_id, conversation_id, kind, mime, name, width, height, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO NOTHING`,
        [media.fileId, nul(media.conversationId), media.kind, media.mime, media.name, nul(media.width), nul(media.height),
          nul(media.durationMs), media.now, media.now],
      );
      if (changes) this.index(media.fileId);
      return changes > 0;
    });
  }

  /** Links a row that has no chat yet (the first chat a file appears in wins). True when changed. */
  link(fileId: string, conversationId: string, now: number): boolean {
    return this.db.run('UPDATE media SET conversation_id = ?, updated_at = ? WHERE file_id = ? AND conversation_id IS NULL',
      [conversationId, now, fileId]).changes > 0;
  }

  /** Stores measured facts (given fields only). True when a value changed. */
  setFacts(fileId: string, facts: MeasuredFacts, now: number): boolean {
    const given = ([
      ['kind', facts.kind], ['width', facts.width], ['height', facts.height], ['duration_ms', facts.durationMs], ['pages', facts.pages],
    ] as Array<[string, SQLInputValue | undefined]>).filter((entry): entry is [string, SQLInputValue] => entry[1] !== undefined);
    if (!given.length) return false;
    const values = given.map(([, value]) => value);
    return this.db.run(
      `UPDATE media SET ${given.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ?
       WHERE file_id = ? AND (${given.map(([column]) => `${column} IS NOT ?`).join(' OR ')})`,
      [...values, now, fileId, ...values],
    ).changes > 0;
  }

  /** Replaces description + tags; `by` undefined clears the author (nothing written any more). */
  describe(fileId: string, value: { description?: string; tags: string[]; by?: string }, now: number): void {
    this.db.tx(() => {
      this.db.run('UPDATE media SET description = ?, tags = ?, described_by = ?, described_at = ?, updated_at = ? WHERE file_id = ?',
        [nul(value.description), value.tags.length ? toJson(value.tags) : null, nul(value.by), value.by ? now : null, now, fileId]);
      this.index(fileId);
    });
  }

  list(filter: MediaFilter, audience: MediaAudience, limit: number): MediaInfo[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const scope = audienceSql(audience); // F-52
    where.push(scope.sql); params.push(...scope.params);
    if (filter.conversationId) { where.push('m.conversation_id = ?'); params.push(filter.conversationId); }
    if (filter.kind) { where.push('m.kind = ?'); params.push(filter.kind); }
    const text = filter.text?.trim();
    if (!text) return this.rows(where, params, 'm.created_at DESC, m.file_id', limit);

    // All words first; when that finds nothing, any word (ranked), then a plain substring match.
    for (const mode of ['all', 'any'] as const) {
      const match = matchQuery(text, mode);
      if (!match) break;
      const found = this.db.all<MediaRow>(
        `${SELECT} JOIN media_fts ON media_fts.rowid = m.rowid AND media_fts.file_id = m.file_id
          WHERE media_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
          ORDER BY bm25(media_fts, 0.0, 2.0, 1.0, 1.5), m.created_at DESC LIMIT ?`, [match, ...params, limit]);
      if (found.length) return found.map(toInfo);
    }
    const like = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return this.rows([...where, `(m.name LIKE ? ESCAPE '\\' OR m.description LIKE ? ESCAPE '\\')`], [...params, like, like], 'm.created_at DESC, m.file_id', limit);
  }

  /** MM6: deletes the row and its FTS mirror (before the `files` row goes). True when it existed. */
  remove(fileId: string): boolean {
    return this.db.tx(() => {
      this.db.run('DELETE FROM media_fts WHERE rowid = (SELECT rowid FROM media WHERE file_id = ?)', [fileId]);
      return this.db.run('DELETE FROM media WHERE file_id = ?', [fileId]).changes > 0;
    });
  }

  /** MM6: moves a row to another chat (or to none) – used when its chat was deleted but the file stays. */
  relink(fileId: string, conversationId: string | undefined, now: number): boolean {
    return this.db.run('UPDATE media SET conversation_id = ?, updated_at = ? WHERE file_id = ? AND conversation_id IS NOT ?',
      [nul(conversationId), now, fileId, nul(conversationId)]).changes > 0;
  }

  /** MM6: file ids of the rows linked to one chat. */
  fileIdsIn(conversationId: string): string[] {
    return this.db.all<{ file_id: string }>('SELECT file_id FROM media WHERE conversation_id = ?', [conversationId]).map((row) => row.file_id);
  }

  /** MM6: rows still linked to a chat that no longer exists (oldest first, at most `limit`). */
  orphanedLinks(limit: number): string[] {
    return this.db.all<{ file_id: string }>(
      `SELECT m.file_id FROM media m WHERE m.conversation_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id)
       ORDER BY m.created_at LIMIT ?`, [limit]).map((row) => row.file_id);
  }

  private rows(where: string[], params: Array<string | number>, order: string, limit: number): MediaInfo[] {
    return this.db.all<MediaRow>(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, [...params, limit]).map(toInfo);
  }

  /** Rewrites the FTS mirror of one row (folded text; the originals stay in `media`). */
  private index(fileId: string): void {
    const row = this.db.get<{ rowid: number; name: string; description: string | null; tags: string | null }>(
      'SELECT rowid, name, description, tags FROM media WHERE file_id = ?', [fileId]);
    if (!row) return;
    this.db.run('DELETE FROM media_fts WHERE rowid = ?', [row.rowid]);
    const tags = json<string[]>(row.tags, []).join(' ');
    this.db.run('INSERT INTO media_fts (rowid, file_id, name, description, tags) VALUES (?, ?, ?, ?, ?)',
      [row.rowid, fileId, foldText(row.name), foldText(row.description ?? ''), foldText(tags)]);
  }
}
