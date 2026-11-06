// The subconscious after a finished turn. Each turn passes the cheap wake check (wake.ts); only a turn that wakes it arms a
// run. Per agent and chat one run per burst (each agent has its own transcript and limit): the newest turn and the widest message
// range since its last run make one run, once it was quiet for the settle time – or after the longest wait, for a chat that never goes quiet. A task that
// ended, a limit or a planned switch waits only briefly. While a tool call of that agent's turn in the chat waits for its
// output the run waits too, also when its place in the queue comes. All runs go one after another (a run sees what the one before it wrote). Turns that did not wake
// it stay in the range, so a later run sees a bare "ja" beside the proposal it answered. The app's stop runs the waiting ones
// (settle, compose/lifecycle.ts).
// Owns: the timers, the queue, the per-chat cursor and the wake state. Never: blocks, delays or throws into a turn, or keeps
// the process alive.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { hasTrace, type SubconsciousTrace } from '../../shared/model/subconscious.ts';
import { savableTokens } from './context-tools.ts';
import { exchangeText, saidBetween, tidyText } from './exchange.ts';
import type { FlowResult } from './flow.ts';
import { toolWaiting, wakeAfterTurn, type WakeState, type WakeWhy } from './wake.ts';

/** How long a chat stays quiet before its run: a burst of messages and turns costs one run. */
export const SETTLE_MS = 30_000;
/** The longest a chat's run is held back by a chat that never stays quiet. */
export const MAX_WAIT_MS = 5 * 60_000;
/** The quiet time of a wake that should come soon. */
const SOON_MS = 2000;
/** How soon a run that met a waiting tool call looks again. */
const TOOL_RETRY_MS = 5000;
const SOON: ReadonlySet<WakeWhy> = new Set<WakeWhy>(['task-ended', 'limit', 'switch']);

export interface TurnEnd {
  agent: Agent;
  conversationId?: string;
  /** The turn's thread (chat id, `task:<id>`, `src:<source>`); default the chat id. */
  thread?: string;
  taskId?: string;
  /** The turn's run: what it saved itself is named to the run after it. */
  runId?: string;
  /** The turn's mode key. */
  mode?: string;
  fromSeq: number;
  toSeq: number;
  reply: string;
  contextTokens?: number;
  contextWindow?: number;
  taskEnded?: boolean;
  switchPlanned?: boolean;
}

/** What runs one flow for the waiting turn (service.ts). */
export type RunAfterTurn = (input: { turn: TurnEnd; thread: string; why: WakeWhy[]; context: string; transcript: boolean }) => Promise<Pick<FlowResult, 'trace'> | undefined>;

interface Waiting { turn: TurnEnd; thread: string; why: Set<WakeWhy>; replies: string[]; quiet?: ReturnType<typeof setTimeout>; limit?: ReturnType<typeof setTimeout> }

