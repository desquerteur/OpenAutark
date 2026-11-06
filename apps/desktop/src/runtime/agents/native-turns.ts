// The native turn of each run on a session (B-049 F7): Codex names every turn (turn/start's id); a rebuild for marks
// can then cut the thread before the turn that holds the first changed ledger item (thread/revert keeps the prefix
// and its prompt cache – measured 28.10.: 15,488 of 15,705 input tokens cached after revert + inject, 0 on a fresh
// thread holding the same items) instead of starting a new thread (agents/rebuild-revert.ts).
// Owns: kv 'native-turns' – per (agent, chat, engine) the bound ref and its runs' turn ids in order, at most
// MAX_TURNS (the oldest go first); another ref starts the list anew; a revert drops the cut turns.
// Never: decides a rebuild, talks to an engine, or keeps anything but ids.

import type { Db } from '../db/database.ts';
import type { EngineId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';

export const NATIVE_TURNS_NS = 'native-turns';
export const MAX_TURNS = 300;

export interface NativeTurn { runId: string; turn: string }
interface Stored { ref: string; turns: NativeTurn[] }
export interface TurnKey { agentId: string; conversationId: string; engine: EngineId }

const keyOf = (key: TurnKey) => `${key.agentId}|${key.conversationId}|${key.engine}`;

function read(db: Db, key: TurnKey): Stored | undefined {
  const stored = new KvRepo(db).get<Stored>(NATIVE_TURNS_NS, keyOf(key));
  return stored && typeof stored.ref === 'string' && Array.isArray(stored.turns) ? stored : undefined;
}

/** Records `turn` as `runId`'s turn on `ref` (once per run and turn; a new ref starts the list anew). Never throws. */
export function recordTurn(db: Db, key: TurnKey, ref: string, runId: string, turn: string, at: number): void {
  try {
    const stored = read(db, key);
    const turns = stored?.ref === ref ? stored.turns : [];
    if (turns.some((entry) => entry.turn === turn)) return;
    new KvRepo(db).set(NATIVE_TURNS_NS, keyOf(key), { ref, turns: [...turns, { runId, turn }].slice(-MAX_TURNS) }, at);
  } catch { /* bookkeeping only: without it a rebuild starts a new session */ }
}

/** The recorded turns on `ref`, oldest first ([] for another ref or nothing recorded). */
export function turnsOn(db: Db, key: TurnKey, ref: string): NativeTurn[] {
  try {
    const stored = read(db, key);
    return stored?.ref === ref ? stored.turns : [];
  } catch { return []; }
}

/** After a revert of `ref` before `turn`: that turn and every later one are gone from the session. */
export function keepTurnsBefore(db: Db, key: TurnKey, ref: string, turn: string, at: number): void {
  try {
    const turns = turnsOn(db, key, ref);
    const cut = turns.findIndex((entry) => entry.turn === turn);
    if (cut < 0) return;
    new KvRepo(db).set(NATIVE_TURNS_NS, keyOf(key), { ref, turns: turns.slice(0, cut) }, at);
  } catch { /* bookkeeping only */ }
}
