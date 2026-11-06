// Turn phase 1 – plan and route: who runs, in which mode, on which model/account, with
// which session, prompt and input. Owns: mode resolution (task → chat → agent), the focus
// text for routing, the subconscious's trace of this turn (owner 01.11.2026: real tool calls in the main AI's history, never
// a hint in a prompt; subconscious/service.ts beforeTurn: on a person's message with content the flow looks first, bounded), the previous-model rule (RT2, next-route.ts: a model.set request for the
// next step or the task's turns, else the last run no request shaped), session choice
// (CTX7, compaction-policy.ts: renewal above 60 % of the window, at most the working set of
// 64k tokens, on every engine with sessions = compaction + dropped binding + full projection; catch-up
// of a session that missed turns elsewhere; SES2: a session resumes only while its prompt key –
// stable prompt + offered tools – matches, else it is renewed the same way, after a mode switch
// with "Mode changed from X to Y"; a row from before SES2 is accepted once; another engine starts a fresh session with the
// full projection), the tool offer,
// attachment extraction before the delta, and (PR3)
// the "Previous attempt" recap of unfinished runs' tool calls when this engine cannot know them.
// Interrupted work gets app system events around the input after a longer pause or changed input (interruption-context.ts).
// B-047 D4 (agents/publishing.ts): the plan says whether a person waits for the answer (their new line, an
// awaited wake, a call) and where an untagged final text goes; the turn's volatile context ends with that one
// line and – for a new session or a stateless engine – the agent's latest answers kept in its run log.
// B-049 F6 (volatile-delta.ts): a resumed native session gets only the volatile sections changed since
// its last finished turn (turn-finish records what it then holds); every other turn gets them all.
// Whose turn (tasks/owners.ts): a follow-up (retry/review) for a task another agent owns now plans
// no turn (its owner's manager's review does). Only a wake the human caused
// (answer, approval, or a manual run – messages.retry wakes 'manual' with the stopped run's task)
// resumes a task the human paused, for its owner or lead; a chat or mini-app 'message' wake runs
// without the task (it stays paused); every other wake (retry, review, schedule, task, handoff,
// child – agents and timers) plans no turn for it. An archived chat runs like any other (C2); notes
// before the delta are quoted (quoteHeaders), a 'review' wake's as the app's, never the agent's own.
// B-054: the plan carries the wakes' origin and its thread (threadKey, shared/model/origin.ts: the chat id, else
// `task:<id>`, else `src:<source>`) – the native session, the volatile-delta record and the recaps are keyed by it, so
// each chat-free task and each source (a mailbox, task news) has its own session; a chat keeps its id (old sessions resume).
// A native rebuild from the context ledger (agents/rebuild.ts) on an engine switch, a missing session or worthwhile marks; a turn
// whose history starts from the projection gets the call naming what is condensed or hidden there (turnTrace).
// B-057 (agents/split-turn.ts): a split's turn plans, routes, seeds its session and gets its parent's tool offer there; the
// agent's own turn gets its settled splits' "Split results" block in its input (RoutedTurn.splitGroups).
// Never: starts the engine, posts chat messages (only TaskService.resume's quiet line) or
// advances cursors (turn-finish does that).

import type { RuntimeServices, RouteRequest } from '../contracts.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { EngineId, RouteDecision } from '../../shared/model/providers.ts';
import type { Message } from '../../shared/model/chat.ts';
import { threadKey } from '../../shared/model/origin.ts';
import { hasTrace, type SubconsciousTrace } from '../../shared/model/subconscious.ts';
import type { Engine } from '../engines/types.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { DELTA_LIMIT, type DeltaInput, type DeltaResult } from '../context/delta.ts';
import { quoteHeaders } from '../context/projection.ts';
import { answersRecap, needsRecap, recapScope, recapText, recentActions } from '../context/recent-actions.ts';
import { writeLastPrompt } from '../context/last-prompt.ts';
import { defaultVisibility, fromPerson, mustSee, pairPeer, publishNote, waitingFor } from './publishing.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { pendingRoute, returnChoice } from './next-route.ts';
import { modeChangeNote, offeredTools, promptKey } from './session-key.ts';
import { promoteLearned } from '../tools/learned.ts'; // B-049 F4 (TOOLS-CORE)
import { forgetSent, sentTo, volatileDelta } from './volatile-delta.ts'; // B-049 F6
import { isPaused, roleOf, staleFollowUp } from '../tasks/owners.ts';
import { compactNoted, needsRenewal } from './compaction-policy.ts';
import { nativeRebuild, rebuildFellBack } from './rebuild.ts';
import { carriedCalls, marksCall, marksOf } from '../context/ledger/marks.ts';
import type { RoutedTurn, TurnPlan, TurnRequest } from './turn-types.ts';
import type { ToolOffer } from './session-key.ts';
import type { Account } from '../../shared/model/providers.ts';
import { offerScope, planSplit, seedSplit, splitResults, splitRoute, splitWaiter } from './split-turn.ts'; // B-057
import { visionInputs } from '../media/vision-image.ts'; // B-058 G10 (T4): image inputs normalized for every engine
import { interruptionContext } from './interruption-context.ts';
import { validZone } from '../context/time.ts';

