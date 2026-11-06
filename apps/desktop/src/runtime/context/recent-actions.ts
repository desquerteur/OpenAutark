// What an agent already did in attempts that did not finish (PR3): the tool calls of its runs in
// this chat (or task) that did not end 'done', since its last 'done' run there – including the
// current run after a failover. Another engine or account, a new session or a stateless engine
// does not know them, so the turn input gets them as "Previous attempt (not visible in the
// chat)", with "verify before repeating" on every effect whose outcome is unknown. turn.ts also
// asks here whether every effect of the current run is known before it fails over after tool calls.
// B-047 D4: also the agent's latest final answers in this chat (or task) that stayed in its run log
// (run items 'Answer' with visibility 'internal', agents/publishing.ts) – at most 3, ≈ 1500
// characters – for a new session or a stateless engine, which cannot know them from the chat.
// B-054: a third scope – a run with neither chat nor task is scoped by its origin's source (runs.source): the agent's
// earlier chat-free, task-free runs of that source (a mailbox's earlier mail runs) – so a mail run on day 2 sees what
// the earlier mail runs did and answered. Compaction stays chat-only.
// B-057: a split's runs (Run.splitId) belong only to that split's own scope – never to its main self's chat, task or source
// (read apart through the journal's listBySplit / listTopLevel, so a group's many split runs never crowd the window).
// B-075 (owner 04.11.2026): the texts speak as the agent itself ("My latest answers …", "I verify before repeating").
// Owns: selecting those calls and answers, their outcome, redaction and the bounds (≤ 15 lines, ≤ 3000
// characters). Never: repeats, cancels or judges an action, or shows raw tool output.

import type { RuntimeServices } from '../contracts.ts';
import type { Run, RunItem } from '../../shared/model/runs.ts';

export const RECAP_LIMITS = { lines: 15, chars: 3000, runs: 30, action: 180 } as const;
export const RECAP_TITLE = 'Previous attempt (not visible in the chat):';
const VERIFY = 'effect unknown – I verify before repeating'; // engines/fake.ts finds "verify before repeating"

export type ActionOutcome = 'done' | 'failed' | 'unknown';

export interface RecentAction {
  at: number;
  runId: string;
  engine?: string;
  accountId?: string;
  tool: string;
  text: string;
  outcome: ActionOutcome;
}

export interface RecapScope {
  agentId: string;
  conversationId?: string;
  taskId?: string;
  /** B-054: the origin's source, the scope of a run with neither chat nor task. */
  source?: string;
  /** B-057: a split's turn – only that split's own runs. */
  splitId?: string;
}

/** The recap scope of a planned turn: its chat, task and – B-054 – its origin's source; B-057: a split's own runs. */
export function recapScope(plan: { agent: { id: string }; conversationId?: string; task?: { id: string }; origin?: { source: string }; split?: { splitId: string } }): RecapScope {
  return { agentId: plan.agent.id, conversationId: plan.conversationId, taskId: plan.task?.id, ...(plan.origin ? { source: plan.origin.source } : {}), ...(plan.split ? { splitId: plan.split.splitId } : {}) };
}

type Services = Pick<RuntimeServices, 'runs' | 'secrets'>;

/** The chat; else the task; else (B-054) chat-free, task-free runs of the same source. B-057: a split's runs only in its own scope. */
function inScope(run: Run, scope: RecapScope): boolean {
  if (scope.splitId || run.splitId) return run.splitId === scope.splitId;
  if (scope.conversationId) return run.conversationId === scope.conversationId;
  if (scope.taskId) return run.taskId === scope.taskId;
  return Boolean(scope.source) && !run.conversationId && !run.taskId && run.origin?.source === scope.source;
}

const scoped = (scope: RecapScope) => Boolean(scope.conversationId || scope.taskId || scope.source || scope.splitId);

