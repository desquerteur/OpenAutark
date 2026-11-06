// SubconsciousImpl: one service around the agents' turns. Its runs (flow.ts: two brains, one loop, the same tools):
// beforeTurn() – a person's message with content (the cheap check, wake.ts) that the main AI has not answered yet, "direkt am Anfang des
// Prompts" (owner 15.10.2026): the turn waits for it, at most BEFORE_WAIT_MS, and what the run finds later waits for the next turn;
// afterTurn() – a finished turn, behind the cheap wake check, debounced per chat (after-turn.ts); ask() – the main AI's own call
// (the subconscious tool), its answer is the tool output. A run's trace waits in kv for the agent's next turn on that thread; beforeTurn()
// hands it over (a note or hit older than a day goes; a turn that never reached its engine puts its
// trace back); a note or hit shown in this thread within the last hour is not shown again (the brains do not see what they showed before). Also verify()
// (a task result against its done-condition) and widgetFor()/fillWidget() (the person's to-do widgets). The decision model is
// the Decisions use, the cheap one; the LLM the strongest model the Work use allows (a route as a working agent, not as the
// runtime). Both are the engines' structured runner, created on first use – none while no model is connected.
// toolTimeout() uses the decision hub directly: seconds suggestions also work on choice-only decision connections.
// Owns: which run happens with which budget, the pending trace and failure isolation. Never: makes a turn wait longer than BEFORE_WAIT_MS,
// starts a run while a tool call waits for its output (one begun before it goes on), judges an agent's answer, or turns memory into instructions.

import type { RouteRequest, RuntimeServices, Router, Subconscious } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Task, TaskResult } from '../../shared/model/tasks.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { capTrace, hasTrace, NOTE_CALL, type SubconsciousTrace, type TraceCall } from '../../shared/model/subconscious.ts';
import { createEngineRunner, type EngineRunnerDeps } from '../decision/engine-runner.ts';
import { bookTurnCost, priceTurn } from '../agents/turn-cost.ts';
import '../contracts/vectors.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { AfterTurnRuns, type TurnEnd } from './after-turn.ts';
import { WORTH_TOKENS } from './context-tools.ts';
import { askContext, type AskContext } from './exchange.ts';
import { runFlow, type FlowBrains, type FlowInput } from './flow.ts';
import { SUBCONSCIOUS_ID } from './tools.ts';
import { verifyResult } from './verify.ts';
import { hasContent, toolWaiting } from './wake.ts';
import { chooseWidget, fillWidget } from './widget.ts';
import { chooseToolTimeout } from './tool-timeout.ts';
import type { ToolTimeoutInput } from '../tools/timeout.ts';

/** The time limit of one helper call (a cold CLI start on a loaded 8 GB PC took up to 200 s to its first request, q2m live 02.11.2026). */
const CALL_MS = 180_000;
/** The main AI's own call. Each step of a CLI that starts a process per call took 20–70 s on the 8 GB reference PC (Claude Code, measured 02.11.2026); the steps bound a run, this only catches a hang. */
export const ASK_MS = 300_000;
const ASK_STEPS = 12;
/** How long a person's message waits for its run: a run that does not look ends in 3–7 s, look and pick took 9–21 s, 10 of 12 within this (Codex on the loaded 8 GB reference PC, q1 02.11.2026; at 10 s the person did not hear a rule the run had found). What comes later waits for the next turn. */
const BEFORE_WAIT_MS = 25_000;
/** The run goes on after the turn stopped waiting and keeps what it finds: like ASK_MS only a hang is caught here (a look and a pick at 24–84 s per step on Claude Code ran into 120 s and the find was lost: q2m, live 02.11.2026). */
const BEFORE_MS = ASK_MS;
const BEFORE_STEPS = 4;
const AFTER_TURN_MS = 300_000;
/** Tidying is one or two steps (the items listed, one call for all of them), keeping a look and a write: more only goes round in circles (live 02.11.2026: 9 of 11 steps saved nothing). */
const AFTER_TURN_STEPS = 8;
const PENDING_NS = 'subconscious_trace';
/** A note or hit is not shown again in a thread for this long (a renewed context may need it again later). */
const SHOWN_MS = 60 * 60_000;
/** A kept note or hit older than this is about something else by now: it is dropped, not shown. */
const KEPT_MS = 24 * 60 * 60_000;
/** The calls that age and are not shown twice: what the flow told or found for the main AI. */
const ABOUT_NOW: ReadonlySet<string> = new Set([NOTE_CALL, 'agent.tell', 'vector.search']); // agent.tell: rows kept before the name changed
const SHOWN_THREADS = 200;
const SHOWN_LINES = 100;
/**
 * What a run with the transcript before it is for. Without these words the cheap model listed the items and ended at once at every turn, also at
 * the limit, so the chat grew to the 64k renewal (q-r1b, 03.11.2026: 21k to 64k in 9 turns, no mark); with them it marked (q1b). No threshold: every run.
 */