/** Runs read for the choice to return to (a task request makes many runs the return rule skips). */
const RETURN_WINDOW = 50;
const FOCUS_CHARS = 4000;
/** Wakes the human caused (a retry of a stopped answer is 'manual'): the only ones that end the human's pause of a task. */
const BY_HUMAN: ReadonlySet<WakeReason> = new Set(['answer', 'approval', 'manual']);
/** Task states in which a bare 'task' wake has nothing to continue (the owner set the work aside, or it is over). */
const SET_ASIDE: ReadonlySet<string> = new Set(['waiting', 'needs_you', 'blocked', 'done', 'cancelled']);

/** The turn's mode: the first key (task → chat → agent) the mode library answers – an unknown (deleted)
 *  key is answered with general, so such a task runs in general. Experience notes use it too (experience.ts). */
export function resolveMode(services: RuntimeServices, keys: Array<string | undefined>): ModeInfo {
  for (const key of keys) {
    if (!key) continue;
    try { return services.modes.get(key); } catch { /* unknown mode → next candidate */ }
  }
  return services.modes.get('general');
}

/** Loads agent, task, chat and mode; the subconscious's trace; consumes a pending model.set request. */
export async function planTurn(services: RuntimeServices, request: TurnRequest): Promise<TurnPlan | undefined> {
  if (request.split) return planSplit(services, request, resolveMode); // B-057: a split's own plan (agents/split-turn.ts)
  const agent = services.org.get(request.agentId);
  if (!agent || agent.archivedAt || agent.status === 'paused') return undefined;
  let task = request.taskId ? services.tasks.get(request.taskId) : undefined;
  if (task) {
    if (staleFollowUp(services.org, task, agent.id, request.reason)) return undefined;
    // B-047: a bare 'task' wake (no note: nothing new) for work its owner already set aside is stale – it was queued while
    // that work ran (e.g. at the task's creation) and would restart what the owner just paused, maybe on the person's
    // "stop". Wakes with news (an answer, a finished step, a reopening) carry a note.
    if (request.reason === 'task' && !request.notes.length && SET_ASIDE.has(task.status)) return undefined;
    if (isPaused(task)) {
      if (BY_HUMAN.has(request.reason)) {
        if (roleOf(task, agent.id) !== 'other') task = resumed(services, task, agent.id);
      } else if (request.reason === 'message') {
        task = undefined; // a chat or mini-app event is answered; the work stays paused
      } else {
        return undefined; // only the human resumes paused work
      }
    }
  }
  const conversationId = request.conversationId ?? task?.conversationId;
  const conversation = conversationId ? services.chats.get(conversationId) : undefined;
  if (conversationId && !conversation) return undefined;
  const mode = resolveMode(services, [task?.mode, conversation?.settings.mode, agent.mode]);

  const room = conversationId ? services.chats.members(conversationId) : [];
  const member = room.find((item) => item.memberId === agent.id && !item.leftAt);
  const memberCursor = member?.readSeq ?? 0;
  const unseen = conversationId ? services.chats.messages(conversationId, { afterSeq: memberCursor, limit: 40 }) : [];
  const lastInput = unseen.filter(message => message.authorKind === 'human' && message.kind !== 'status').at(-1);
  const callId = !task && request.reason === 'message' ? lastInput?.meta.call?.id : undefined;
  const focusParts = [
    ...request.notes.map((note) => note.text),
    task ? `${task.title}\n${task.notes}` : '',
    ...unseen.filter((message) => message.authorId !== agent.id && message.kind !== 'status').map((message) => message.body),
  ].filter(Boolean);
  const focus = focusParts.join('\n').slice(-FOCUS_CHARS);
  const needsVision = unseen.some((message) => message.attachments.some((file) => file.mime.startsWith('image/')));

  const thread = threadKey({ conversationId, taskId: task?.id, origin: request.origin });

  // Return rule (RT2, next-route.ts): the last done run in the chat that no model.set request shaped continues; a
  // request in force – the next step's over its task's – wins, marked explicit (it beats default pins and weak priors,
  // never the policy bounds).
  const requested = pendingRoute(services.db, agent.id, conversationId, task?.id, (taskId) => finished(services, taskId));
  const previous = returnChoice(services.runs.list(agent.id, RETURN_WINDOW), conversationId, requested);
  // B-047 D4: who waits for the answer and where an untagged final text goes (agents/publishing.ts).
  const waiting = waitingFor(request.reason, callId, unseen, agent.id)
    ?? splitWaiter(services, { agentId: agent.id, thread, reason: request.reason, conversationId }); // B-057 S6: the merge answers whoever waited for the split
  // The task as it is now is also the "after" the finish judges (a blocked or waiting task stays must-see): the line never says "run log" for a post.
  const publish = defaultVisibility({
    awaited: waiting !== undefined, call: Boolean(callId), mustSee: mustSee({ before: task, after: task, asks: false }), reason: request.reason,
    pairAgent: pairPeer(room, agent.id) !== undefined, // B-050 K3: as turn-finish posts it – the answer reaches the other agent of a room of two
  });
  const origin = request.origin;
  const said = unseen.filter((message) => fromPerson(message, agent.id)).map((message) => message.body).join('\n');
  const trace = await subconsciousTrace(services, request.signal, { agent, thread, conversationId, taskId: task?.id, mode: mode.key, said, signal: request.signal }); // last: nothing here throws after it took the kept trace
  return {
    agent, mode, task, conversationId, ...(origin ? { origin } : {}), thread,
    memberCursor, callId, focus, ...(trace ? { trace } : {}), previous, needsVision,
    awaited: waiting !== undefined, ...(waiting ? { waitingFor: waiting } : {}), publish,
  };
}

