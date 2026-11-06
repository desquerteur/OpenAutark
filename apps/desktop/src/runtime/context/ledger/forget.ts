// The context ledger's part of the person's "Forget permanently" (rpc knowledge.forget). The ledger holds copies of its
// own – titles, condensed texts and mark reasons – and a tool output over 4,000 characters is whole only in a blob
// (runs/journal.ts outputBlob, over 24,000 also the registry's blobIds). Without this step a forgotten fact came back
// through context.restore or a native rebuild (agents/rebuild.ts). Here, per ledger row (newest first, bounded):
//  - a title, condensed text or mark reason that mentions it reads '[forgotten]';
//  - an original that mentions it (the run item's data, its call's arguments or its blob) is pruned: the row says so on a restore,
//    a rebuild replays neither its output nor its arguments (view.ts), the run item no longer names the blob (json_remove – the clean-up's delay never lets it be read again) and the blob
//    goes back to the store's clean-up (files/cleanup.ts decides; another unpruned ledger row with the same bytes keeps it).
// Chat messages stay (the chat is the original). The match rule is the caller's
// (privacy/mentions.ts), so the ledger never sees the forgotten text itself.
// Owns: that selection and those updates. Never: deletes rows or chat messages, logs text, or reads more than
// FORGET_BLOB_READS blobs of FORGET_BLOB_CHARS each per Forget (an older remainder is reported as truncated).

import type { Db } from '../../db/database.ts';
import { blobIdsOf, callRow, journalRow, readBlob } from './originals.ts';
import { giveBack, type RetentionDeps } from './retention.ts';
import type { LedgerRow } from './store.ts';

export const LEDGER_FORGOTTEN = '[forgotten]';
export const FORGET_BLOB_READS = 2000;
export const FORGET_BLOB_CHARS = 1_000_000;
const PAGE = 500;

export interface LedgerForget {
  /** Rows whose copies were cleared or whose original was pruned. */
  items: number;
  /** Originals pruned (their blobs handed to the clean-up). */
  originals: number;
  /** More blob-backed originals than FORGET_BLOB_READS: the oldest were not searched. */
  truncated: boolean;
}

/** Does the original behind `row` mention it (the run item's own data or a blob it names)? Its blob ids either way. */
function originalMentions(deps: RetentionDeps, row: LedgerRow, match: (text: string) => boolean, budget: { reads: number; truncated: boolean }): { hit: boolean; blobs: string[]; itemId?: string } {
  if (row.pruned_at !== null || !row.ref?.startsWith('item:')) return { hit: false, blobs: [] };
  const item = journalRow(deps.db, row.ref.slice(5));
  if (!item) return { hit: false, blobs: [] };
  const blobs = blobIdsOf(item.data);
  const call = typeof item.data.callId === 'string' ? callRow(deps.db, item.run_id, item.data.callId) : undefined;
  if (match(JSON.stringify(item.data)) || (call && match(JSON.stringify(call.data)))) return { hit: true, blobs, itemId: item.id };
  for (const id of blobs) {
    if (budget.reads >= FORGET_BLOB_READS) { budget.truncated = true; break; }
    budget.reads++;
    const read = readBlob(deps.files, id, FORGET_BLOB_CHARS);
    if (read && match(read.text)) return { hit: true, blobs, itemId: item.id };
  }
  return { hit: false, blobs };
}

/** The run item no longer names its blobs (the ledger's and the registry's), so nothing reads them again. */
function dropBlobRefs(db: Db, itemId: string): void {
  db.run(`UPDATE run_items SET data = json_remove(data, '$.outputBlob', '$.blobIds') WHERE id = ? AND json_valid(data)`, [itemId]);
}

/** Clears the ledger's copies of a forgotten fact and prunes the originals that hold it (see header). */
export function forgetInLedger(deps: RetentionDeps, match: (text: string) => boolean): LedgerForget {
  const now = deps.now();
  const budget = { reads: 0, truncated: false };
  let items = 0;
  let originals = 0;
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = deps.db.all<LedgerRow & { rid: number }>(`SELECT rowid AS rid, * FROM context_items WHERE rowid < ? ORDER BY rowid DESC LIMIT ${PAGE}`, [before]);
    if (!page.length) break;
    for (const row of page) {
      const title = match(row.title);
      const condensed = row.condensed !== null && match(row.condensed);
      const reason = row.mark_reason !== null && match(row.mark_reason);
      const original = originalMentions(deps, row, match, budget);
      if (!title && !condensed && !reason && !original.hit) continue;
      deps.db.run(
        `UPDATE context_items SET title = ?, condensed = ?, mark_reason = ?, pruned_at = coalesce(pruned_at, ?) WHERE agent_id = ? AND conversation_id = ? AND item_id = ?`,
        [title ? LEDGER_FORGOTTEN : row.title, condensed ? LEDGER_FORGOTTEN : row.condensed, reason ? LEDGER_FORGOTTEN : row.mark_reason,
          original.hit ? now : null, row.agent_id, row.conversation_id, row.item_id],
      );
      if (original.hit) {
        if (original.itemId) dropBlobRefs(deps.db, original.itemId);
        if (original.blobs.length) giveBack(deps, original.blobs, row);
        originals++;
      }
      items++;
    }
    before = Number(page[page.length - 1].rid);
    if (page.length < PAGE) break;
  }
  if (items) deps.log?.info('context ledger: forgotten', { items, originals, truncated: budget.truncated }); // counts only
  return { items, originals, truncated: budget.truncated };
}