const TRANSCRIPT_TASK = "My first step lists the older items of the main AI's transcript: I condense those the current work no longer needs, in one call with their ids (hiding is for what nothing can depend on); what the person said about the transcript comes first.";
/** How many of the lines shown lately a run that keeps things is told, and how much of each: to it they are not new. */
const SHOWN_TOLD = 5;
const SHOWN_LINE_CHARS = 300;
/** The id the LLM's route runs under: an agent's turn for routing (the Work use), not the runtime's (the Decisions use). */
const LLM_AGENT_ID = 'subconscious';

/**
 * The LLM's route: what the runner asks for the decision model, as a working agent that wants the strongest model it may have – the Work model chosen in
 * Settings, else the best of the account (live 02.11.2026: at economy, both brains were the same small model and a route changed nothing). Unless the person chose the cheaper cost mode.
 */
function llmRoute(request: RouteRequest, costMode: string | undefined): RouteRequest {
  return { ...request, mode: { ...request.mode, category: 'chat' }, agent: { ...request.agent, id: LLM_AGENT_ID, modelPolicy: { costMode: costMode === 'economy' ? 'economy' : 'best' } } };
}

export interface SubconsciousDeps {
  services: () => RuntimeServices;
  /** The decision model, also of widget fills (tests); false = none; absent = the engines' runner. */
  runner?: StructuredRunner | false;
  /** The LLM (tests); absent = `runner` when one is given, else the engines' runner on the Work use. */
  llm?: StructuredRunner | false;
  /** How long a chat stays quiet before its run (tests: 0). */
  settleMs?: number;
  /** The longest a chat that never goes quiet waits for its run (tests). */
  maxWaitMs?: number;
  /** How soon a run that met a waiting tool call looks again (tests). */
  toolRetryMs?: number;
  /** How long a turn waits for the run before it (tests). */
  beforeWaitMs?: number;
}

export class SubconsciousImpl implements Subconscious {
  private readonly deps: SubconsciousDeps;
  private engineRunner?: StructuredRunner;
  private llmRunner?: StructuredRunner;
  private readonly after: AfterTurnRuns;
  /** Per agent and thread: the lines of notes and hits shown lately, with their time. */
  private readonly shown = new Map<string, Map<string, number>>();
  /** The agent the newest flow runs for (its model use is booked on it). */
  private running?: string;