/** B-057: the runs a scope reads, newest first – a split's own runs, else the agent's own turns, so its splits' runs never crowd them out of the window. */
function scopeRuns(s: Pick<RuntimeServices, 'runs'>, scope: RecapScope): Run[] {
  if (scope.splitId && s.runs.listBySplit) return s.runs.listBySplit([scope.splitId]).reverse().slice(0, RECAP_LIMITS.runs);
  return s.runs.listTopLevel?.(scope.agentId, RECAP_LIMITS.runs) ?? s.runs.list(scope.agentId, RECAP_LIMITS.runs);
}

function redact(s: Services, text: string): string {
  try { return s.secrets.redact(text); } catch { return text; } // the journal preview is redacted already
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Outcome of one tool call: an effect status our external tools settled decides; everything
 * else – engine-native calls and our internal tools (effect 'none', e.g. shell.exec,
 * files.write) – by its result item: none (cut off by a crash or a stop) is unknown, ok:false failed.
 * `results`: the run's tool_result items by call id. Also the guard's and the nudge's tool summary (subconscious/turn-tools.ts).
 */
export function outcomeOf(call: RunItem, results: ReadonlyMap<string, RunItem>): ActionOutcome {
  if (call.data.own !== true) {
    if (call.effectStatus === 'pending' || call.effectStatus === 'unknown') return 'unknown';
    if (call.effectStatus === 'failed') return 'failed';
    if (call.effectStatus === 'confirmed') return 'done';
  }
  const result = results.get(String(call.data.callId ?? ''));
  if (!result) return 'unknown';
  return result.data.ok === false ? 'failed' : 'done';
}

function actionsOf(s: Services, run: Run): RecentAction[] {
  let items: RunItem[];
  try { items = s.runs.items(run.id); } catch { return []; }
  const results = new Map(items.filter((item) => item.kind === 'tool_result' && item.data.callId).map((item) => [String(item.data.callId), item]));
  return items.filter((item) => item.kind === 'tool_call' && item.name).map((call) => {
    const args = typeof call.data.args === 'string' ? call.data.args : JSON.stringify(call.data.args ?? {}); // the journal keeps a redacted preview string
    const described = typeof call.data.summary === 'string' && call.data.summary ? call.data.summary : args;
    return {
      at: call.createdAt, runId: run.id, engine: run.engine, accountId: run.accountId, tool: call.name!,
      text: oneLine(redact(s, described), RECAP_LIMITS.action), outcome: outcomeOf(call, results),
    };
  });
}

/** Tool calls of the not-done runs since the agent's last done run in this scope, oldest first. */
export function recentActions(s: Services, scope: RecapScope, currentRunId?: string): RecentAction[] {
  return unfinishedRuns(s, scope, currentRunId).reverse().flatMap((run) => actionsOf(s, run));
}

/** Unfinished attempts since the last successful turn in this scope, newest first (including the current run). */
export function unfinishedRuns(s: Pick<RuntimeServices, 'runs'>, scope: RecapScope, currentRunId?: string): Run[] {
  if (!scoped(scope)) return [];
  let runs: Run[];
  try { runs = scopeRuns(s, scope).filter((run) => inScope(run, scope) || run.id === currentRunId); } catch { return []; }
  const open: Run[] = [];
  for (const run of runs) { // newest first: stop at the last done one
    if (run.status === 'done' && run.id !== currentRunId) break;
    open.push(run);
  }
  return open;
}

/** Whether the engine that runs now can know these calls (same engine and account, an existing session). */
export function needsRecap(actions: readonly RecentAction[], now: { engine: string; accountId: string; sessionNew: boolean; stateless: boolean }): boolean {
  if (!actions.length) return false;
  if (now.sessionNew || now.stateless) return true;
  return actions.some((action) => action.engine !== now.engine || action.accountId !== now.accountId);
}

/** "Previous attempt …" with one line per call (the newest when there are more), or undefined. */
export function recapText(actions: readonly RecentAction[], timezone?: string): string | undefined {
  if (!actions.length) return undefined;
  const time = (at: number) => {
    try { return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }); } catch { return new Date(at).toISOString().slice(11, 16); }
  };
  const label: Record<ActionOutcome, string> = { done: 'done', failed: 'failed', unknown: VERIFY };
  const lines = actions.map((action) => `- ${time(action.at)} ${action.tool}: ${action.text} → ${label[action.outcome]}`);
  let kept = lines.slice(-RECAP_LIMITS.lines);
  const header = () => [RECAP_TITLE, ...(lines.length > kept.length ? [`(${lines.length - kept.length} earlier actions not shown)`] : [])];
  while (kept.length > 1 && [...header(), ...kept].join('\n').length > RECAP_LIMITS.chars) kept = kept.slice(1);
  const text = [...header(), ...kept].join('\n');
  return text.length > RECAP_LIMITS.chars ? `${text.slice(0, RECAP_LIMITS.chars - 1)}…` : text;
}

