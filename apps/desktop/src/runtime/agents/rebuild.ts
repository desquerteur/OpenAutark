// Native rebuild of an agent's session from the context ledger (B-048 E2, back 01.11.2026) – the executor's side, called by
// turn-prepare.ts chooseSession. A turn rebuilds when (a) it runs on another engine than the agent's last turn in
// this chat ('switch'), or the engine has no usable session while the ledger has items ('no_session' – not right
// after a context renewal, the hard backstop, nor in the retry after an ended session's renewal in the same run),
// or (b) the ledger holds marks the session lacks that take something off it, or the session is past its renewal limit ('marks'):
// no minimum saving (q-r, 03.11.2026: with a gate of max(12k tokens, 25 %) the marks of almost every turn reached the session only every
// third turn, and a chat of medium items never). The engine (caps.rebuild) then
// starts a new native session holding the ledger view; the turn binds it and sends only the new chat lines.
// Owns: that choice (the view → RebuildItem mapping is rebuild-items.ts), the one call naming every condensed or hidden item
// when the ledger holds marks (context/ledger/marks.ts; every rebuild is a new session, and a hidden item leaves no other trace;
// placed in front of the agent's closing words), the chat's compaction summary in front when the ledger starts
// after the chat's first line (a chat older than the ledger; B-048 review), the size and shrink guards (a history above
// the renewal limit renews instead), the probe per CLI version (kv 'engine-rebuild-probe':
// model-free, once per version, a failed one again after a day), binding the new session (generation + 1; the
// replaced ref is recorded as superseded by sessions.ts), ledger.rebuilt, the run notes {rebuild: 'native' | 'fallback'},
// and the fallback memory: a rebuilt session that ended on its first turn blocks rebuilds of that chat and engine
// for 6 h (process memory) – the turn renews as today; a rebuild the engine refuses blocks the same way.
// B-049 F7: marks on an engine with caps.revert first keep the session, cut before the turn holding the first change, plus
// the tail (rebuild-revert.ts; note revert: true); any refusal starts a new one as before (note {rebuild: 'revert_fallback'}).
// B-049 F9: a rebuild for marks (same engine) that would not shrink the session – history plus the turn's
// prompt and tools against the context the engine last reported – is skipped (note {rebuild:
// 'skipped', why: 'not smaller than the live context', live, rebuilt}); a switch always rebuilds. A kept probe of an
// older revision (PROBE_REV) runs again once.
// B-054: only a chat thread rebuilds (the ledger is per chat, TurnPlan.thread = the chat id there); the fallback memory is
// keyed by the thread, so a chat-free task or source never meets a chat's block.
// Never: starts a turn, lets a failed rebuild fail the turn, or reads provider files.

import type { RuntimeServices } from '../contracts.ts';
import type { Account, EngineId, RouteDecision } from '../../shared/model/providers.ts';
import type { Engine, RebuildItem, RebuildProbe } from '../engines/types.ts';
import type { LedgerViewItem } from '../../shared/model/context-ledger.ts';
import { historyTokens, rebuildItems } from './rebuild-items.ts'; // B-049 F9: the view → items mapping (nested calls) lives there
import { marksCall, marksOf } from '../context/ledger/marks.ts';
import '../contracts/ledger.ts';
import { KvRepo } from '../store/kv.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { needsRenewal } from './compaction-policy.ts';
import { turnCwd } from '../git/records.ts';
import type { ToolOffer } from './session-key.ts';
import { latestObservation } from '../context/observations.ts';
import { PROJECTION, quoteHeaders } from '../context/projection.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';
import { revertPlan } from './rebuild-revert.ts'; // B-049 F7 (with native-turns.ts)
import { keepTurnsBefore } from './native-turns.ts';

export { rebuildItems };
export const PROBE_NS = 'engine-rebuild-probe';
/** B-049 F9: what a probe checks grew (Codex: custom_tool_call items) – a kept probe of an older revision runs again once. */
export const PROBE_REV = 2;
const PROBE_RETRY_MS = 24 * 60 * 60 * 1000;
const BLOCK_MS = 6 * 60 * 60 * 1000;
const LAST_RUNS = 50;
const MEMORY = 500;

export type RebuildWhy = 'switch' | 'no_session' | 'marks';

/** Process memory: rebuilt sessions until their first turn settled, chats whose rebuild failed, running probes. */
const pending = new Map<string, { runId: string; ref: string }>();
const blocked = new Map<string, number>();
const probing = new Map<string, Promise<RebuildProbe>>();
const probedHere = new Map<string, RebuildProbe>(); // versions the CLI did not name: kept for this process only
const renewedRuns = new Map<string, true>(); // runs whose ended session was renewed: their retry takes today's path

