// B-075: feeds a run's row (chat/streaming.ts) from what the run does on this PC – its journaled steps ('run.item': a
// tool call as its step label, running until its result, failed when that says so; a reasoning summary as
// "Thought · <headline>") and the dispatcher's live activity ('agent.activity': the note – also a waiting or approval
// note –, the model it runs on now · effort). Notes, plans, updates and every tool's input and output stay in the run
// journal (Team › Runs); the row only names the step.
// Also declares the chat service's quiet row (beginAgentMessage `silent`): a run whose answer is kept internal shows
// its work in a silent row that goes at the end when nothing was posted (agents/turn.ts, agents/turn-finish.ts).
// Owns: the step values a run item becomes (itemStep, thoughtStep) and the feed's two listeners.
// Never: writes a row itself (streaming.ts does, throttled), or copies a tool's output into a row.

import type { Bus } from '../bus.ts';
import type { LiveStep, Message, MessageMeta } from '../../shared/model/chat.ts';
import type { RunItem } from '../../shared/model/runs.ts';
import { oneLine, reasoningHeadline, stepLabel, type StepKind } from '../../shared/text/step-label.ts';
import type { StreamingRows } from './streaming.ts';

declare module '../contracts.ts' {
  interface ChatService {
    /** B-075: `silent` – a run's row that only shows its work (its answer is kept internal unless the finish posts it). */
    beginAgentMessage(conversationId: string, agentId: string, runId: string, meta?: MessageMeta, options?: { silent?: boolean }): Message;
  }
}

/** A step's target in a row (the journal keeps the longer one). */
const TARGET_MAX = 100;
const KINDS: ReadonlySet<string> = new Set<StepKind>([
  'command', 'read', 'edit', 'search', 'list', 'web', 'browser', 'computer', 'chat', 'task', 'agent', 'memory', 'image', 'mcp', 'plan', 'tool',
]);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function parsedArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** A tool call's step: the step the runtime journaled (engine-native calls), else its label from name, arguments and summary. */
export function itemStep(call: Pick<RunItem, 'name' | 'data'>): LiveStep {
  const journaled = call.data.step as Partial<LiveStep> | undefined;
  const step = journaled && typeof journaled === 'object' && KINDS.has(str(journaled.kind)) && typeof journaled.target === 'string'
    ? { kind: journaled.kind as StepKind, verb: str(journaled.verb), active: str(journaled.active), target: journaled.target }
    : stepLabel(call.name, parsedArgs(call.data.args), { own: call.data.own === true, summary: str(call.data.summary) || undefined, title: str(call.data.title) || undefined });
  return { kind: step.kind, verb: step.verb, active: step.active, target: oneLine(step.target, TARGET_MAX) };
}

/** A reasoning summary's line ("Thought · <headline>"); undefined while it has no words. */
export function thoughtStep(item: Pick<RunItem, 'data'>): LiveStep | undefined {
  const headline = reasoningHeadline(str(item.data.summary));
  if (!headline) return undefined;
  return { kind: 'plan', verb: 'Thought', active: 'Thinking', target: headline, thought: true, ...(item.data.live === true ? { running: true as const } : {}) };
}

/** Applies one journaled item to its run's row (its call's step, its result, a thought). */
export function applyItem(rows: Pick<StreamingRows, 'step'>, item: RunItem): void {
  const callId = str(item.data.callId);
  if (item.kind === 'tool_call') {
    rows.step(item.runId, `call:${callId || item.id}`, (current) => current ?? { ...itemStep(item), running: true });
  } else if (item.kind === 'tool_result' && callId) {
    rows.step(item.runId, `call:${callId}`, (current) => {
      if (!current) return undefined;
      const { running: _running, failed: _failed, ...rest } = current;
      return item.data.ok === false ? { ...rest, failed: true } : rest;
    });
  } else if (item.kind === 'reasoning') {
    const step = thoughtStep(item);
    if (step) rows.step(item.runId, `thought:${item.id}`, () => step);
  }
}

/** Starts the feed; returns its stop. A failure here never touches the run (logged). */
export function feedLiveRows(bus: Bus, rows: StreamingRows, warn: (message: string, error: unknown) => void = () => {}): () => void {
  const offs = [
    bus.on('run.item', (item) => {
      if (!rows.byRun(item.runId)) return;
      try { applyItem(rows, item); } catch (error) { warn('live step not written', error); }
    }),
    bus.on('agent.activity', ({ active }) => {
      for (const entry of active) {
        if (entry.split || !rows.byRun(entry.runId)) continue;
        try { rows.note(entry.runId, { note: entry.note, model: entry.modelName ?? entry.model, effort: entry.effort }); } catch (error) { warn('live note not written', error); }
      }
    }),
  ];
  return () => { for (const off of offs) off(); };
}