export const ANSWERS_LIMITS = { answers: 3, chars: 1500, runs: 15 } as const;
export const ANSWERS_TITLE = 'My latest answers that stayed in my run log (not in the chat):';
/** The run item name of a final answer (agents/publishing.ts ANSWER_ITEM). */
const ANSWER_ITEM = 'Answer';

/** The agent's latest internal final answers in this scope (not the current run's), oldest first. */
export function internalAnswers(s: Services, scope: RecapScope, currentRunId?: string): Array<{ at: number; text: string }> {
  if (!scoped(scope)) return [];
  let runs: Run[];
  try { runs = scopeRuns(s, scope).filter((run) => run.id !== currentRunId && inScope(run, scope)).slice(0, ANSWERS_LIMITS.runs); } catch { return []; }
  const found: Array<{ at: number; text: string }> = [];
  for (const run of runs) { // newest first
    let parts: RunItem[];
    try { parts = s.runs.items(run.id).filter((item) => item.kind === 'note' && item.name === ANSWER_ITEM && item.data.answer === true && item.data.visibility === 'internal'); } catch { continue; }
    if (!parts.length) continue;
    found.push({ at: parts[0].createdAt, text: parts.map((part) => String(part.data.text ?? '')).join('') });
    if (found.length >= ANSWERS_LIMITS.answers) break;
  }
  return found.reverse();
}

/** "My latest answers …" with one line per answer (the newest kept when the bound is reached), or undefined. */
export function answersRecap(s: Services, scope: RecapScope, currentRunId: string | undefined, timezone?: string): string | undefined {
  const answers = internalAnswers(s, scope, currentRunId);
  if (!answers.length) return undefined;
  const each = Math.floor((ANSWERS_LIMITS.chars - ANSWERS_TITLE.length) / answers.length) - 20; // "- 28 Oct, 14:03: " and the newline: three long answers fit
  let lines = answers.map((answer) => `- ${clock(answer.at, timezone)}: ${oneLine(redact(s, answer.text), each)}`);
  while (lines.length > 1 && [ANSWERS_TITLE, ...lines].join('\n').length > ANSWERS_LIMITS.chars) lines = lines.slice(1);
  return [ANSWERS_TITLE, ...lines].join('\n');
}

function clock(at: number, timezone?: string): string {
  try { return new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }); } catch { return new Date(at).toISOString().slice(0, 16).replace('T', ' '); }
}

/**
 * True when every tool call of this run has a known outcome (a failover may continue elsewhere) –
 * and the journal holds at least the `calls` the attempt counted (a call it cannot see is unknown).
 */
export function effectsKnown(s: Services, runId: string, calls = 0): boolean {
  let run: Run | undefined;
  try { run = s.runs.get(runId); } catch { return false; }
  if (!run) return false;
  const actions = actionsOf(s, run);
  return actions.length >= calls && actions.every((action) => action.outcome !== 'unknown');
}
