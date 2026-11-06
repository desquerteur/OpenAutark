// Repository for `feedback` (reports to the developers).
// Owns: SQL and row↔model mapping. A report's repeat `count` is kept in the `context` JSON column
// (key "count", no schema change); the model has it top-level.
// Never: sending reports, deduplicating or rate limiting (FeedbackService).

import { json, toJson, type Db, type Row } from '../db/database.ts';
import type { FeedbackReport } from '../../shared/model/system.ts';
import { compact, nul, opt, optNumber } from './rows.ts';

type StoredContext = FeedbackReport['context'] & { count?: number; receiptId?: string; visibility?: FeedbackReport['visibility']; deliveryWarning?: string };

function toFeedback(row: Row): FeedbackReport {
  const { count, receiptId, visibility, deliveryWarning, ...context } = json<StoredContext>(row.context, { version: '', os: '' });
  return compact({
    id: String(row.id),
    kind: row.kind as FeedbackReport['kind'],
    text: String(row.text),
    author: String(row.author),
    screenshotFileId: opt<string>(row.screenshot_file_id),
    annotationFileId: opt<string>(row.annotation_file_id),
    context,
    count: typeof count === 'number' && count > 1 ? count : undefined,
    receiptId,
    visibility,
    deliveryWarning,
    status: row.status === 'sent' && !receiptId && String(row.url ?? '').includes('/issues/new?') ? 'queued' : row.status as FeedbackReport['status'],
    url: opt<string>(row.url),
    createdAt: Number(row.created_at),
    sentAt: optNumber(row.sent_at),
  });
}

function storedContext(report: FeedbackReport): StoredContext {
  return { ...report.context, ...(report.count && report.count > 1 ? { count: report.count } : {}), ...(report.receiptId ? { receiptId: report.receiptId, visibility: report.visibility, deliveryWarning: report.deliveryWarning } : {}) };
}

export class FeedbackRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): FeedbackReport | undefined {
    const row = this.db.get('SELECT * FROM feedback WHERE id = ?', [id]);
    return row ? toFeedback(row) : undefined;
  }

  list(limit = 100): FeedbackReport[] {
    return this.db.all('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?', [limit]).map(toFeedback);
  }

  /** Reports by one author created at or after `since`, newest first (dedupe and daily cap). */
  byAuthorSince(author: string, since: number, limit = 100): FeedbackReport[] {
    return this.db.all('SELECT * FROM feedback WHERE author = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?', [author, since, limit]).map(toFeedback);
  }

  save(report: FeedbackReport): void {
    this.db.run(
      `INSERT INTO feedback (id, kind, text, author, screenshot_file_id, annotation_file_id, context, status, url, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, text = excluded.text, screenshot_file_id = excluded.screenshot_file_id,
         annotation_file_id = excluded.annotation_file_id, context = excluded.context, status = excluded.status,
         url = excluded.url, sent_at = excluded.sent_at`,
      [
        report.id, report.kind, report.text, report.author, nul(report.screenshotFileId), nul(report.annotationFileId),
        toJson(storedContext(report)), report.status, nul(report.url), report.createdAt, nul(report.sentAt),
      ],
    );
  }
}