/**
 * What the subconscious shows this turn (runAttempt journals its calls: the run does not exist yet here); nothing when it has nothing or fails.
 * A stop (the emergency stop, a chat's stop) does not wait for its look: the turn ends now, what the look still hands over waits for the thread's next turn.
 */
async function subconsciousTrace(services: RuntimeServices, signal: AbortSignal, input: Parameters<NonNullable<RuntimeServices['subconscious']['beforeTurn']>>[0]): Promise<SubconsciousTrace | undefined> {
  try {
    if (signal.aborted) return undefined;
    const look = Promise.resolve(services.subconscious.beforeTurn?.(input));
    const stopped = new Promise<'stopped'>((resolve) => signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
    const trace = await Promise.race([look, stopped]);
    if (trace === 'stopped') {
      look.then((late) => { if (hasTrace(late)) services.subconscious.putBack?.(input.agent.id, input.thread, late); }).catch((error) => services.log.warn('the subconscious before the turn failed', { agentId: input.agent.id, error: String(error) }));
      return undefined;
    }
    return hasTrace(trace) ? trace : undefined;
  } catch (error) {
    services.log.warn('the subconscious before the turn failed', { agentId: input.agent.id, error: String(error) });
    return undefined;
  }
}

/** RT2: a task's model.set request ends with the task (done, cancelled or gone). */
function finished(services: RuntimeServices, taskId: string): boolean {
  const status = services.tasks.get(taskId)?.status;
  return !status || status === 'done' || status === 'cancelled';
}

/** Ends the human's pause for this turn of the owner; the task as it is now. */
function resumed(services: RuntimeServices, task: TaskView, agentId: string): TaskView {
  try { return services.tasks.resume?.(task.id, agentId) ?? task; } catch (error) {
    services.log.warn('resuming a paused task failed', { taskId: task.id, error: String(error) });
    return task;
  }
}

/** True when routing failed only because no connected model can read images. */
export function visionUnavailable(error: unknown): boolean {
  return error instanceof WorkforceError && error.code === 'unavailable' && error.details?.need === 'vision';
}

/** The same turn without image input; buildTurn then tells the agent it cannot see them. */
export function withoutImages(plan: TurnPlan): TurnPlan {
  return { ...plan, needsVision: false, imagesHidden: true };
}

/** Told to the agent instead of the images (they stay listed by name and stored path). */
export const IMAGES_HIDDEN_NOTE = 'I cannot see the images in this chat right now: no connected model can read images. They are listed by name and stored path. I use a saved description (media.search) when there is one, and say so when I would need to see an image.';

export function routeRequest(plan: TurnPlan, exclude?: string[]): RouteRequest {
  return {
    agent: plan.agent, conversationId: plan.conversationId, taskId: plan.task?.id, mode: plan.mode, text: plan.focus,
    previous: plan.previous, exclude, needs: plan.needsVision ? { vision: true } : undefined,
    ...splitRoute(plan), // B-057 S10: a split's own model choice (routing/split-route.ts)
  };
}

/** Each note keeps its own source, also when a schedule and a message/retry share a turn. */
export function noteLines(request: Pick<TurnRequest, 'reason' | 'notes'>, timezone: string | undefined): string[] {
  return request.notes.map((note) => {
    const reason = note.reason ?? request.reason;
    const when = new Date(note.at).toLocaleString('en-GB', { timeZone: validZone(timezone), dateStyle: 'medium', timeStyle: 'short' });
    if (reason === 'schedule') return `My own scheduled note from ${when}: ${note.text}`;
    return `Note from the app (${when}, ${reason}): ${note.text}`;
  });
}

/**
 * Session renewal: the chat is condensed into an observation and the native session binding is
 * dropped, so the next build sends the full projection (observation + earlier lines + new
 * lines) and the engine starts a fresh native session. A failed compaction still renews.
 * 'mode'/'prompt' (SES2): the session's prompt key no longer matches – run note {fresh, …details}.
 * 'folder': bound to another working folder (Codex, I02; note {fresh: 'folder'}, compactNoted's rule).
 * A compaction that moved the observation adds the note {compacted: reason, coveredSeq} (CTX7).
 */
export async function renewSession(services: RuntimeServices, plan: TurnPlan, engine: EngineId, runId: string, reason: 'context' | 'overflow' | 'mode' | 'prompt' | 'folder', details: Record<string, unknown> = {}): Promise<void> {
  if (reason === 'overflow') rebuildFellBack(services, plan.agent.id, plan.thread, engine, runId); // a session this run rebuilt that ended on its first turn: no rebuild of the chat for a while
  if (plan.conversationId) {
    try { await compactNoted(services, { agentId: plan.agent.id, conversationId: plan.conversationId, runId, reason }); } catch (error) {
      services.log.warn('compaction before session renewal failed; renewing without it', { agentId: plan.agent.id, error: String(error) });
    }
  }
  new SessionStore(services.db).remove(plan.agent.id, plan.thread, engine, services.clock.now()); // B-048: the ref is recorded as superseded
  const data = reason === 'mode' || reason === 'prompt' || reason === 'folder' ? { fresh: reason, ...details } : { sessionRenewed: reason };
  services.runs.item(runId, { kind: 'note', data, effectStatus: 'none' });
}

/** Seqs of own messages written by runs on `engine`: the bound native session holds them already. */
function sessionOwn(services: RuntimeServices, agentId: string, engine: EngineId, messages: Message[]): number[] {
  const runs = new Map<string, { engine?: EngineId; conversationId?: string } | undefined>();
  return messages.filter((message) => {
    if (message.authorId !== agentId || !message.runId) return false;
    if (!runs.has(message.runId)) runs.set(message.runId, services.runs.get(message.runId));
    // B-047 D4: chat.send posts carry their run too – one sent here from a run in another chat (another session) is news here.
    const run = runs.get(message.runId);
    return run?.engine === engine && run.conversationId === message.conversationId;
  }).map((message) => message.seq);
}

interface SessionChoice {
  session?: SessionBinding;
  contextWindow?: number;
  /** Delta start: the agent's chat cursor, or the session's own cursor for a catch-up. */
  sinceSeq: number;
  /** Set for a catch-up: own messages the session already holds. */
  knownSeqs?: number[];
  /** Told to the agent after a renewal for a mode switch. */
  note?: string;
  /** B-057: a split's session seeded from its parent (it holds the earlier context). */
  seeded?: boolean;
  /** B-057: a split's seed text (splits/fork.ts text fallback), put before the turn's input. */
  prefix?: string;
}

/** What seeding a split's session from its parent needs besides the plan (agents/split-turn.ts seedSplit). */
interface SeedContext { account: Account; model: string; offer: ToolOffer; prompt: { stable: string; volatile: string } }

/**
 * The native session for this turn: none for another account; renewed when its prompt key
 * differs (SES2: 'mode' when the mode changed, else 'prompt'; a row without a key, from before
 * SES2, is accepted once and stamped) or above the renewal limit (CTX7: 60 % of the window, at
 * most WORKING_SET_TOKENS; the window the engine reported for this model – the one it really
 * runs with –, else the catalog's); a session that missed
 * turns in another session catches up from its own cursor (own replies included) when at most
 * DELTA_LIMIT lines are missing, otherwise it is dropped for the full projection (run note
 * {sessionDropped: 'missed_too_much', fresh: 'cursor'}).
 */
async function chooseSession(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, engine: Engine, accountId: string, route: RouteDecision, catalogWindow: number | undefined, key: string, native?: SeedContext): Promise<SessionChoice> {
  const store = new SessionStore(services.db);
  let session = engine.caps.sessions ? store.get(plan.agent.id, plan.thread, engine.id) : undefined;
  // A native session lives in one account home (CODEX_HOME / CLAUDE_CONFIG_DIR): no cross-account resume.
  if (session && session.accountId && session.accountId !== accountId) session = undefined;
  const contextWindow = (session && session.model === route.modelId ? session.contextWindow : undefined) ?? catalogWindow;
  // The native rebuild, when this turn's case holds (undefined: the path below).
  const rebuild = async (current: SessionBinding | undefined, renewed?: 'mode' | 'prompt', overLimit?: boolean) => (native && engine.caps.rebuild
    ? nativeRebuild(services, { plan, request, engine, account: native.account, route, model: native.model, session: current, offer: native.offer, prompt: native.prompt, promptKey: key, contextWindow, renewed, overLimit })
    : undefined);
  // B-057: a split's first turn without a session on its thread starts from its parent (agents/split-turn.ts seedSplit).
  const seeded = session ? undefined : await seedSplit(services, plan, request, engine, route, key, native);
  if (seeded) return { session: seeded.session, contextWindow, sinceSeq: plan.memberCursor, prefix: seeded.prefix, seeded: seeded.session !== undefined };

  if (session && session.promptKey === undefined) store.stamp(plan.agent.id, plan.thread, engine.id, key, plan.mode.key);
  else if (session && session.promptKey !== key) {
    // A resumed session keeps the prompt and tools it started with: renew it (SES1 way).
    const from = session.mode && session.mode !== plan.mode.key ? session.mode : undefined;
    await renewSession(services, plan, engine.id, request.runId, from ? 'mode' : 'prompt', from ? { from, to: plan.mode.key } : {});
    const note = from ? modeChangeNote(services, from, plan.mode) : undefined;
    const rebuilt = await rebuild(undefined, from ? 'mode' : 'prompt');
    if (rebuilt) return { session: rebuilt.session, contextWindow, sinceSeq: rebuilt.sinceSeq, note, seeded: true };
    return { contextWindow, sinceSeq: plan.memberCursor, note };
  }
  // Every engine with sessions. The subconscious's marks come first: the renewal is the backstop for a context they cannot bring down.
  if (session && needsRenewal(session.contextTokens, contextWindow)) {
    const marked = await rebuild(session, undefined, true);
    if (marked) return { session: marked.session, contextWindow, sinceSeq: marked.sinceSeq, seeded: true };
    await renewSession(services, plan, engine.id, request.runId, 'context');
    return { contextWindow, sinceSeq: plan.memberCursor };
  }
  const rebuilt = await rebuild(session);
  if (rebuilt) return { session: rebuilt.session, contextWindow, sinceSeq: rebuilt.sinceSeq, seeded: true };
  if (!session || !plan.conversationId || session.cursorSeq >= plan.memberCursor) return { session, contextWindow, sinceSeq: plan.memberCursor };

  const since = services.chats.messages(plan.conversationId, { afterSeq: session.cursorSeq, limit: DELTA_LIMIT + 1 });
  if (since.filter((message) => message.seq <= plan.memberCursor).length > DELTA_LIMIT) {
    store.remove(plan.agent.id, plan.thread, engine.id);
    services.runs.item(request.runId, { kind: 'note', data: { sessionDropped: 'missed_too_much', fresh: 'cursor' }, effectStatus: 'none' });
    return { contextWindow, sinceSeq: plan.memberCursor };
  }
  return { session, contextWindow, sinceSeq: session.cursorSeq, knownSeqs: sessionOwn(services, plan.agent.id, engine.id, since) };
}

/**
 * PR3: the tool calls of unfinished attempts (also this run's, after a failover) when the engine
 * that runs now cannot know them – a new session, another engine or account, or no sessions at all.
 */
function previousAttempt(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, now: Parameters<typeof needsRecap>[1], timezone: string | undefined): string | undefined {
  try {
    const actions = recentActions(services, recapScope(plan), request.runId);
    if (!needsRecap(actions, now)) return undefined;
    services.runs.item(request.runId, { kind: 'note', data: { previousAttempt: actions.length }, effectStatus: 'none' });
    return recapText(actions, timezone);
  } catch (error) {
    services.log.warn('previous attempt recap failed', { agentId: plan.agent.id, error: String(error) });
    return undefined;
  }
}

/**
 * The calls the engine shows this turn: the subconscious's; for a history that starts from the projection the call naming what is
 * marked there; and – a stateless engine holds nothing between turns – the subconscious's earlier calls, as a CLI session holds them.
 */
function turnTrace(services: RuntimeServices, plan: TurnPlan, session: SessionBinding | undefined, engine: Engine, runId: string): SubconsciousTrace | undefined {
  const marks = !session && plan.conversationId ? marksCall(marksOf(services, plan.agent.id, plan.conversationId, 'message')) : undefined;
  const earlier = !engine.caps.sessions && plan.conversationId ? carriedCalls(services, plan.agent.id, plan.conversationId, runId) : [];
  const calls = [...(marks ? [marks] : []), ...earlier, ...(plan.trace?.calls ?? [])];
  return calls.length ? { calls } : undefined;
}

/** Resolves engine/account/model for a route, then prompt, tool offer, session and turn input. */
export async function buildTurn(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, route: RouteDecision, repairNotes: string[]): Promise<RoutedTurn> {
  const engine = services.engines.get(route.engine);
  const account = services.accounts.get(route.accountId);
  if (!account) throw new WorkforceError('unavailable', 'The chosen account is not available.');
  const info = services.catalog.get(route.modelId);
  const model = info?.model ?? route.modelId.slice(route.modelId.indexOf(':') + 1);
  const prompt = services.context.prompt({ agent: plan.agent, conversationId: plan.conversationId, taskId: plan.task?.id, thread: plan.thread, mode: plan.mode, route });
  let offer = offeredTools(services, offerScope(plan), engine.caps); // B-049 F4: may grow by learned tools below (fresh session only); B-057: a split gets its parent's
  let key = promptKey(prompt.stable, offer.names);
  const publish = plan.split ? '' : publishNote(services, plan); // B-057: a split's final text goes to its main self (its 'split' section)
  // B-057: a split's seeded session starts with this turn's prompt (its volatile part as below).
  const native: SeedContext = { account, model, offer, prompt: { stable: prompt.stable, volatile: [prompt.volatile, publish].filter((part) => Boolean(part?.trim())).join('\n\n') } };
  // B-066: the whole prompt with its "My final text" line, readable; B-076: the main lane only, like last-run.md beside it.
  if (!plan.split) writeLastPrompt(services.paths?.data, plan.agent.id, native.prompt, (message, data) => services.log?.debug(message, data));
  const { session, contextWindow, sinceSeq, knownSeqs, note, seeded: rebuilt, prefix } = await chooseSession(services, plan, request, engine, account.id, route, info?.caps.contextTokens, key, native);
  // B-049 F4 (TOOLS-CORE): tools this agent ran through tools.call in this chat join its offer where a fresh native
  // session starts (new, renewed, dropped, stateless engine) – never in a resumed or rebuilt one (tools/learned.ts); never for a split (B-057).
  if (!plan.split && !session && !rebuilt && promoteLearned(services, plan.agent.id, plan.conversationId)) {
    offer = offeredTools(services, plan, engine.caps);
    key = promptKey(prompt.stable, offer.names);
  }

  let delta: DeltaResult = { text: '', images: [], lastSeq: 0 };
  if (plan.conversationId) {
    // Freshly attached PDFs/text files are extracted first, so the delta carries their text.
    try { await services.context.prepare?.({ agentId: plan.agent.id, conversationId: plan.conversationId, sinceSeq }); } catch (error) {
      services.log.warn('attachment extraction failed; the delta only names the files', { agentId: plan.agent.id, error: String(error) });
    }
    const query: DeltaInput = { agent: plan.agent, conversationId: plan.conversationId, sinceSeq, full: !session, includeOwn: knownSeqs !== undefined, knownSeqs };
    delta = services.context.delta(query);
  }

  const timezone = services.settings.get().profile.timezone;
  // A seeded split session holds its parent's context already.
  const recap = rebuilt ? undefined : previousAttempt(services, plan, request, { engine: engine.id, accountId: account.id, sessionNew: !session, stateless: !engine.caps.sessions }, timezone);
  const results = splitResults(services, plan); // B-057 S6: the agent's own turn gets its settled splits' results once
  const notes = [...noteLines(request, timezone), results?.text, ...repairNotes, note, recap].map((line) => line && quoteHeaders(line)); // only delta.ts writes headers
  const recovery = interruptionContext(services, plan, request, delta.lastSeq, timezone);
  const lines = [prefix, recovery.before, ...notes, delta.text, recovery.after].filter((line): line is string => Boolean(line && line.trim()));
  // Nothing new arrived: said as the app's note, so it never reads as a person's instruction (B-047 eval: "resumed on the person's instruction").
  if (!lines.length && plan.task) lines.push(`Note from the app – nobody wrote anything new: my task ${plan.task.id} "${plan.task.title}" is ${plan.task.status}; I carry it on if it still needs work.`);
  if (!lines.length) lines.push('Note from the app – nobody wrote anything new: I carry on where I left off.');
  if (plan.imagesHidden) lines.push(IMAGES_HIDDEN_NOTE);
  const input: RoutedTurn['input'] = [{ type: 'text', text: lines.join('\n\n') }];
  if (engine.caps.images && !plan.imagesHidden) input.push(...await visionInputs(services, delta.images)); // B-058 G10: as they are, a converted copy or a media.view line
  // B-047 D4: the turn's context (volatile, never the stable prompt or its key) says where the final text goes and –
  // for a session that cannot know them – recalls the agent's latest answers that stayed in its run log.
  const answers = !session || !engine.caps.sessions ? answersRecap(services, recapScope(plan), request.runId, timezone) : undefined;
  // B-049 F6: a resumed (not seeded) native session gets only the volatile sections changed since its last finished turn.
  const sentKey = { agentId: plan.agent.id, conversationId: plan.thread, engine: engine.id };
  if (rebuilt) forgetSent(services.db, sentKey); // a seeded session starts without the old record
  const shown = prompt.sections ? volatileDelta(prompt.sections, session && !rebuilt ? sentTo(services.db, sentKey, session.ref) : undefined) : undefined;
  const volatile = [shown ? shown.text : prompt.volatile, answers, publish].filter((part) => Boolean(part?.trim())).join('\n\n');

  const trace = turnTrace(services, plan, session, engine, request.runId);
  return {
    route, engine, account, model, modelName: info?.name ?? model, contextWindow, session, prompt: { ...prompt, volatile }, tools: offer.native, promptKey: key,
    input, lastSeq: Math.max(delta.lastSeq, plan.memberCursor), ...(shown ? { volatileSent: shown.sections } : {}), ...(trace ? { trace } : {}),
    ...(results ? { splitGroups: results.groupIds } : {}), // B-057: gathered when this turn ends 'done'
  };
}