const keyOf = (agentId: string, conversationId: string, engine: EngineId) => `${agentId}|${conversationId}|${engine}`;
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY) map.delete(map.keys().next().value!);
}

/** Forgets the process memory (tests). */
export function resetRebuildMemory(): void {
  pending.clear(); blocked.clear(); probing.clear(); probedHere.clear(); renewedRuns.clear();
}

/** The engine of the agent's last turn in this chat (this run excluded; B-057 S9: never a split's run – its engine is no route memory). */
export function lastEngine(services: Pick<RuntimeServices, 'runs'>, agentId: string, conversationId: string | undefined, runId: string): EngineId | undefined {
  try {
    const runs = services.runs.listTopLevel?.(agentId, LAST_RUNS) ?? services.runs.list(agentId, LAST_RUNS);
    return runs.find((run) => run.id !== runId && !run.splitId && run.conversationId === conversationId && run.engine && run.status !== 'queued')?.engine;
  } catch { return undefined; }
}

/**
 * The call naming every condensed or hidden item the ledger holds (none without marks). Every rebuild starts from the whole view,
 * where a hidden item leaves no trace but this. `since` (the first changed order, 0 without new marks) only names the call.
 */
export function marksItem(services: RuntimeServices, agentId: string, conversationId: string, since: number): RebuildItem | undefined {
  const call = marksCall(marksOf(services, agentId, conversationId));
  return call && { itemId: `marks${since}`, kind: 't', role: 'tool', text: call.output, call: { name: call.tool, args: call.args, callId: `call_context_marks_${since}`, output: call.output } };
}

/**
 * The chat's summary (the latest compaction observation, as today's full projection shows it) in front of the history,
 * when the ledger's chat lines start after the chat's first line: the lines before the ledger (a chat older than it)
 * are known only from that summary. None when the ledger reaches back to the start or there is no summary.
 */
export function summaryItem(services: RuntimeServices, agentId: string, conversationId: string, items: readonly RebuildItem[]): RebuildItem | undefined {
  const first = items.find((item) => item.kind === 'm');
  if (first && Number(first.itemId.slice(1)) <= 1) return undefined;
  const observation = latestObservation(services, conversationId, agentId);
  if (!observation?.body.trim()) return undefined;
  return { itemId: 'summary', kind: 'summary', role: 'user', text: `${PROJECTION.summary}\n${quoteHeaders(observation.body)}` };
}

/**
 * The history with the marks call in front of the agent's closing words (its trailing text, reasoning or own chat
 * lines without a call), so the rebuilt history still ends at the agent's own answer – a clean turn boundary.
 */
export function withMarks(items: RebuildItem[], marks: RebuildItem | undefined): RebuildItem[] {
  if (!marks) return items;
  let at = items.length;
  while (at > 0 && items[at - 1].role === 'assistant' && !items[at - 1].call) at--;
  return [...items.slice(0, at), marks, ...items.slice(at)];
}

/** The probe of `engine`'s rebuild for its CLI version: kv per version; a failed one again after a day; one at a time. */
export async function probeFor(services: RuntimeServices, engine: Engine, account: Account, cwd: string): Promise<RebuildProbe> {
  const now = services.clock.now();
  if (!engine.probeRebuild) return { version: 'none', ok: true, at: now };
  const version = (await engine.rebuildVersion?.(account).catch(() => undefined)) ?? 'unknown';
  const key = `${engine.id}@${version}`;
  const kv = new KvRepo(services.db);
  const cached = version === 'unknown' ? probedHere.get(key) : kv.get<RebuildProbe & { rev?: number }>(PROBE_NS, key);
  if (cached && (cached as { rev?: number }).rev === PROBE_REV && (cached.ok || now - cached.at < PROBE_RETRY_MS)) return cached;
  let running = probing.get(key);
  if (!running) {
    running = engine.probeRebuild(account, cwd).then((probe) => {
      const kept = { ...probe, version: probe.version || version, at: services.clock.now(), rev: PROBE_REV };
      if (version === 'unknown') remember(probedHere, key, kept);
      else kv.set(PROBE_NS, key, kept, services.clock.now());
      services.log.info('rebuild probe', { engine: engine.id, version, ok: kept.ok, ...(kept.reason ? { reason: kept.reason } : {}) });
      return kept;
    }).finally(() => probing.delete(key));
    probing.set(key, running);
  }
  return running;
}

/**
 * B-049 F9 guard: a rebuild for marks on the same engine must shrink the session – the rebuilt history plus the turn's
 * prompt and tool definitions below the context the engine last reported for the session (`live`). Unknown when the
 * engine reported none.
 */
