// The turn executor: one agent turn from wake to integrated result.
//   plan (agent, mode, task, the subconscious's trace, previous model) → route (without images when no model can
//   read them) → session/prompt/input (a session whose prompt key – stable prompt + offered
//   tools – no longer matches, e.g. after a mode switch, is renewed first; SES2) →
//   run journal + streaming message → engine attempt → session renewal once when the native
//   session cannot continue (context full, thread gone; another folder, details.folder: quietly)
//   → the account learns what the attempt says about it (always, also after tool calls) →
//   failover once on limit/unavailable (renewal only when no tool ran; failover also after tool calls whose effects are all known – PR3: the
//   continuation gets them as "Previous attempt"; finish then judges and books both attempts:
//   tools, plan, tokens and cost – mergeAttempts) → finish (message, blocks, cursor, ownership …)
//   → the engine-reported context window is kept with the session. A turn that cannot start
//   (routing or preparation failed) ends as a failed run; for a task, no model or account to run
//   on is the ownership outcome 'unavailable' and a limit 'limit' (no stall), anything else
//   'failed' – an outage of a task leaves one quiet line per outage, no failed bubble (T06); an
//   outage of a chat turn without a task is noted for one automatic re-delivery (B-044, redelivery.ts).
// Owns: the phase order, run start, switch/renewal status lines (a switch says why – wording in
// switch-line.ts, RT5; judged against the chat's last turn, so the agent's own model.set request
// and the return after it are switches too, RT2), the renewal retry, failover and recording
// the account consequence of every failed attempt (the rules – limit → cooling, a signed-out plan →
// needs_login plus one notification, CLI missing → error, else a short cooling – live in
// accounts/failure.ts, shared with helper calls).
// B-047 D4: the run's status lines carry meta.fromRun. B-075: every run of a chat the agent is in gets its row – the live
// status (meta.live, chat/live-row.ts) every device renders; where publishing is not the default (plan.publish
// 'internal', agents/publishing.ts) a silent one that goes at the end unless the finish posts the answer.
// B-048 E4.5: bindTurn reports what the turn runs on after every (re)build (the activity's model fields).
// B-054: the run row carries the plan's origin (what started it); session and repair-note bookkeeping use plan.thread.
// B-057: a split's turn (request.split, on its own dispatcher lane) runs the same phases on its thread `split:<id>`
// (agents/split-turn.ts); its run row names the split, and a split run that fails before its engine tells the split service;
// its session renewal starts fresh with the brief (no second seed from the parent).
// Never: runs two turns on one lane (the dispatcher guarantees that), retries a turn whose tool
// effects are unknown, keeps a session that cannot continue, or swallows a failure silently
// (run error; a failed message where the turn streams one or fails before the engine).

import type { RuntimeServices } from '../contracts.ts';
import type { Effort, RouteDecision } from '../../shared/model/providers.ts';
import { ROUTE_BY_REQUEST, type Run } from '../../shared/model/runs.ts';
import { toErrorData, type WorkforceErrorData } from '../../shared/errors.ts';
import type { StatusLine } from '../../shared/model/chat.ts';
import { buildTurn, planTurn, renewSession, routeRequest, visionUnavailable, withoutImages } from './turn-prepare.ts';
import { canFailover, runAttempt } from './turn-attempt.ts';
import { effectsKnown } from '../context/recent-actions.ts';
import { errorOutcome, finishTurn, takeRepairNotes } from './turn-finish.ts';
import { SessionStore } from './sessions.ts';
import { accountFailure, recordAccountFailure } from '../accounts/failure.ts';
import { isOutage } from './outages.ts';
import { outageLine } from './outage-line.ts';
import { noteChatOutage } from './redelivery.ts';
import { failoverText } from './switch-line.ts';
import { routeLines } from './route-line.ts';
import { splitTurnFailed } from './split-turn.ts'; // B-057
import { addCache } from '../engines/shared.ts';
import type { AttemptResult, RoutedTurn, TurnOutcome, TurnPlan, TurnRequest } from './turn-types.ts';

/** Runs looked at for the chat's last turn (the return rule's window). */
const SWITCH_WINDOW = 50;

/** The engine says its native session cannot continue (context window full, thread gone). */
export function sessionEnded(attempt: AttemptResult): boolean {
  return attempt.result.stop === 'error' && attempt.result.error?.details?.rebase === true;
}

/**
 * The switch line's base: plan.previous – unless a model.set request (RT2, the target, not the base)
 * shapes this turn or shaped the chat's last one: then what that last done turn ran on (none: no line).
 */
