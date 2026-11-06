// The context ledger as a member of RuntimeServices (merged by module augmentation, like the other
// late additions in this folder; re-exported by ../contracts.ts). Implemented by context/ledger/service.ts.
// Owns: the ContextLedger interface.
// Never: behaviour.

import type { LedgerItem, LedgerKind, LedgerMark, LedgerView, NewLedgerItem } from '../../shared/model/context-ledger.ts';

/** What a turn attempt hands the ledger so the run's journal items become ledger items (context/ledger/capture.ts). */
export interface LedgerRun {
  runId: string;
  agentId: string;
  conversationId: string;
  engine: string;
  /** Catalog model id of the attempt. */
  model: string;
  /** The newest chat message the turn's input shows (RoutedTurn.lastSeq): messages up to it become m items first. */
  seenSeq: number;
  /** What the attempt journals in front of those messages (the subconscious's calls, which the engine's session holds before the input). */
  first?: () => void;
}

export interface RebuildNeed {
  /** First changed order (items before it are held by the native session as the ledger says). */
  since: number;
  /** "2 condensed, 1 hidden, 1 restored since the last rebuild". */
  reason: string;
  /** Addition: tokens the rebuild removes (negative when restores bring more back than marks take out). */
  saves: number;
  /** False when no mark of the subconscious is among the changes: a restore alone only moves its items back into place (its result condensed), it takes nothing off. */
  marked?: boolean;
}

export interface ContextLedger {
  /** Capture: a new item, or – same ref, or an m item's seq again – the existing row (title, tokens and bytes refreshed). */
  record(agentId: string, conversationId: string, item: NewLedgerItem): LedgerItem;
  /** In order; `since`: items whose order is ≥ since (inclusive); `kinds`: only these. */
  items(agentId: string, conversationId: string, opts?: { since?: number; kinds?: LedgerKind[] }): LedgerItem[];
  /** Unknown ids are skipped; the subconscious never marks a pinned item; 'restore' pins for PIN_TURNS turns, or for good with keep (KEEP_PIN, within KEEP_TOKENS per agent and chat); keep: false ends a pin for good; a plain restore never shortens a longer pin. */
  mark(agentId: string, conversationId: string, marks: LedgerMark[]): void;
  /** The full original (undefined: no such item). `pruned`: the original is gone – `text` is what is left (condensed text or title). */
  original(agentId: string, conversationId: string, itemId: string): { text: string; pruned: boolean; args?: string } | undefined;
  /** Items in order with the marks applied – what the next native rebuild contains (hidden items left out). */
  view(agentId: string, conversationId: string): LedgerView;
  /** Addition: the newest `limit` of the subconscious's calls in view form, in order (a stateless engine's next history, context/ledger/marks.ts). */
  traceView?(agentId: string, conversationId: string, limit: number): LedgerView;
  /** Marks the native session does not hold yet; undefined when it holds what the ledger says. */
  needsRebuild(agentId: string, conversationId: string): RebuildNeed | undefined;
  /** A rebuild applied the marks of every item up to order `upTo`. */
  rebuilt(agentId: string, conversationId: string, upTo: number): void;
  /** Addition: a turn attempt starts – messages the turn shows become m items, the run's journal items become ledger items. Never throws. */
  capture?(run: LedgerRun): void;
  /** Addition: the run is being captured – its long tool outputs are worth keeping whole (runs/journal.ts keepOutput, compose). */
  holds?(runId: string): boolean;
  /** Addition: listeners (run items, removed chats) and the bounded start-up retention pass; returns the stop. */
  start?(): () => void;
  /** The person's Forget – titles, condensed texts and mark reasons that `match` read
   *  '[forgotten]', originals that match are pruned and their blobs given back (rpc knowledge.forget). Counts only. */
  forget?(match: (text: string) => boolean): { items: number; originals: number; truncated: boolean };
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** The context ledger (context/ledger/service.ts, compose/services.ts); absent in small fakes. */
    ledger?: ContextLedger;
  }
}

export type { LedgerItem, LedgerKind, LedgerMark, LedgerView, NewLedgerItem };
