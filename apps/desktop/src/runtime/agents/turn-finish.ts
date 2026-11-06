// Turn phase 3 – integrate the result: finish or remove the streamed message, turn ask
// blocks and ```app todo=true mini-apps (F01, final agent messages only; never those of a
// …) into human to-dos, advance the agent's chat cursor in the
// same transaction (B-050 round 4: also over what the turn's chat.read showed of its own chat, chat/turn-reads.ts), save
// the native session (with its prompt key and mode, SES2; F6: after a
// finished turn the volatile sections it then holds – none after an engine compaction –, volatile-delta.ts), record the cost, run the ownership loop,
// – on a session-less engine – the chat's compaction (CTX7, compaction-policy.ts; low priority) and close the run. Cost (PR9, agents/turn-cost.ts):
// only a paid account's real charge is the run's costUsd and the agent's spend; a plan turn
// keeps its notional list-price cost as notionalUsd, a paid turn without a price is 'unpriced'.
// A turn the person stopped before it wrote anything keeps its message as an empty 'stopped' one (the
// turn stays in place in the chat); other interrupts without text remove it.
// Ownership outcome of a task turn: a human Stop → 'stopped' (the task pauses, no retry); an
// important message or shutdown → 'interrupted' (not a stall); any other interrupt → 'failed';
// an account limit → 'limit'; an engine error that is no model failure (code 'unavailable':
// signed out, connection lost, a CLI that could not start; 'cancelled') → 'unavailable' (not a
// stall either; errorOutcome is shared with turns that fail before the engine, agents/turn.ts).
// Publishing (B-047 D4, the rules in agents/publishing.ts): the final text's tags are stripped and
// it goes where resolveVisibility says – posted with a notification, posted quietly, or kept in the
// run journal only (B-050 K4: a notifying answer the agent tagged [[important]] posts with priority 'important';
// K3: in a room of two with an agent or external agent a message turn's untagged answer posts at normal level).
// Judged at the end with what the turn did: a person's line taken in meanwhile
// (also one steered in) makes it awaited; asking the person (an ask block, a mini-app to-do or
// human.ask), @mentioning them,
// a blocked, waiting or urgent task make it must-see. A posted answer finishes the streaming
// placeholder or – without one – is posted at the end of the chat (ChatService.postAgentMessage);
// an internal one removes the placeholder. B-075: a run whose answer was to be kept internal had a silent row that only
// showed its work (agents/turn.ts): posted, it becomes the answer; otherwise – also when the run fails – it goes.
// Every final text (and a failed or stopped turn's
// partial text) is journaled as the run item 'Answer'; Run.summary is built from the stripped text.
// A task turn that only met an outage leaves no failed bubble – one quiet line per outage instead
// (agents/outage-line.ts), with or without a placeholder; a chat turn without a task that met one
// keeps its failed bubble and is noted for one automatic re-delivery (B-044, redelivery.ts; B-059 C9: a usage limit too).
// B-054: the native session, its turn record, the volatile-delta record and the repair notes are keyed by the turn's
// thread (plan.thread: the chat id, `task:<id>` or `src:<source>`), never by a shared '' for every chat-free run.
// B-057 S9: a split's turn (plan.split) finishes internal only – no chat, cursor, to-dos, outage lines or ownership (it has
// no chat and no task), no compaction pass; kept: its session under `split:<id>`, the journal with
// its 'Answer', the cost on its parent agent; then the split service hears how it ended (split-turn.ts).
// Owns: applying the publishing rules, repair notes for invalid blocks, run status and outcome mapping.
// Never: advances the cursor for failed/stopped turns (their input is delivered again),
// counts account limits, sign-in/connection problems or user interrupts as model failures,
// lets a block that cannot become a to-do fail the turn (logged), books a plan's notional cost as
// spend, or blocks the turn on the subconscious or a compaction.