export function switchedFrom(services: Pick<RuntimeServices, 'runs' | 'log'>, plan: Pick<TurnPlan, 'agent' | 'conversationId' | 'previous'>): { modelId: string; effort: Effort; requested?: boolean } | undefined {
  const previous = plan.previous;
  let last: Run | undefined;
  try { last = services.runs.list(plan.agent.id, SWITCH_WINDOW).find((run) => !run.splitId && run.conversationId === plan.conversationId && run.model && run.status === 'done'); } catch (error) { // B-057: never a split's run
    services.log.warn('reading the last turn failed', { agentId: plan.agent.id, error: String(error) });
  }
  const requested = last?.route?.by === ROUTE_BY_REQUEST; // the return after a request
  if (!previous?.explicit && !requested) return previous;
  return last?.model ? { modelId: last.model, effort: last.effort ?? 'medium', requested } : undefined;
}

/**
 * The turn after a failover: the second attempt's result, text, session, context size and time,
 * plus what both did – their tools (progress, approach line), the latest plan, tokens and cost
 * (the run and the agent's budget book both). `lastUsage` keeps the second attempt's own usage
 * for its model's outcome (the first attempt's limit/outage says nothing about a model).
 */
export function mergeAttempts(first: AttemptResult, second: AttemptResult): AttemptResult {
  const paid = first.usage.costUsd !== undefined || second.usage.costUsd !== undefined;
  return {
    ...second,
    // B-049 F6: a compaction in the first attempt (the guard continues the same session) still counts.
    result: first.result.compacted && !second.result.compacted ? { ...second.result, compacted: true } : second.result,
    lastUsage: second.lastUsage ?? second.usage,
    toolCalls: first.toolCalls + second.toolCalls,
    tools: [...(first.tools ?? []), ...(second.tools ?? [])],
    plan: second.plan?.length ? second.plan : first.plan,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      ...addCache(first.usage, second.usage),
      ...(paid ? { costUsd: (first.usage.costUsd ?? 0) + (second.usage.costUsd ?? 0) } : {}),
      ...(second.usage.contextTokens !== undefined ? { contextTokens: second.usage.contextTokens } : {}),
    },
  };
}

/**
 * B-048 E4.5: hands a (re)built turn to the dispatcher's live handles – engine for steering, the
 * input's cursor – and reports what it runs on (AgentActivity's model, modelName, effort, engine;
 * dispatch-runs.ts re-emits the activity). Every path that builds the turn – route time, session
 * renewal or rebuild, failover, a later re-route – goes through here, so the shown model never lags.
 */
export function bindTurn(request: TurnRequest, turn: RoutedTurn): void {
  request.control.engine = turn.engine;
  request.control.lastSeq = turn.lastSeq;
  try { request.onRoute?.({ model: turn.route.modelId, modelName: turn.modelName, effort: turn.route.effort, engine: turn.engine.id }); } catch { /* cosmetic */ }
}

export class TurnExecutor {
  private readonly services: () => RuntimeServices;

  constructor(services: () => RuntimeServices) {
    this.services = services;
  }