export function shrinks(live: number | undefined, history: number, overhead: number): { ok: boolean; live?: number; rebuilt: number } {
  const rebuilt = history + overhead;
  if (!live || live <= 0) return { ok: true, rebuilt };
  return { ok: rebuilt < live, live, rebuilt };
}

/** The turn's prompt sections and native tool definitions in tokens (the rebuilt session starts with them). */
function overheadTokens(input: Pick<NativeRebuildInput, 'prompt' | 'offer'>): number {
  let tools = 0;
  try { tools = (JSON.stringify(input.offer.native ?? []) ?? '').length; } catch { tools = 0; }
  return Math.ceil((input.prompt.stable.length + input.prompt.volatile.length + tools) / 4);
}

function note(services: RuntimeServices, runId: string, data: Record<string, unknown>): void {
  try { services.runs.item(runId, { kind: 'note', data, effectStatus: 'none' }); } catch { /* journal only */ }
}

/**
 * An earlier rebuild of this chat and engine settles: its turn finished (fine), or its session is gone before
 * one did (the engine reported it ended) – then rebuilds of this chat and engine wait 6 h and the run notes it.
 */
function settle(services: RuntimeServices, key: string, session: SessionBinding | undefined, runId: string): void {
  const entry = pending.get(key);
  if (!entry || entry.runId === runId) return;
  const status = services.runs.get(entry.runId)?.status;
  if (status === 'running' || status === 'queued') return;
  pending.delete(key);
  if (status === 'done' || session?.ref === entry.ref) return;
  remember(blocked, key, services.clock.now() + BLOCK_MS);
  note(services, runId, { rebuild: 'fallback', reason: 'first_turn_error', of: entry.runId });
}

/**
 * renewSession's hook for a session that ended in this run (overflow): the run's retry renews as today (no
 * rebuild); when this run had rebuilt that session, its first turn failed – note the fallback and block rebuilds
 * of the chat and engine for a while.
 */
export function rebuildFellBack(services: RuntimeServices, agentId: string, thread: string | undefined, engine: EngineId, runId: string): boolean {
  remember(renewedRuns, runId, true);
  const key = keyOf(agentId, thread ?? '', engine);
  if (pending.get(key)?.runId !== runId) return false;
  pending.delete(key);
  remember(blocked, key, services.clock.now() + BLOCK_MS);
  note(services, runId, { rebuild: 'fallback', reason: 'first_turn_error' });
  return true;
}

export interface NativeRebuildInput {
  plan: TurnPlan;
  request: TurnRequest;
  engine: Engine;
  account: Account;
  route: RouteDecision;
  /** Provider model id of the turn. */
  model: string;
  /** The usable binding of this engine and account (none after a renewal or for another account). */
  session?: SessionBinding;
  offer: ToolOffer;
  /** The turn's prompt as the engine gets it (the volatile part as buildTurn ends it). */
  prompt: { stable: string; volatile: string };
  promptKey: string;
  contextWindow?: number;
  /** The renewal this choice made first ('context' – the hard backstop – never rebuilds). */
  renewed?: 'context' | 'mode' | 'prompt';
  /** The session is past its renewal limit: any marks are worth a rebuild, the renewal only follows when they do not bring it down. */
  overLimit?: boolean;
}