  constructor(deps: SubconsciousDeps) {
    this.deps = deps;
    this.after = new AfterTurnRuns({
      services: deps.services, settleMs: deps.settleMs, maxWaitMs: deps.maxWaitMs, toolRetryMs: deps.toolRetryMs,
      keep: (agentId, thread, trace) => this.keepTrace(agentId, thread, trace),
      run: ({ turn, thread, why, context, transcript }) => this.flow({
        kind: 'after-turn', agent: turn.agent, conversationId: turn.conversationId, thread, taskId: turn.taskId, ...(turn.mode ? { mode: turn.mode } : {}),
        task: `woken by ${why.join(', ')}${turn.contextTokens ? `; the main AI's context holds about ${turn.contextTokens} tokens` : ''}${transcript ? `. ${TRANSCRIPT_TASK}` : ''}`,
        context: [context, this.shownLately(`${turn.agent.id}:${thread}`)].filter(Boolean).join('\n\n'), maxSteps: AFTER_TURN_STEPS, budgetMs: AFTER_TURN_MS,
        ...(transcript ? { firstStep: { tool: 'context.list', args: { minTokens: WORTH_TOKENS } } } : {}),
      }),
    });
  }

  verify(task: Task, result: TaskResult): Promise<{ ok: boolean; reason: string; checked: boolean }> {
    return verifyResult(this.deps.services(), task, result);
  }

  toolTimeout(input: ToolTimeoutInput & { agent: Agent; signal: AbortSignal }) {
    return chooseToolTimeout(this.deps.services(), input);
  }

  widgetFor(text: string): Promise<UiBlock> {
    return chooseWidget(this.deps.services(), text);
  }

  fillWidget(block: UiBlock, text: string): Promise<UiBlock> {
    const services = this.deps.services();
    return fillWidget(services, this.decisionRunner(services), block, text);
  }

  afterTurn(input: TurnEnd): void {
    this.after.note(input);
  }

  /** What the agent's turn gets: the trace kept for this thread, after the look at a person's message. Never throws. */
  async beforeTurn(input: { agent: Agent; thread: string; conversationId?: string; taskId?: string; mode?: string; said?: string; signal?: AbortSignal }): Promise<SubconsciousTrace | undefined> {
    await this.lookFirst(input);
    const calls = this.fresh(`${input.agent.id}:${input.thread}`, this.takeTrace(input.agent.id, input.thread)?.calls ?? []);
    return calls.length ? capTrace({ calls }) : undefined;
  }