  async execute(request: TurnRequest): Promise<TurnOutcome> {
    const services = this.services();
    let plan = await planTurn(services, request);
    if (!plan) return { runId: request.runId, status: 'skipped' };

    const started = services.runs.start({
      id: request.runId, agentId: plan.agent.id, conversationId: plan.conversationId, taskId: plan.task?.id,
      trigger: request.reason, deviceId: plan.agent.deviceId, ...(plan.origin ? { origin: plan.origin } : {}),
      ...(plan.split ? { splitId: plan.split.splitId } : {}), // B-057: the run of a split (runs.split_id)
    });
    const repairNotes = takeRepairNotes(services, plan.agent.id, plan.thread);

    let turn: RoutedTurn;
    try {
      let route: RouteDecision;
      try {
        route = await services.router.route(routeRequest(plan));
      } catch (error) {
        // Images are a preference, not a requirement: without a model that can read them the
        // turn runs on the text and the agent is told. Failing instead would block the chat –
        // a failed turn keeps the image message unread, so every later turn would need vision.
        if (!plan.needsVision || !visionUnavailable(error)) throw error;
        plan = withoutImages(plan);
        route = await services.router.route(routeRequest(plan));
        services.runs.item(request.runId, { kind: 'note', data: { imagesHidden: true }, effectStatus: 'none' });
      }
      turn = await buildTurn(services, plan, request, route, repairNotes);
    } catch (error) {
      return this.failBeforeEngine(services, plan, request, toErrorData(error));
    }
    bindTurn(request, turn);
    this.announceSwitch(services, plan, request.runId, turn.route, turn.modelName);

    let messageId = this.beginMessage(services, plan, request, turn, started?.startedAt ?? services.clock.now());
    let attempt = await runAttempt(services, plan, turn, request, messageId);

    // Renew once (compaction + fresh session with the full projection) in the same run – only when
    // nothing external happened yet (else it is forgotten below); another folder: no chat line.
    if (sessionEnded(attempt) && attempt.toolCalls === 0 && !request.signal.aborted) {
      const folder = attempt.result.error?.details?.folder === true;
      const retry = { ...request, interruption: { at: services.clock.now(), reason: attempt.result.error?.message ?? 'The previous session ended.' } };
      try { request.onStatus?.('starting a fresh session'); } catch { /* cosmetic */ }
      try {
        await renewSession(services, plan, turn.engine.id, request.runId, folder ? 'folder' : 'overflow');
        if (plan.split?.firstTurn) plan = { ...plan, split: { ...plan.split, firstTurn: false } }; // B-057: a renewed split starts fresh with its brief – never seeded (forked) again
        turn = await buildTurn(services, plan, retry, turn.route, repairNotes);
        bindTurn(request, turn);
        if (!folder) this.statusLine(services, plan, request.runId, 'note', 'Continued in a fresh session', { renewed: true, cause: attempt.result.error?.message });
        attempt = await runAttempt(services, plan, turn, request, messageId);
      } catch (error) {
        services.log.warn('session renewal retry could not start', { agentId: plan.agent.id, error: toErrorData(error).message });
      }
    }

    this.accountFailed(services, turn, attempt);
    const afterTools = attempt.toolCalls;
    if (canFailover(attempt, request.signal, afterTools > 0 && effectsKnown(services, request.runId, afterTools))) {
      const failed = turn;
      const first = attempt;
      const limited = accountFailure(attempt.result) === 'limit';
      const retry = { ...request, interruption: { at: services.clock.now(), reason: attempt.result.error?.message ?? (limited ? 'Usage limit reached.' : 'The model was unavailable.') } };
      try {
        const alternative = await services.router.route(routeRequest(plan, [failed.account.id]));
        if (alternative.accountId !== failed.account.id) {
          turn = await buildTurn(services, plan, retry, alternative, repairNotes);
          bindTurn(request, turn);
          services.runs.item(request.runId, { kind: 'note', data: { failover: { from: failed.route.modelId, fromAccount: failed.account.id, to: alternative.modelId, toAccount: alternative.accountId, reason: limited ? 'limit' : 'unavailable', ...(afterTools ? { afterTools } : {}) } }, effectStatus: 'none' });
          const text = failoverText({ modelName: turn.modelName, effort: alternative.effort, failedName: failed.modelName, sameModel: failed.route.modelId === alternative.modelId, limited });
          this.statusLine(services, plan, request.runId, 'model_switched', text, { from: failed.route.modelId, to: alternative.modelId, effort: alternative.effort, reason: limited ? 'limit' : 'unavailable' });
          attempt = mergeAttempts(first, await runAttempt(services, plan, turn, request, messageId));
          this.accountFailed(services, turn, attempt);
        }
      } catch (error) {
        services.log.info('no failover route', { agentId: plan.agent.id, error: toErrorData(error).message });
      }
    }
    // Still unusable (tools ran, stopped, or the retry ended the same way): the next turn starts fresh.
    if (sessionEnded(attempt)) attempt = this.forgetSession(services, plan, turn, request, attempt);
    const outcome = finishTurn(services, plan, turn, request, attempt, messageId);
    this.rememberWindow(services, plan, turn, attempt);
    return outcome;
  }

  /**
   * Records what a failed attempt says about its account (accounts/failure.ts) – also after tool
   * calls, so ownership retries and later turns do not land on the same used-up or signed-out plan again.
   */
  private accountFailed(services: RuntimeServices, turn: RoutedTurn, attempt: AttemptResult): void {
    try { recordAccountFailure(services, turn.account, turn.model, attempt.result); } catch (error) {
      services.log.warn('recording the account failure failed', { accountId: turn.account.id, failure: accountFailure(attempt.result), error: String(error) });
    }
  }

  /** Drops the binding and keeps finishTurn from saving the ended session again. */
  private forgetSession(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, attempt: AttemptResult): AttemptResult {
    try {
      new SessionStore(services.db).remove(plan.agent.id, plan.thread, turn.engine.id);
      services.runs.item(request.runId, { kind: 'note', data: { sessionDropped: 'ended' }, effectStatus: 'none' });
    } catch (error) {
      services.log.warn('dropping the ended session failed', { agentId: plan.agent.id, error: String(error) });
    }
    return { ...attempt, result: { ...attempt.result, session: undefined } };
  }