/** Rebuilds the turn's native session from the ledger when one of the cases holds; undefined: today's path. */
export async function nativeRebuild(services: RuntimeServices, input: NativeRebuildInput): Promise<{ session: SessionBinding; sinceSeq: number } | undefined> {
  const { plan, request, engine, account, session } = input;
  const conversationId = plan.conversationId;
  const ledger = services.ledger;
  if (!conversationId || !engine.caps.rebuild || !engine.rebuild || !ledger || input.renewed === 'context' || renewedRuns.has(request.runId)) return undefined;
  const agentId = plan.agent.id;
  const key = keyOf(agentId, conversationId, engine.id);
  settle(services, key, session, request.runId);
  if ((blocked.get(key) ?? 0) > services.clock.now()) return undefined;

  const last = lastEngine(services, agentId, conversationId, request.runId);
  let need: ReturnType<typeof ledger.needsRebuild>;
  try { need = ledger.needsRebuild(agentId, conversationId); } catch { need = undefined; }
  // A restore alone reaches the main AI as a call and moves its items back into place (its result condensed, context/ledger/capture.ts):
  // it rides along with the next marks of the subconscious, and both count (q-r2d s15: a restore made in a script kept its result in full, so
  // it counted as a cost only and held back the hides).
  const worth = input.overLimit || (need?.marked !== false && (need?.saves ?? 0) > 0);
  const why: RebuildWhy | undefined = last && last !== engine.id ? 'switch' : !session ? 'no_session' : need && worth ? 'marks' : undefined;
  if (!why) return undefined;
  const fallback = (reason: string) => { note(services, request.runId, { rebuild: 'fallback', why, reason }); return undefined; };

  let split: ReturnType<typeof rebuildItems>;
  let entries: LedgerViewItem[] = [];
  try { entries = ledger.view(agentId, conversationId); split = rebuildItems(entries, plan.memberCursor); } catch (error) { return fallback(`ledger: ${String(error).slice(0, 120)}`); }
  if (!split.items.length) return undefined; // nothing of the agent's own work to replay: today's path
  const marks = marksItem(services, agentId, conversationId, need?.since ?? 0);
  let summary: RebuildItem | undefined;
  try { summary = summaryItem(services, agentId, conversationId, split.items); } catch { summary = undefined; }
  const items = withMarks(summary ? [summary, ...split.items] : split.items, marks);
  const tokens = historyTokens(items);
  if (needsRenewal(tokens, input.contextWindow)) return fallback('too_large');
  if (why === 'marks') { // B-049 F9: compaction never makes the session bigger
    const guard = shrinks(session?.contextTokens, tokens, overheadTokens(input));
    if (!guard.ok) { note(services, request.runId, { rebuild: 'skipped', why: 'not smaller than the live context', live: guard.live, rebuilt: guard.rebuilt }); return undefined; }
  }

  const cwd = turnCwd(services, plan.task, agentId);
  const probe = await probeFor(services, engine, account, cwd).catch((error): RebuildProbe => ({ version: 'unknown', ok: false, reason: String(error).slice(0, 120), at: services.clock.now() }));
  if (!probe.ok) return fallback(`probe ${probe.version}: ${probe.reason ?? 'failed'}`);

  const store = new SessionStore(services.db);
  const previous = session ?? store.get(agentId, conversationId, engine.id);
  let result: Awaited<ReturnType<NonNullable<Engine['rebuild']>>> | undefined;
  const base = {
    runId: request.runId, agentId, account, model: input.model, cwd, items, tools: input.offer.native, toolNames: input.offer.names,
    system: input.prompt, generation: (previous?.generation ?? 0) + 1, probe,
  };
  // B-049 F7: marks on an engine that can revert keep the session and its prompt cache (rebuild-revert.ts); any refusal starts a new one.
  const turnKey = { agentId, conversationId, engine: engine.id };
  const revert = why === 'marks' && session && engine.caps.revert ? revertPlan(services, turnKey, session.ref, need?.since ?? 0, entries, split.items) : undefined;
  if (revert && session) {
    try { result = await engine.rebuild({ ...base, items: withMarks(revert.items, marks), revert: { ref: session.ref, beforeTurn: revert.turn } }); } catch (error) {
      note(services, request.runId, { rebuild: 'revert_fallback', reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
    }
  }
  const reverted = result !== undefined;
  if (!result) {
    try { result = await engine.rebuild(base); } catch (error) {
      remember(blocked, key, services.clock.now() + BLOCK_MS); // not again every turn: each try starts and deletes a session
      return fallback(error instanceof Error ? error.message.slice(0, 200) : 'failed');
    }
  }
  const binding: SessionBinding = {
    agentId, conversationId, engine: engine.id, accountId: account.id, ref: result.ref, generation: result.generation, cursorSeq: split.sinceSeq,
    contextTokens: tokens, model: input.route.modelId, promptKey: input.promptKey, mode: plan.mode.key, updatedAt: services.clock.now(),
  };
  store.save(binding);
  if (reverted && revert) keepTurnsBefore(services.db, turnKey, result.ref, revert.turn, services.clock.now()); // B-049 F7: the cut turns are gone
  try {
    const upTo = ledger.items(agentId, conversationId).reduce((max, item) => Math.max(max, item.order), 0);
    if (upTo > 0) ledger.rebuilt(agentId, conversationId, upTo);
  } catch (error) { services.log.warn('marking the ledger rebuilt failed', { agentId, error: String(error) }); }
  remember(pending, key, { runId: request.runId, ref: result.ref });
  note(services, request.runId, {
    rebuild: 'native', why, engine: engine.id, items: result.items, generation: result.generation, tokens,
    ...(last && last !== engine.id ? { from: last } : {}), ...(marks ? { marks: true } : {}), ...(probe.tier ? { tier: probe.tier } : {}),
    ...(reverted && revert ? { revert: true, fromOrder: revert.from } : {}),
  });
  return { session: binding, sinceSeq: split.sinceSeq };
}