  /** The run before a turn: only on a person's message with content. The turn goes on after BEFORE_WAIT_MS; the run does too and keeps what it finds. The turn's stop ends it, with what it showed until then. */
  private async lookFirst(input: { agent: Agent; thread: string; conversationId?: string; taskId?: string; mode?: string; said?: string; signal?: AbortSignal }): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const services = this.deps.services();
      if (input.signal?.aborted || !input.said || !hasContent(input.said) || toolWaiting(services, input.agent.id, input.conversationId)) return;
      const run = this.flow({
        kind: 'before-turn', agent: input.agent, conversationId: input.conversationId, thread: input.thread, taskId: input.taskId, ...(input.mode ? { mode: input.mode } : {}),
        context: askContext(services, { agentId: input.agent.id, conversationId: input.conversationId }) || input.said, maxSteps: BEFORE_STEPS, budgetMs: BEFORE_MS,
        ...(input.signal ? { signal: input.signal } : {}),
      }).then((result) => { if (hasTrace(result.trace)) this.keepTrace(input.agent.id, input.thread, result.trace); }, (error) => this.log('subconscious look failed', error));
      await Promise.race([run, new Promise<void>((resolve) => { timeout = setTimeout(resolve, this.deps.beforeWaitMs ?? BEFORE_WAIT_MS); (timeout as { unref?: () => void }).unref?.(); })]);
    } catch (error) {
      this.log('subconscious look failed', error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** A turn that never reached its engine: its trace waits for the next turn on the thread and counts as not shown. Never throws. */
  putBack(agentId: string, thread: string, trace: SubconsciousTrace): void {
    const seen = this.shown.get(`${agentId}:${thread}`);
    for (const call of trace.calls) for (const line of call.output.split('\n')) seen?.delete(line);
    this.keepTrace(agentId, thread, trace);
  }

  /** The person's Forget: a kept trace that mentions it never reaches the main AI. Never throws. */
  forget(match: (text: string) => boolean): void {
    try {
      const { db } = this.deps.services();
      for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM kv WHERE ns = ?', [PENDING_NS])) {
        if (match(row.value)) db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [PENDING_NS, row.key]);
      }
      this.shown.clear();
    } catch (error) {
      this.log('subconscious trace not cleared', error);
    }
  }

  /** The main AI's own call: the same loop with `ask` as the task; the answer is its tool output. Never throws. */
  async ask(input: { agent: Agent; conversationId?: string; thread?: string; taskId?: string; mode?: string; ask: string; context?: AskContext; signal?: AbortSignal }): Promise<string> {
    try {
      const services = this.deps.services();
      const result = await this.flow({
        kind: 'asked', agent: input.agent, conversationId: input.conversationId, thread: input.thread ?? input.conversationId ?? '', taskId: input.taskId, ...(input.mode ? { mode: input.mode } : {}),
        task: input.ask, context: askContext(services, { agentId: input.agent.id, conversationId: input.conversationId, context: input.context }),
        maxSteps: ASK_STEPS, budgetMs: ASK_MS, signal: input.signal,
      });
      if (result.answer) return result.answer;
      if (result.end === 'no-model' || result.end === 'no-prompt') return 'The subconscious cannot answer: no model is connected for it.';
      if (result.end === 'failed' || result.end === 'budget') return 'The subconscious could not answer in time.';
      return 'The subconscious has nothing to add.';
    } catch (error) {
      this.log('subconscious ask failed', error);
      return 'The subconscious could not answer.';
    }
  }

  /** Runs the waiting runs now and resolves when they ended (tests, shutdown). */
  settle(): Promise<void> {
    return this.after.settle();
  }

  private flow(input: FlowInput) {
    const services = this.deps.services();
    this.running = input.agent.id;
    return runFlow(services, this.brains(services), input);
  }

  private brains(services: RuntimeServices): FlowBrains {
    return { decision: this.decisionRunner(services), llm: this.workRunner(services) };
  }

  /** The notes and hits this thread was shown lately, for a run that keeps things: it would take them for new (the main AI's answer repeats them). */
  private shownLately(key: string): string {
    const lines = [...(this.shown.get(key)?.keys() ?? [])].slice(-SHOWN_TOLD).map((line) => (line.length > SHOWN_LINE_CHARS ? `${line.slice(0, SHOWN_LINE_CHARS)} …` : line));
    return lines.length ? `Shown to the main AI from memory before its answer, not new:\n${lines.join('\n')}` : '';
  }

  /** The calls without the note lines and hits this thread was shown lately; a call with nothing new left goes. */
  private fresh(key: string, calls: readonly TraceCall[]): TraceCall[] {
    if (!calls.length) return [];
    let now: number;
    try { now = this.deps.services().clock.now(); } catch { return [...calls]; }
    const seen = this.shown.get(key) ?? new Map<string, number>();
    this.shown.delete(key);
    this.shown.set(key, seen);
    if (this.shown.size > SHOWN_THREADS) this.shown.delete(this.shown.keys().next().value!);
    for (const [line, at] of seen) if (now - at > SHOWN_MS) seen.delete(line);
    const out = calls.flatMap((call) => {
      if (!ABOUT_NOW.has(call.tool)) return [call];
      const lines = call.output.split('\n').filter((line) => !seen.has(line));
      for (const line of lines) seen.set(line, now);
      return lines.length ? [{ ...call, output: lines.join('\n') }] : [];
    });
    while (seen.size > SHOWN_LINES) seen.delete(seen.keys().next().value!);
    return out;
  }

  private keepTrace(agentId: string, thread: string, trace: SubconsciousTrace): void {
    try {
      const { db, clock } = this.deps.services();
      const key = `${agentId}:${thread}`;
      const now = clock.now();
      const held = db.get<{ value: string; updated_at: number }>('SELECT value, updated_at FROM kv WHERE ns = ? AND key = ?', [PENDING_NS, key]);
      const before = held ? (JSON.parse(held.value) as SubconsciousTrace).calls.map((call) => ({ ...call, at: call.at ?? held.updated_at })) : []; // a row of 0.2.9 has no `at`
      const calls = [...before, ...trace.calls.map((call) => ({ ...call, at: call.at ?? now }))];
      db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [PENDING_NS, key, JSON.stringify(capTrace({ calls })), now]);
    } catch (error) {
      this.log('subconscious trace not kept', error);
    }
  }

  private takeTrace(agentId: string, thread: string): SubconsciousTrace | undefined {
    try {
      const { db, clock } = this.deps.services();
      const key = `${agentId}:${thread}`;
      const held = db.get<{ value: string; updated_at: number }>('SELECT value, updated_at FROM kv WHERE ns = ? AND key = ?', [PENDING_NS, key]);
      if (!held) return undefined;
      db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [PENDING_NS, key]);
      const oldest = clock.now() - KEPT_MS;
      const trace = { calls: (JSON.parse(held.value) as SubconsciousTrace).calls.filter((call) => !ABOUT_NOW.has(call.tool) || (call.at ?? held.updated_at) >= oldest) };
      return hasTrace(trace) ? trace : undefined;
    } catch (error) {
      this.log('subconscious trace not read', error);
      return undefined;
    }
  }

  private connected(services: RuntimeServices): boolean {
    try { return services.catalog.list().some((model) => model.available); } catch { return false; }
  }

  private runnerDeps(services: () => RuntimeServices, router: () => Router) {
    return {
      get engines() { return services().engines; },
      get router() { return router(); },
      get accounts() { return services().accounts; },
      get catalog() { return services().catalog; },
      get paths() { return services().paths; },
      get clock() { return services().clock; },
      get notifications() { return services().notifications; },
      timeoutMs: CALL_MS, // the widget fill brings its own shorter signal (widget.ts WIDGET_FILL_MS)
      onUsage: (entry: Parameters<NonNullable<EngineRunnerDeps['onUsage']>>[0]) => this.bookBrain(entry),
    };
  }

  /** A brain's model use on a pay-per-use account, like an agent turn's (nothing for a plan or a local model). */
  private bookBrain(entry: Parameters<NonNullable<EngineRunnerDeps['onUsage']>>[0]): void {
    const services = this.deps.services();
    const cost = priceTurn(services, entry, { usage: entry.usage }, '').run;
    bookTurnCost(services, this.running ?? SUBCONSCIOUS_ID, 'subconscious', cost);
  }

  /** The decision model (the Decisions use): none when nothing is connected (checked on every call). */
  private decisionRunner(services: RuntimeServices): StructuredRunner | undefined {
    if (this.deps.runner === false) return undefined;
    if (this.deps.runner) return this.deps.runner;
    if (!this.connected(services)) return undefined;
    this.engineRunner ??= createEngineRunner(this.runnerDeps(this.deps.services, () => this.deps.services().router));
    return this.engineRunner;
  }

  /** The LLM: the same runner on the LLM's route (llmRoute) – the router then takes the Work use, not the Decisions use. */
  private workRunner(services: RuntimeServices): StructuredRunner | undefined {
    if (this.deps.llm === false) return undefined;
    if (this.deps.llm) return this.deps.llm;
    if (this.deps.runner !== undefined) return this.deps.runner || undefined;
    if (!this.connected(services)) return undefined;
    const router: Router = { route: (request) => { const now = this.deps.services(); return now.router.route(llmRoute(request, now.settings.get().routing.costMode)); } };
    this.llmRunner ??= createEngineRunner(this.runnerDeps(this.deps.services, () => router));
    return this.llmRunner;
  }

  private log(message: string, error: unknown): void {
    try { this.deps.services().log.debug(message, { error: String(error) }); } catch { /* nothing to report to */ }
  }
}
