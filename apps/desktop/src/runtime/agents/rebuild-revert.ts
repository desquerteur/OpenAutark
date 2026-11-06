// The cache-friendly rebuild (B-049 F7), used by agents/rebuild.ts for marks on an engine that can revert
// (caps.revert – Codex): instead of a new session holding the whole ledger view (a new Codex thread has a new prompt
// cache key: nothing of it is cached, not even our prompt and tools), the bound session is cut before the native
// turn of the run that captured the first changed ledger item and only the tail from that run on is added again –
// the prefix keeps its prompt cache. Measured 28.10. (codex-cli 0.164, gpt-6.1-sol, lean thread, Manager prompt,
// 12 tools): after revert + inject 15,488 of 15,705 input tokens were cached; a fresh thread with the same
// injected items 0 of 15,705.
// Owns: the plan – which recorded turn (agents/native-turns.ts) and which history items form the tail.
// Never: talks to an engine, starts a session or a turn, or plans a cut before what the session really holds
// (a change before its recorded turns – e.g. in a history injected when it was started – gives no plan).

import type { RuntimeServices } from '../contracts.ts';
import type { RebuildItem } from '../engines/types.ts';
import type { LedgerViewItem } from '../../shared/model/context-ledger.ts';
import { turnsOn, type TurnKey } from './native-turns.ts';

export interface RevertPlan {
  /** The native turn to cut before (it and every later turn go). */
  turn: string;
  /** The history from that turn's run on, in order (without the marks call – rebuild.ts places it). */
  items: RebuildItem[];
  /** The first ledger order the tail holds. */
  from: number;
}

/**
 * The revert for a marks rebuild: `since` is the ledger's first changed order, `ref` the bound session, `view` the
 * ledger view and `items` the history rebuild.ts made of it (lines the turn's delta carries already left out).
 * The run that captured the item at `since` must have a recorded turn on `ref`; the tail is every history item
 * from the first ledger order of that run or any later one recorded on `ref`. None otherwise.
 */
export function revertPlan(
  services: Pick<RuntimeServices, 'db' | 'ledger'>, key: TurnKey, ref: string, since: number,
  view: readonly LedgerViewItem[], items: readonly RebuildItem[],
): RevertPlan | undefined {
  if (!since || !services.ledger) return undefined;
  const turns = turnsOn(services.db, key, ref);
  if (!turns.length) return undefined;
  let rows;
  try { rows = services.ledger.items(key.agentId, key.conversationId); } catch { return undefined; }
  const changed = rows.filter((row) => row.order >= since).sort((a, b) => a.order - b.order)[0];
  if (!changed?.runId) return undefined;
  const at = turns.findIndex((entry) => entry.runId === changed.runId);
  if (at < 0) return undefined;
  const cutRuns = new Set(turns.slice(at).map((entry) => entry.runId));
  const from = Math.min(...rows.filter((row) => row.runId !== undefined && cutRuns.has(row.runId)).map((row) => row.order));
  if (!Number.isFinite(from) || from > since) return undefined;
  const tail = new Set(view.filter((entry) => entry.order >= from).map((entry) => entry.itemId));
  return { turn: turns[at].turn, items: items.filter((item) => tail.has(item.itemId)), from };
}
