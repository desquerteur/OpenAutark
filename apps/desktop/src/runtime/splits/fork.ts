// Seeding a split's native session (B-057 S4): a 'fork' part starts as its parent with the context the parent had at the
// split, tried in this order – the first that works wins, a failure falls to the next and is recorded:
// (a) a native engine fork – the worker's routed engine has caps.fork, the parent's splitting run ran on that engine and
//     account, the parent has a session binding for (agent, its thread, that engine) on the worker's account, the
//     worker's model window holds it, and the parent's session has not moved on since the group started (a binding
//     saved after it, or a turn of the parent running there now): engine.fork (Codex thread/fork, Claude --resume
//     --fork-session) – also with another model or effort of that account;
// (b) else a text fallback – the checkpoint of the parent's task (context.checkpoint: goal, done, open, constraints,
//     artifacts – no "next step": the part is the worker's next step) and the chat lines the parent had seen (context.delta
//     up to its read cursor – the summary included, redacted, the section headers relabelled), bounded to TEXT_CHARS,
//     returned as `inputPrefix`; nothing to carry (e.g. a mailbox thread) → fresh.
// A 'brief' part starts fresh. The turn pipeline (agents/turn-prepare.ts chooseSession) calls this for a split's first turn
// when its thread `split:<id>` has no binding yet, binds `ref` under (agent, split thread, engine) with the current
// promptKey and puts `inputPrefix` in front of the turn's input. The choice is noted on the worker's run
// ({splitSeed: how, parentRef?, fellBack?} – not for a brief), recorded as the split's `fork` (services.splits.markFork)
// and returned.
// Owns: that choice, the seeding, the note and the record. Never: touches the parent's native session or binding, or
// binds the result itself.

import type { RuntimeServices } from '../contracts.ts';
import type { Engine } from '../engines/types.ts';
import type { TurnPlan } from '../agents/turn-types.ts';
import type { ToolSpec } from '../tools/types.ts';
import type { Account, Effort, RouteDecision } from '../../shared/model/providers.ts';
import type { Handoff } from '../../shared/model/knowledge.ts';
import type { SplitFork, SplitTurn } from '../../shared/model/splits.ts';
import { threadKey } from '../../shared/model/origin.ts';
import { SessionStore, type SessionBinding } from '../agents/sessions.ts';
import { SplitRepo } from '../store/splits.ts';
import { needsRenewal } from '../agents/compaction-policy.ts';
import { turnCwd } from '../git/records.ts';
import { PROJECTION, quoteHeaders } from '../context/projection.ts';

/** The text fallback's size: the checkpoint gets at most CHECKPOINT_CHARS, the newest chat lines the rest. */
export const TEXT_CHARS = 6_000;
const CHECKPOINT_CHARS = 2_000;
const TEXT_HEAD = "Note from the app – my main self's context at the split, as text (this session did not inherit it):";
/** The projection's section headers as plain labels, so the prefix never reads as a projection of this session's own. */
const RELABEL = new Map<string, string>([
  [PROJECTION.summary, 'Summary of older messages (by the app):'],
  [PROJECTION.earlier, 'Messages I had seen:'],
]);

/** The worker turn's route as buildTurn resolved it (RoutedTurn's engine, account and provider model, plus the effort it runs with). */
export interface SeedRoute {
  route: RouteDecision;
  engine: Engine;
  account: Account;
  /** Provider model id of the worker's turn. */
  model: string;
  effort: Effort;
}

export interface SeedArgs {
  /** The worker turn's plan (plan.split === split, plan.thread === `split:<id>`). */
  plan: TurnPlan;
  split: SplitTurn;
  route: SeedRoute;
  /** The turn's native dynamic tools (byte-identical to the parent's offer – S8). */
  tools: ToolSpec[];
  /** Every tool name the turn offers (native and through the hub), sorted – ToolOffer.names. */
  toolNames: string[];
  /** The turn's prompt sections as the engine gets them. */
  system: { stable: string; volatile: string };
  /** The turn's prompt key (session-key.ts promptKey of system.stable + toolNames). */
  promptKey: string;
  /** The worker's folder (its worktree, else the parent's). */
  cwd?: string;
  runId: string;
}

