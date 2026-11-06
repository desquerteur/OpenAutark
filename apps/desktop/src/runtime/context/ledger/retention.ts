// Retention of the ledger's originals (B-048 E1). Only originals kept in a blob for the ledger (tool, skill and
// file outputs over 4,000 characters) are pruned; chat messages, reasoning and own text live in the chat and the
// run journal and follow their retention. Per (agent, chat) the originals of condensed and hidden items are kept
// within 64 MB – the oldest hidden ones go first, then the oldest condensed – but never before 14 days after
// the item was condensed or hidden: the 14-day promise wins over the size cap (a chat that hides more than 64 MB
// within 14 days stays over it until those originals turn 14 days old). Kept items are never pruned (a rebuild
// needs them). A pruned row keeps its title and condensed text; its blob goes back to the store's clean-up
// (files/cleanup.ts decides – a message or memory using the same bytes keeps it), unless another unpruned ledger
// row holds the same bytes. Runs after every mark, at start (bounded) and when a chat is removed – no timers.
// Owns: the budget, the floor, the order and the pruning. Never: deletes a blob itself or prunes a kept item.

import type { FileStore, Logger } from '../../contracts.ts';
import { reclaimerOf } from '../../files/cleanup.ts';
import type { Db } from '../../db/database.ts';
import { blobIdsOf, journalRow } from './originals.ts';
import type { LedgerRow, LedgerStore } from './store.ts';

export const RETENTION_BYTES = 64 * 1024 * 1024;
export const RETENTION_FLOOR_MS = 14 * 24 * 60 * 60_000;
/** (agent, chat) pairs the start-up pass looks at. */
const START_PAIRS = 50;

export interface RetentionDeps {
  db: Db;
  store: LedgerStore;
  files: FileStore | undefined;
  log?: Logger;
  now(): number;
  /** Tests: smaller budget. */
  budget?: number;
}

/** The blob ids of a row's original (via its journal row). */
export function rowBlobs(db: Db, row: LedgerRow): string[] {
  if (!row.ref?.startsWith('item:')) return [];
  const item = journalRow(db, row.ref.slice(5));
  return item ? blobIdsOf(item.data) : [];
}

/** Hands blobs to the store's clean-up, except those another unpruned ledger row still holds (also forget.ts). */
export function giveBack(deps: RetentionDeps, ids: string[], row: LedgerRow): number {
  const free = [...new Set(ids)].filter((id) => !deps.store.blobHeldElsewhere(id, row));
  if (!free.length) return 0;
  const reclaimer = reclaimerOf(deps.files);
  if (reclaimer) reclaimer.reclaim(free);
  return free.length;
}

/** Prunes the oldest originals of one agent's chat until it is within the budget; returns how many went. */
export function prune(deps: RetentionDeps, agentId: string, conversationId: string): number {
  const budget = deps.budget ?? RETENTION_BYTES;
  let held = deps.store.heldBytes(agentId, conversationId);
  if (held <= budget) return 0;
  const now = deps.now();
  let count = 0;
  for (const row of deps.store.pruneCandidates(agentId, conversationId, now - RETENTION_FLOOR_MS)) {
    if (held <= budget) break;
    const blobs = rowBlobs(deps.db, row);
    deps.store.pruned(row, now);
    held -= Number(row.bytes);
    count++;
    giveBack(deps, blobs, row);
  }
  if (count) deps.log?.info('context ledger: originals pruned', { agentId, conversationId, count });
  return count;
}

/** The bounded start-up pass: every (agent, chat) over the budget. */
export function pruneAll(deps: RetentionDeps): number {
  let count = 0;
  for (const pair of deps.store.overBudget(deps.budget ?? RETENTION_BYTES, START_PAIRS)) count += prune(deps, pair.agent_id, pair.conversation_id);
  return count;
}

/** A removed chat: its rows go and the blobs they held go back to the store's clean-up. */
export function forgetChat(deps: RetentionDeps, conversationId: string): number {
  const held = deps.store.removeChat(conversationId);
  let given = 0;
  for (const row of held) given += giveBack(deps, rowBlobs(deps.db, row), row);
  return given;
}