import type { RuntimeServices } from '../contracts.ts';
import type { EngineTurnResult } from '../engines/types.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import type { AnswerVisibility, Message } from '../../shared/model/chat.ts';
import type { RunStatus } from '../../shared/model/runs.ts';
import { ASK_TYPES } from '../../shared/blocks/catalog.ts';
import { appTodosOf, repairNotesOf, uiBlocksOf, type IndexedBlock } from '../../shared/blocks/parse.ts';
import { isPersonMention } from '../chat/mentions.ts';
import { runPosted } from '../chat/message-repo.ts';
import { takeTurnRead } from '../chat/turn-reads.ts';
import { awaitsAnswer, journalAnswer, mustSee, pairPeer, parseVisibility, personPair, resolveVisibility } from './publishing.ts';
import { isOutage } from './outages.ts';
import { outageLine } from './outage-line.ts';
import { noteChatOutage } from './redelivery.ts';
import { compactAfterTurn } from './compaction-policy.ts';
import { SessionStore } from './sessions.ts';
import { recordTurn } from './native-turns.ts';
import { forgetSent, recordSent } from './volatile-delta.ts'; // B-049 F6
import { bookTurnCost, priceTurn, saveRunCost } from './turn-cost.ts';
import { effectful, type AttemptResult, type RoutedTurn, type StopKind, type ToolUse, type TurnOutcome, type TurnPlan, type TurnRequest } from './turn-types.ts';
import { splitTurnEnded } from './split-turn.ts'; // B-057
import { writeLastRun } from '../context/last-run.ts'; // B-076

const REPAIR_NS = 'repair_notes';

/** Repair notes for invalid ```ui blocks are handed to the agent's next turn on that thread (no extra turn). */
export function takeRepairNotes(services: RuntimeServices, agentId: string, thread: string | undefined): string[] {
  const key = `${agentId}:${thread ?? ''}`;
  const row = services.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [REPAIR_NS, key]);
  if (!row) return [];
  services.db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [REPAIR_NS, key]);
  try { return JSON.parse(row.value) as string[]; } catch { return []; }
}

function saveRepairNotes(services: RuntimeServices, agentId: string, thread: string | undefined, notes: string[]): void {
  if (!notes.length) return;
  services.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [REPAIR_NS, `${agentId}:${thread ?? ''}`, JSON.stringify(notes.slice(0, 6)), services.clock.now()]);
}

/** The final message's to-dos in their own savepoint: agent output that cannot become one is
 * logged and never rolls back the turn (message, cursor). */
function ingestTodos(services: RuntimeServices, message: Message, blocks: IndexedBlock[]): void {
  try {
    services.db.tx(() => services.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index)));
  } catch (error) {
    services.log?.warn('turn to-dos failed', { messageId: message.id, error: String(error) });
  }
}

function runStatus(stop: string): RunStatus {
  if (stop === 'done') return 'done';
  if (stop === 'interrupted') return 'interrupted';
  return 'failed';
}

/** Sign-in/connection problems and stops: conditions of the account or engine, not of the model. */
const OUTAGE: ReadonlySet<string> = new Set(['unavailable', 'cancelled']);

type TaskOutcome = Parameters<RuntimeServices['ownership']['afterTurn']>[0]['outcome'];

/** What an error of a task turn (in the engine or before it) means for the ownership loop. */
export function errorOutcome(error: Pick<WorkforceErrorData, 'code' | 'details'> | undefined): 'limit' | 'unavailable' | 'failed' {
  if (error?.code === 'rate_limited') return 'limit';
  // A setup the person must change (capability, tier, suitability, model policy) is a real
  // failure: the ladder escalates it to the manager or the human instead of retrying quietly.
  if (error?.details?.setup === true) return 'failed';
  return error && OUTAGE.has(error.code) ? 'unavailable' : 'failed';
}

/** What a task turn means for the ownership loop (see the header). */
export function taskOutcome(result: Pick<EngineTurnResult, 'stop' | 'error'>, status: string | undefined, stopKind: StopKind | undefined): TaskOutcome {
  if (result.stop === 'done') return status === 'needs_you' || status === 'waiting' ? 'waiting' : 'done';
  if (result.stop === 'limit') return 'limit';
  if (result.stop !== 'interrupted') return errorOutcome(result.error);
  if (stopKind === 'human') return 'stopped';
  return stopKind ? 'interrupted' : 'failed';
}

