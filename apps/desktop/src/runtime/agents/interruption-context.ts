// Owns: a small durable input marker and app-authored interruption/retry context for every turn thread.
// Short, unchanged retries keep their input. Longer pauses or changed input get timestamps and event references;
// the original messages, wake notes and previous-action recap still carry their full content.
// Never: invents a tool call, infers that a connection recovered, schedules retries, or duplicates message bodies.

import { createHash } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { Run, RunItem } from '../../shared/model/runs.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { recapScope, unfinishedRuns } from '../context/recent-actions.ts';
import { CLOSED_ERROR } from '../runs/journal.ts';
import { CRASH_ERROR } from '../store/runs.ts';
import { KvRepo } from '../store/kv.ts';
import type { TurnPlan, TurnRequest } from './turn-types.ts';

export const BRIEF_INTERRUPTION_MS = 60_000;
const INPUT = 'turnInput';
type Services = Pick<RuntimeServices, 'db' | 'runs' | 'chats' | 'clock' | 'secrets' | 'log'>;
interface InputMark { runId: string; lastSeq: number; taskKey?: string; notesAt: number }
const keyOf = (plan: TurnPlan) => `${plan.agent.id}:${plan.thread}`;

function taskKey(plan: TurnPlan): string | undefined {
  const task = plan.task;
  return task ? createHash('sha256').update(JSON.stringify([task.title, task.notes, task.goal, task.doneWhen, task.assigneeKind, task.assigneeId, task.mode, task.priority, task.dueAt])).digest('hex') : undefined;
}

/** One latest marker per thread; no bodies, prompts or credentials are copied into it. */
export function recordTurnInput(s: Services, plan: TurnPlan, request: TurnRequest, lastSeq: number): void {
  try {
    const mark: InputMark = { runId: request.runId, lastSeq, taskKey: taskKey(plan), notesAt: Math.max(0, ...request.notes.map(note => note.at)) };
    new KvRepo(s.db).set(INPUT, keyOf(plan), mark, s.clock.now());
  } catch (error) {
    s.log.warn('interruption input marker not recorded', { runId: request.runId, error: String(error) });
  }
}

function stamp(at: number, timezone?: string): string {
  const date = new Date(at);
  try { return date.toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' }); }
  catch { return date.toISOString(); }
}

function interruption(s: Services, run: Run, items: RunItem[]): { at: number; text: string } {
  const restart = run.error === CRASH_ERROR || run.error === CLOSED_ERROR;
  const lastActivity = items.at(-1)?.createdAt ?? run.startedAt ?? s.clock.now();
  const at = restart ? lastActivity : run.endedAt ?? lastActivity;
  const text = restart
    ? 'Last recorded activity before the app stopped. The interruption time is unknown; the app has restarted.'
    : run.error || 'The previous attempt was interrupted.';
  return { at, text: s.secrets.redact(text).replace(/\s+/g, ' ').slice(0, 300) };
}

/** System markers surround the actual input; they are app events, never messages or the AI's own tool calls. */
export function interruptionContext(s: Services, plan: TurnPlan, request: TurnRequest, lastSeq: number, timezone?: string): { before?: string; after?: string } {
  try {
    const runs = unfinishedRuns(s, recapScope(plan), request.runId)
      .filter(run => run.id !== request.runId && ['failed', 'interrupted', 'unknown'].includes(run.status));
    const active = request.interruption ? s.runs.get(request.runId) : undefined;
    if (active && request.interruption) runs.unshift({ ...active, status: 'failed', endedAt: request.interruption.at, error: request.interruption.reason });
    if (!runs.length) return {};
    const latest = runs[0];
    const items = s.runs.items(latest.id);
    const stored = new KvRepo(s.db).get<InputMark>(INPUT, keyOf(plan));
    const mark = stored?.runId === latest.id ? stored : undefined;
    const oldest = runs.at(-1)!;
    const first = interruption(s, oldest, oldest.id === latest.id ? items : s.runs.items(oldest.id));
    const now = s.clock.now();
    const since = latest.startedAt ?? first.at;
    const messages = plan.conversationId ? s.chats.messages(plan.conversationId, { beforeSeq: lastSeq + 1, limit: 60 })
      .filter(message => message.seq > (mark?.lastSeq ?? plan.memberCursor) && message.authorId !== plan.agent.id
        && (message.kind !== 'status' || (isAgentNotice(message) && message.meta.status?.details?.by !== plan.agent.id))
        && (mark !== undefined || message.createdAt > since)) : [];
    const notes = request.notes.filter(note => note.at > (mark?.notesAt ?? since) && (note.reason ?? request.reason) !== 'retry');
    const changedTask = Boolean(mark?.taskKey && mark.taskKey !== taskKey(plan));
    const changed = messages.length > 0 || notes.length > 0 || changedTask;
    if (!changed && now - first.at < BRIEF_INTERRUPTION_MS) return {};

    const events = runs.slice(0, 3).map(run => interruption(s, run, run.id === latest.id ? items : s.runs.items(run.id)));
    if (runs.length > 3) events.push({ at: first.at, text: `${runs.length} recent attempts were interrupted; the latest three are listed.` });
    for (const note of notes) events.push({ at: note.at, text: `${(note.reason ?? request.reason) === 'schedule' ? 'Scheduled event' : 'New event'} (see its note below).` });
    if (messages.length > 6) events.push({ at: messages[0].createdAt, text: `${messages.length} new chat inputs; the latest six are listed (see the messages below).` });
    for (const message of messages.slice(-6)) events.push({ at: message.createdAt, text: `${isAgentNotice(message) ? 'Changed' : 'New'} chat input #${message.seq} (see the message below).` });
    if (changedTask) events.push({ at: now, text: 'The task input has changed; its current details are in my context.' });
    events.sort((a, b) => a.at - b.at);
    const before = ['[App system events: interrupted work]', ...events.map(event => `${stamp(event.at, timezone)} — ${event.text}`)].join('\n');
    const elapsed = Math.max(0, Math.floor((now - first.at) / 1000));
    const sinceRestart = oldest.error === CRASH_ERROR || oldest.error === CLOSED_ERROR;
    const after = `[App system event: ${stamp(now, timezone)}] Retrying now, ${elapsed}s ${sinceRestart ? 'since the last recorded activity before restart' : 'after the earliest interruption in this context'}${changed ? '; input changed' : '; no new input'}. I continue from the current input and previous actions and check uncertain effects before repeating them.`;
    return { before, after };
  } catch (error) {
    s.log.warn('interruption context not assembled', { runId: request.runId, error: String(error) });
    return {};
  }
}