  /** The window the engine reported is kept with the session (renewal uses it when the catalog has none). */
  private rememberWindow(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, attempt: AttemptResult): void {
    const window = attempt.result.contextWindow;
    if (!window || window <= 0 || !attempt.result.session || !turn.engine.caps.sessions) return;
    try { new SessionStore(services.db).setContextWindow(plan.agent.id, plan.thread, turn.engine.id, window); } catch (error) {
      services.log.warn('storing the context window failed', { agentId: plan.agent.id, error: String(error) });
    }
  }

  private beginMessage(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, turn: RoutedTurn, startedAt: number): string | undefined {
    // The final text is auto-posted only when the run came from exactly one chat the agent is in. B-075: its row is the
    // run's live status from the start – silent where publishing is not the default (B-047 D4: background work).
    if (!plan.conversationId) return undefined;
    const member = services.chats.members(plan.conversationId).some((item) => item.memberId === plan.agent.id && !item.leftAt);
    if (!member) return undefined;
    return services.chats.beginAgentMessage(plan.conversationId, plan.agent.id, request.runId, {
      model: turn.modelName, effort: turn.route.effort,
      live: { steps: [], more: 0, startedAt, model: turn.modelName, effort: turn.route.effort, ...(plan.task ? { taskId: plan.task.id } : {}) },
      ...(plan.callId ? { call: { id: plan.callId, participant: `agent:${plan.agent.id}`, name: plan.agent.name } } : {}),
    }, { silent: plan.publish === 'internal' }).id;
  }

  /**
   * Every model/effort switch becomes one quiet status line (identity stays the agent) that says
   * why: "Switched to X · high — <first reason>" (RT5, switch-line.ts; the agent reads it too).
   */
  private announceSwitch(services: RuntimeServices, plan: TurnPlan, runId: string, route: RouteDecision, modelName: string): void {
    // SG (route-line.ts): also one "Kept …" line when routing deviates from the chat's model hint.
    const scope = { agentId: plan.agent.id, conversationId: plan.conversationId };
    for (const line of routeLines(services, scope, route, modelName, switchedFrom(services, plan))) this.statusLine(services, plan, runId, 'model_switched', line.text, line.details);
  }

  /** A quiet line of this run (meta.fromRun: the UI may fold it into the run's steps). */
  private statusLine(services: RuntimeServices, plan: TurnPlan, runId: string, type: StatusLine['type'], text: string, details: Record<string, unknown>): void {
    if (!plan.conversationId) return;
    try { services.chats.status(plan.conversationId, { type, text, details }, { authorId: plan.agent.id, taskId: plan.task?.id, fromRun: runId }); } catch (error) {
      services.log.warn('status line failed', { error: String(error) });
    }
  }

  /**
   * Routing/preparation failed: close the run, tell the chat briefly, let ownership retry later –
   * no model or account to run on ('unavailable') and limits are no stall of the task. A task's
   * outage gets one quiet "Paused: … – continues by itself" line per outage instead of a failed
   * bubble on every retry (T06); a setup error, a chat turn or any other failure keeps its bubble.
   * The subconscious's trace was shown to nobody: it waits for the next turn on the thread.
   */
  private failBeforeEngine(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, error: WorkforceErrorData): TurnOutcome {
    const message = error.message;
    if (plan.trace) services.subconscious.putBack?.(plan.agent.id, plan.thread, plan.trace);
    services.runs.finish(request.runId, { status: 'failed', endedAt: services.clock.now(), error: message });
    let messageId: string | undefined;
    if (plan.task && isOutage(errorOutcome(error))) outageLine(services, plan.task, message, request.runId); // the pre-turn ledger decides the dedupe; B-059 #86: meta.fromRun
    else if (plan.conversationId && services.chats.members(plan.conversationId).some((item) => item.memberId === plan.agent.id && !item.leftAt)) {
      const draft = services.chats.beginAgentMessage(plan.conversationId, plan.agent.id, request.runId);
      messageId = services.chats.finishAgentMessage(draft.id, { body: '', state: 'failed', meta: { error: message } }).id;
    }
    // B-044: no model or account for a chat turn – delivered again once one becomes usable (redelivery.ts).
    if (!plan.task && plan.conversationId) noteChatOutage(services, { agentId: plan.agent.id, conversationId: plan.conversationId, runId: request.runId, cursor: plan.memberCursor, error, toolCalls: 0 });
    if (plan.task) {
      try { services.ownership.afterTurn({ agentId: plan.agent.id, taskId: plan.task.id, runId: request.runId, progressed: false, outcome: errorOutcome(error), note: message, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }); } catch (failure) { // B-059 C6: when the route can run again
        services.log.warn('ownership.afterTurn failed', { taskId: plan.task.id, error: String(failure) });
      }
    }
    splitTurnFailed(services, plan, request.runId, error); // B-057: a split's run that never reached its engine
    return { runId: request.runId, status: 'failed', messageId, error: message };
  }
}