export interface SeedResult {
  how: SplitFork['how'];
  /** The new native session (native fork); absent: the turn starts a new one. */
  ref?: string;
  generation?: number;
  /** Text put in front of the turn's input (the text fallback). */
  inputPrefix?: string;
  /** B-057 C: the parent's session a native fork copied (SplitFork.parentRef). */
  parentRef?: string;
  /** B-057 C: why the earlier ways did not seed it ("native: …"). */
  fellBack?: string[];
}

type Way = (s: RuntimeServices, args: SeedArgs, cwd: string) => Promise<SeedResult | string>;

export async function seedSplitSession(s: RuntimeServices, args: SeedArgs): Promise<SeedResult> {
  if (args.split.context === 'brief') {
    mark(s, args, { how: 'fresh' });
    return { how: 'fresh' };
  }
  const fellBack: string[] = [];
  const cwd = args.cwd ?? args.split.cwd ?? turnCwd(s, args.plan.task, args.plan.agent.id);
  let result: SeedResult | undefined;
  for (const [name, way] of [['native', nativeFork]] as Array<[string, Way]>) {
    try {
      const outcome = await way(s, args, cwd);
      if (typeof outcome !== 'string') { result = outcome; break; }
      fellBack.push(`${name}: ${outcome}`);
    } catch (error) {
      fellBack.push(`${name}: ${reason(error)}`);
    }
  }
  result ??= textSeed(s, args, fellBack);
  if (fellBack.length) result.fellBack = fellBack;
  note(s, args.runId, result);
  mark(s, args, result);
  return result;
}

/** (a) The native fork of the parent's session on the worker's engine and account; a string says why not. */
async function nativeFork(s: RuntimeServices, args: SeedArgs, cwd: string): Promise<SeedResult | string> {
  const { engine, account } = args.route;
  if (!engine.caps.fork || !engine.fork) return 'the engine cannot fork';
  const agentId = args.plan.agent.id;
  // S4a: only the session the parent's splitting turn ran on – a binding of this engine from an older turn (the agent
  // switched engine or account since) would lack the parent's recent context, the split itself included.
  const ran = s.runs.get(args.split.parentRunId);
  if (ran?.engine && ran.engine !== engine.id) return "the parent's turn ran on another engine";
  if (ran?.accountId && ran.accountId !== account.id) return "the parent's turn ran on another account";
  const thread = args.split.parentThread;
  const parent = thread ? new SessionStore(s.db).get(agentId, thread, engine.id) : undefined;
  if (!parent) return 'the parent has no session on this engine';
  if (parent.accountId !== account.id) return 'the parent session belongs to another account';
  if (needsRenewal(parent.contextTokens, windowOf(s, args))) return "the parent session exceeds the worker model's limit";
  const moved = movedOn(s, args.split, agentId, parent);
  if (moved) return moved;
  const forked = await engine.fork({ runId: args.runId, agentId, account, parentRef: parent.ref, cwd, model: args.route.model });
  if (!forked.ref || forked.ref === parent.ref) throw new Error('the engine gave no new session');
  return { how: 'native', ref: forked.ref, generation: forked.generation ?? 1, parentRef: parent.ref };
}

/**
 * A fork copies the parent's session as it is now: why not, when it moved on since the group started – its binding was
 * saved after that (a later turn of the parent on that thread), or a turn of the parent runs there now.
 */
function movedOn(s: RuntimeServices, split: SplitTurn, agentId: string, parent: SessionBinding): string | undefined {
  let startedAt: number | undefined;
  try { startedAt = new SplitRepo(s.db).getGroup(split.groupId)?.startedAt; } catch { startedAt = undefined; }
  if (startedAt !== undefined && parent.updatedAt > startedAt) return "the parent's session moved on since the split (no turn to fork through)";
  const running = s.db.all<{ conversation_id: string | null; task_id: string | null; source: string | null }>(
    `SELECT conversation_id, task_id, source FROM runs WHERE agent_id = ? AND status = 'running' AND split_id IS NULL AND id <> ?`, [agentId, split.parentRunId]);
  const busy = running.some((run) => threadKey({ conversationId: run.conversation_id ?? undefined, taskId: run.task_id ?? undefined,
    ...(run.source ? { origin: { source: run.source, label: run.source } } : {}) }) === split.parentThread);
  return busy ? "the parent is working on that thread right now (no turn to fork through)" : undefined;
}