export function finishTurn(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, attempt: AttemptResult, messageId: string | undefined): TurnOutcome {
  const { result } = attempt;
  const stop = result.stop;
  const conversationId = plan.conversationId;
  const agentId = plan.agent.id;
  const thread = plan.thread; // B-054: the session's and turn state's key
  // B-059 #74: the step count (or that it only thought) – the chat reserves the "Worked … · N steps" line from the first frame.
  const meta = { model: turn.modelName, effort: turn.route.effort, ...(attempt.toolCalls > 0 ? { steps: attempt.toolCalls } : attempt.reasoning?.trim() ? { thought: true } : {}) };
  let finalMessage: Message | undefined;
  // B-050 round 4: how far chat.read showed this turn its own chat completely – seen, like its input, once it ends done.
  const readTo = takeTurnRead(services, request.runId, conversationId);

  // Native session: keep it even for failed turns (the next turn resumes it with the same input).
  if (result.session && turn.engine.caps.sessions) {
    new SessionStore(services.db).save({
      agentId, conversationId: thread, engine: turn.engine.id, accountId: turn.account.id,
      ref: result.session.ref, generation: result.session.generation,
      cursorSeq: stop === 'done' ? Math.max(turn.lastSeq, request.control.steeredSeq, readTo) : plan.memberCursor,
      contextTokens: attempt.usage.contextTokens, model: turn.route.modelId, updatedAt: services.clock.now(),
      promptKey: turn.promptKey, mode: plan.mode.key, // SES2: the prompt and tools this session runs with
    });
    // The run's native turn on that session (a later rebuild for marks can cut before it, agents/rebuild-revert.ts).
    if (result.session.turn) recordTurn(services.db, { agentId, conversationId: thread, engine: turn.engine.id }, result.session.ref, request.runId, result.session.turn, services.clock.now());
    if (result.compacted) forgetSent(services.db, { agentId, conversationId: thread, engine: turn.engine.id }); // B-049 F6: compacted by the engine – nothing certain
    else if (stop === 'done' && turn.volatileSent) recordSent(services.db, { agentId, conversationId: thread, engine: turn.engine.id }, result.session.ref, turn.volatileSent, services.clock.now());
  }

  // What the turn said, tags stripped (summary, approach line, progress, the subconscious).
  const said = parseVisibility(result.text || attempt.streamed).body;
  const room = conversationId ? services.chats.members(conversationId) : [];
  const member = room.some((item) => item.memberId === agentId && !item.leftAt);
  let answer = '';
  let visibility: AnswerVisibility = 'internal';
  if (stop === 'done') {
    const { body, tag, important } = parseVisibility(result.text || attempt.streamed);
    answer = body;
    const cursor = Math.max(turn.lastSeq, request.control.steeredSeq);
    const blocks = body ? uiBlocksOf(body) : []; // keeps the parse index (app/invalid fences count too)
    const apps = body ? appTodosOf(body).length : 0; // mini-app to-dos (ingestBlocks takes them from the message)
    const files = result.files ?? []; // engine outputs (e.g. generated images) reach the chat as attachments
    services.db.tx(() => {
      if (member && (body || files.length)) {
        const after = plan.task ? services.tasks.get(plan.task.id) : undefined;
        const asks = (apps > 0 || blocks.some((item) => ASK_TYPES.has(item.block.type)) || askedHuman(attempt.tools));
        const mentions = body ? services.chats.mentionsOf(conversationId!, agentId, body) : [];
        visibility = resolveVisibility({
          tag, call: Boolean(plan.callId), reason: request.reason,
          awaited: plan.awaited || heardPerson(services, conversationId, agentId, plan.memberCursor, cursor),
          mustSee: mustSee({ before: plan.task, after, asks, mentionsPerson: mentions.some(isPersonMention) }),
          addressed: mentions.some((id) => !isPersonMention(id)),
          pairAgent: pairPeer(room, agentId) !== undefined, // K3: a room of two with an agent – the answer reaches it
          personPair: personPair(room, agentId), changed: (attempt.tools ?? []).some(effectful), // B-059 #42: a plain answer in the person's 1:1 notifies
          postedElse: () => runPosted(services.db, conversationId!, request.runId, messageId),
        });
        if (visibility === 'internal' && files.length) visibility = 'silent'; // engine files cannot live in the run journal
        if (visibility !== 'internal') {
          // B-050 K4: [[important]] on a posted, notifying answer marks it important (delivery's brake still applies).
          const final = { body, meta, silent: visibility === 'silent', ...(important && visibility === 'notify' ? { priority: 'important' as const } : {}), ...(files.length ? { files } : {}) };
          finalMessage = messageId
            ? services.chats.finishAgentMessage(messageId, { ...final, state: 'final' })
            : services.chats.postAgentMessage(conversationId!, agentId, request.runId, final);
          visibility = finalMessage.silent ? 'silent' : 'notify'; // a mention of the person is loud
          if (blocks.length || apps) ingestTodos(services, finalMessage, blocks);
        }
      }
      if (messageId && !finalMessage) services.chats.removeMessage(messageId, agentId); // empty or internal
      const seen = Math.max(cursor, readTo);
      if (conversationId && seen > plan.memberCursor) services.chats.markRead(conversationId, agentId, seen);
    });
    if (body) saveRepairNotes(services, agentId, thread, repairNotesOf(body));
  } else {
    const partial = parseVisibility(attempt.streamed).body;
    answer = partial;
    const files = result.files ?? [];
    const outage = Boolean(plan.task) && stop !== 'interrupted' && isOutage(stop === 'limit' ? 'limit' : errorOutcome(result.error));
    // The person's stop keeps the turn in its place, marked as stopped (a quiet line without text – its
    // tool steps stay one click away): removing it would move every message above it (B-044 §2).
    // Other interrupts (an important message, a shutdown) and outages leave nothing behind. Without a
    // placeholder (background work) a failure stays in the run journal – an outage still gets its line.
    const stoppedByPerson = stop === 'interrupted' && request.control.stopKind === 'human';
    const placeholder = plan.publish === 'internal' ? undefined : messageId; // B-075: a silent row only showed the work
    if (messageId && !placeholder) services.chats.removeMessage(messageId, agentId);
    if ((stop === 'interrupted' || outage) && !partial && !files.length && !stoppedByPerson) {
      if (placeholder) services.chats.removeMessage(placeholder, agentId);
      if (outage && plan.task) outageLine(services, plan.task, stop === 'limit' ? 'a usage limit was reached' : result.error?.message, request.runId);
    } else if (placeholder) {
      finalMessage = services.chats.finishAgentMessage(placeholder, {
        ...(files.length ? { files } : {}),
        body: partial, state: stop === 'interrupted' ? 'stopped' : 'failed',
        meta: { ...meta, error: stop === 'interrupted' ? undefined : (result.error?.message ?? 'The turn failed.') },
        ...(stoppedByPerson && !partial && !files.length ? { silent: true } : {}), // nothing new to read
      });
      visibility = finalMessage.silent ? 'silent' : 'notify';
    } else if (outage && plan.task) {
      // Background work without a placeholder: its partial text stays in the run journal, the outage still gets its line.
      outageLine(services, plan.task, stop === 'limit' ? 'a usage limit was reached' : result.error?.message, request.runId);
    }
  }
  journalAnswer(services, request.runId, answer, visibility, finalMessage?.id);

  const status = runStatus(stop);
  const cost = priceTurn(services, turn, attempt, request.runId);
  saveRunCost(services, request.runId, cost.run);
  services.runs.finish(request.runId, {
    status, endedAt: services.clock.now(), engine: turn.engine.id, model: turn.route.modelId, effort: turn.route.effort,
    accountId: turn.account.id, route: { reason: turn.route.reason, by: turn.route.by, category: turn.route.category },
    inputTokens: attempt.usage.inputTokens || undefined, outputTokens: attempt.usage.outputTokens || undefined,
    costUsd: cost.run.costUsd, costBasis: cost.run.basis, notionalUsd: cost.run.notionalUsd,
    error: status === 'failed' ? (result.error?.message ?? 'The turn failed.') : undefined,
    summary: summaryOf(finalMessage?.body ?? said),
  });

  // B-076: what the agent did on this turn, readable beside last-prompt.md (context/last-run.ts) – the main lane only, so the
  // two files describe the same turn (a split's parts run beside it; they stay in the run log).
  if (!plan.split) try {
    writeLastRun(services.paths?.data, agentId, {
      runId: request.runId, trigger: request.reason, model: turn.route.modelId, effort: turn.route.effort, status, endedAt: services.clock.now(),
      input: turn.input.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mime}]`)).join('\n\n'),
      items: services.runs.items(request.runId), finalText: finalMessage?.body ?? said,
    }, (text) => services.secrets.redact(text), (message, data) => services.log?.debug(message, data));
  } catch (error) { services.log?.debug('last run not written', { agentId, error: String(error) }); }

  bookTurnCost(services, agentId, request.runId, cost.run);
  // B-044: a chat turn that met an outage – B-059 C9: or a usage limit – is delivered again once an account is usable (redelivery.ts).
  if (!plan.task && conversationId && (stop === 'error' || stop === 'limit')) noteChatOutage(services, { agentId, conversationId, runId: request.runId, cursor: plan.memberCursor, error: result.error, toolCalls: attempt.toolCalls });

  if (plan.task) {
    const task = services.tasks.get(plan.task.id);
    const outcome = taskOutcome(result, task?.status, request.control.stopKind);
    // Progress: the task moved (status or result) or a call did something (turn-types.ts effectful).
    const used = attempt.tools ?? [];
    const moved = task !== undefined && (task.status !== plan.task.status || JSON.stringify(task.result ?? null) !== JSON.stringify(plan.task.result ?? null));
    const names = [...new Set(used.filter(effectful).map((use) => use.name))];
    const approach = [summaryOf(finalMessage?.body ?? said)?.trim(), names.length ? `used ${names.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined;
    try {
      services.ownership.afterTurn({
        agentId, taskId: plan.task.id, runId: request.runId, outcome,
        progressed: moved || used.some(effectful), note: result.error?.message, approach, plan: attempt.plan,
      });
    } catch (error) {
      services.log.warn('ownership.afterTurn failed', { taskId: plan.task.id, error: String(error) });
    }
  }

  if (stop === 'done' && !plan.split) { // B-057 S9: a split gets no compaction pass
    // Without a native session every turn gets the full projection: keep its summary current.
    if (conversationId && !turn.engine.caps.sessions) compactAfterTurn(services, { agentId, conversationId, runId: request.runId });
    // 01.11.2026: the subconscious may run now – its wake check costs no model, the run is fire-and-forget and debounced per chat;
    // the exchange ends where the cursor now stands (the input, steered lines and what chat.read showed).
    services.subconscious?.afterTurn?.({
      agent: plan.agent, ...(conversationId ? { conversationId } : {}), thread, ...(plan.task ? { taskId: plan.task.id } : {}),
      runId: request.runId, mode: plan.mode.key, fromSeq: plan.memberCursor, toSeq: Math.max(turn.lastSeq, request.control.steeredSeq, readTo), reply: answer,
      contextTokens: attempt.usage.contextTokens, contextWindow: turn.contextWindow,
      taskEnded: Boolean(plan.task) && plan.task!.status !== 'done' && services.tasks.get(plan.task!.id)?.status === 'done',
      switchPlanned: (attempt.tools ?? []).some((use) => use.name === 'model.set'),
    });
  }
  splitTurnEnded(services, plan, turn, request, attempt, status); // B-057: a split's end → the split service; the agent's own turn starts / gathers its groups
  return { runId: request.runId, status, messageId: finalMessage?.id, error: status === 'failed' ? result.error?.message : undefined };
}

/** human.ask that did not fail: a human to-do of this turn, also without a taskId (no step of the task then). */
function askedHuman(tools: readonly ToolUse[] | undefined): boolean {
  return (tools ?? []).some((use) => use.name === 'human.ask' && use.ok !== false);
}

/**
 * The turn's input held a new message from the person (human, or a bridged external contact) –
 * read now, its own wake stale. An external agent (C8) is never the person; a quiet line (B-050 K4) expects no answer.
 */
function heardPerson(services: RuntimeServices, conversationId: string | undefined, agentId: string, from: number, to: number): boolean {
  if (!conversationId || to <= from) return false;
  return services.chats.messages(conversationId, { afterSeq: from, limit: 200 }).some((message) => message.seq <= to && awaitsAnswer(message, agentId));
}

function summaryOf(text: string | undefined): string | undefined {
  const line = (text ?? '').split('\n').map((item) => item.trim()).find((item) => item && !item.startsWith('```'));
  return line ? (line.length > 140 ? `${line.slice(0, 140)}…` : line) : undefined;
}