/** A timer that never keeps the process alive. */
function timer(run: () => void, ms: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(run, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

export class AfterTurnRuns {
  private readonly waiting = new Map<string, Waiting>();
  /** Per agent and chat: the last message a run took in. */
  private readonly cursors = new Map<string, number>();
  /** Per agent and chat: where the lines start that no run has seen yet (turns that did not wake it). */
  private readonly unseenFrom = new Map<string, number>();
  private readonly states = new Map<string, WakeState>();
  private queue: Promise<void> = Promise.resolve();
  private readonly services: () => RuntimeServices;
  private readonly run: RunAfterTurn;
  private readonly keep: (agentId: string, thread: string, trace: SubconsciousTrace) => void;
  private readonly settleMs: number;
  private readonly maxWaitMs: number;
  private readonly toolRetryMs: number;

  constructor(deps: { services: () => RuntimeServices; run: RunAfterTurn; keep: (agentId: string, thread: string, trace: SubconsciousTrace) => void; settleMs?: number; maxWaitMs?: number; toolRetryMs?: number }) {
    this.services = deps.services;
    this.run = deps.run;
    this.keep = deps.keep;
    this.settleMs = deps.settleMs ?? SETTLE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
    this.toolRetryMs = deps.toolRetryMs ?? TOOL_RETRY_MS;
  }

  /** A finished turn: the wake check, then (re)arming the chat's run. Returns at once and never throws. */
  note(turn: TurnEnd): void {
    try {
      const thread = turn.thread ?? turn.conversationId ?? '';
      const key = `${turn.agent.id}:${turn.conversationId ?? thread}`;
      const state = this.states.get(key) ?? { turns: 0 };
      const from = Math.min(this.unseenFrom.get(key) ?? turn.fromSeq, turn.fromSeq);
      this.unseenFrom.set(key, from);
      const said = saidBetween(this.services(), turn.agent.id, turn.conversationId, Math.max(turn.fromSeq, this.cursors.get(key) ?? 0), turn.toSeq);
      const savable = savableTokens(this.services(), turn.agent, turn.conversationId);
      const why = wakeAfterTurn({ said, taskId: turn.taskId, taskEnded: turn.taskEnded, switchPlanned: turn.switchPlanned, contextTokens: turn.contextTokens, contextWindow: turn.contextWindow, savable }, state);
      const tokens = turn.contextTokens === undefined ? state.tokens : Math.min(state.tokens ?? turn.contextTokens, turn.contextTokens);
      this.states.set(key, { ...state, turns: state.turns + 1, ...(tokens !== undefined ? { tokens } : {}), ...(turn.taskId ? { taskId: turn.taskId } : {}) });
      const before = this.waiting.get(key);
      if (!why && !before) return; // nothing wakes it; the lines stay for a later run
      if (before?.quiet) clearTimeout(before.quiet);
      const entry: Waiting = {
        turn: before ? { ...turn, fromSeq: Math.min(before.turn.fromSeq, from), toSeq: Math.max(before.turn.toSeq, turn.toSeq) } : { ...turn, fromSeq: from },
        thread,
        why: new Set([...(before?.why ?? []), ...(why ? [why] : [])]),
        replies: [...(before?.replies ?? []), ...(turn.reply.trim() ? [turn.reply.trim()] : [])].slice(-2),
        limit: before?.limit ?? timer(() => this.start(key), this.maxWaitMs),
      };
      entry.quiet = timer(() => this.start(key), [...entry.why].some((item) => SOON.has(item)) ? Math.min(this.settleMs, SOON_MS) : this.settleMs);
      this.waiting.set(key, entry);
    } catch (error) {
      this.log('subconscious run not noted', error);
    }
  }

  /** Runs every waiting run now and resolves when all ended (tests, shutdown). */
  async settle(): Promise<void> {
    for (const key of [...this.waiting.keys()]) this.start(key, true);
    await this.queue;
  }

  private start(key: string, force = false): void {
    const entry = this.waiting.get(key);
    if (!entry) return;
    clearTimeout(entry.quiet);
    if (!force && toolWaiting(this.services(), entry.turn.agent.id, entry.turn.conversationId)) {
      entry.quiet = timer(() => this.start(key), this.toolRetryMs);
      return;
    }
    clearTimeout(entry.limit);
    this.waiting.delete(key);
    this.unseenFrom.delete(key);
    const cursor = this.cursors.get(key) ?? 0;
    this.cursors.set(key, Math.max(cursor, entry.turn.toSeq));
    const tokens = entry.turn.contextTokens ?? this.states.get(key)?.tokens;
    this.states.set(key, { turns: 0, ...(tokens !== undefined ? { tokens } : {}), ...(entry.turn.taskId ? { taskId: entry.turn.taskId } : {}) });
    const turn: TurnEnd = { ...entry.turn, fromSeq: Math.max(entry.turn.fromSeq, cursor), reply: entry.replies.join('\n\n') };
    this.queue = this.queue
      .then(async () => {
        if (!force && toolWaiting(this.services(), turn.agent.id, turn.conversationId)) { this.putBack(key, entry, cursor); return; }
        // Decided at its place in the queue: the run before this one may have taken everything off (live 02.11.2026: 30,615 tokens to save 45).
        const transcript = savableTokens(this.services(), turn.agent, turn.conversationId) > 0;
        const context = (transcript ? tidyText : exchangeText)(this.services(), { agent: turn.agent, conversationId: turn.conversationId, fromSeq: turn.fromSeq, toSeq: turn.toSeq, reply: turn.reply, runId: turn.runId });
        const result = await this.run({ turn, thread: entry.thread, why: [...entry.why], context, transcript });
        if (result && hasTrace(result.trace)) this.keep(turn.agent.id, entry.thread, result.trace);
      })
      .catch((error) => this.log('subconscious run failed', error));
  }

  /** Its place in the queue came while a tool call waits: it waits again with its whole range (a newer waiting run takes it along). */
  private putBack(key: string, entry: Waiting, cursor: number): void {
    this.cursors.set(key, Math.min(this.cursors.get(key) ?? cursor, cursor));
    const newer = this.waiting.get(key);
    if (newer) {
      newer.turn = { ...newer.turn, fromSeq: Math.min(newer.turn.fromSeq, entry.turn.fromSeq) };
      for (const why of entry.why) newer.why.add(why);
      newer.replies = [...entry.replies, ...newer.replies].slice(-2);
      return;
    }
    entry.limit = timer(() => this.start(key), this.maxWaitMs);
    entry.quiet = timer(() => this.start(key), this.toolRetryMs);
    this.waiting.set(key, entry);
  }

  private log(message: string, error: unknown): void {
    try { this.services().log.debug(message, { error: String(error) }); } catch { /* nothing to report to */ }
  }
}