/** (b) The parent's checkpoint and the chat lines it had seen as text in front of the worker's input; fresh when there is nothing. */
function textSeed(s: RuntimeServices, args: SeedArgs, fellBack: string[]): SeedResult {
  const agentId = args.plan.agent.id;
  const chat = args.split.parentConversationId;
  const taskId = args.split.parentTaskId;
  let checkpoint = '';
  // A task's checkpoint (goal, steps done and open …); a chat alone has none worth more than its lines – its checkpoint
  // would name the chat's newest request, which may be a line the parent had not seen at the split.
  if (taskId) {
    try { checkpoint = clip(quoteHeaders(checkpointText(s.context.checkpoint({ agentId, taskId, conversationId: chat }))), CHECKPOINT_CHARS); }
    catch (error) { fellBack.push(`checkpoint: ${reason(error)}`); }
  }
  let lines = '';
  if (chat) {
    try { lines = seenLines(s.context.delta({ agent: args.plan.agent, conversationId: chat, sinceSeq: cursorOf(s, chat, agentId), full: true }).text); }
    catch (error) { fellBack.push(`chat lines: ${reason(error)}`); }
  }
  const room = TEXT_CHARS - TEXT_HEAD.length - checkpoint.length - 64; // the labels, the blank lines and the cut mark
  const recent = tail(lines, room);
  if (!checkpoint.trim() && !recent.trim()) return { how: 'fresh' };
  const parts = [TEXT_HEAD, checkpoint && `My state:\n${checkpoint}`, recent && `Recent chat lines:\n${recent}`];
  return { how: 'text', inputPrefix: parts.filter(Boolean).join('\n\n') };
}

/** The checkpoint as text, without its "next step" (the worker's part is its next step). */
export function checkpointText(handoff: Handoff): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  return [
    handoff.goal && `Goal: ${handoff.goal}`,
    handoff.verified.length && `Done so far:\n${list(handoff.verified)}`,
    handoff.open.length && `Open:\n${list(handoff.open)}`,
    handoff.constraints?.length && `Constraints:\n${list(handoff.constraints)}`,
    handoff.artifacts.length && `Artifacts:\n${list(handoff.artifacts.map((item) => `${item.label}: ${item.ref}`))}`,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

/** A full projection (delta.ts) without its new part (lines the parent had not seen) and with its headers relabelled. */
export function seenLines(projection: string): string {
  const lines = projection.split('\n');
  if (!lines.some((line) => RELABEL.has(line))) return ''; // no history part: every line is one the parent had not seen
  const fresh = lines.findIndex((line, index) => line === PROJECTION.fresh && (index === 0 || lines[index - 1] === ''));
  return (fresh < 0 ? lines : lines.slice(0, fresh)).map((line) => RELABEL.get(line) ?? line).join('\n').trim();
}

/** The parent's read cursor in its chat (the lines it had seen); 0 when it is no member. */
function cursorOf(s: RuntimeServices, chat: string, agentId: string): number {
  try { return s.chats.members(chat).find((member) => member.memberId === agentId && !member.leftAt)?.readSeq ?? 0; } catch { return 0; }
}

/** The worker model's context window (the catalog's), for the renewal limit. */
function windowOf(s: RuntimeServices, args: SeedArgs): number | undefined {
  try { return s.catalog.get(args.route.route.modelId)?.caps.contextTokens; } catch { return undefined; }
}

/** The last `max` characters of `text` from a line start, marked as cut. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  const cut = text.slice(text.length - max);
  const start = cut.indexOf('\n');
  return `(older lines cut)\n${start >= 0 ? cut.slice(start + 1) : cut}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** The split's `fork` record (Split.fork, shown on its view): how, and for a seeded session its engine, account and parent. */
function mark(s: RuntimeServices, args: SeedArgs, result: SeedResult): void {
  const seeded = result.how === 'native';
  const fork: SplitFork = {
    how: result.how, ...(seeded ? { engine: args.route.engine.id, accountId: args.route.account.id } : {}), ...(result.parentRef ? { parentRef: result.parentRef } : {}),
  };
  try { s.splits?.markFork?.(args.split.splitId, fork); } catch { /* the view only */ }
}

function note(s: RuntimeServices, runId: string, result: SeedResult): void {
  try {
    s.runs.item(runId, { kind: 'note', data: { splitSeed: result.how, ...(result.parentRef ? { parentRef: result.parentRef } : {}), ...(result.fellBack ? { fellBack: result.fellBack } : {}) }, effectStatus: 'none' });
  } catch { /* journal only */ }
}
