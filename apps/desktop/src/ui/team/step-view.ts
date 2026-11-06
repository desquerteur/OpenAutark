// Pure helpers for the compact step lines of a run (D5, team/run-items.tsx – the chat's live block,
// the "Worked … · N steps" disclosure and Team › agent › Runs): a tool call's line (the runtime's
// journaled step for engine-native calls, else shared/text/step-label.ts from its name, arguments
// and summary) with its icon, the "Thought · <headline>" line of a reasoning summary, the one-line
// final answer's branch ("Kept internal" / "Posted quietly" / "Posted") and
// the live list's window (the newest few, "+N earlier"). B-075: a run's step values from its chat row (meta.live.steps,
// meta.lines) become the items the same list renders (stepItems) – on every device, without the run journal.
// Owns: these rules (unit-tested in test/unit/ui/step-view.test.ts). Never: imports the store, rpc or the DOM.

import type { LiveStep } from '../../shared/model/chat.ts';
import type { RunItem } from '../../shared/model/runs.ts';
import { reasoningHeadline, stepLabel, type StepKind, type StepLabel } from '../../shared/text/step-label.ts';
import type { IconName } from '../lib/icons.tsx';
import type { RunEntry } from './model.ts';

export const STEP_ICONS: Record<StepKind, IconName> = {
  command: 'terminal-window', read: 'file-text', edit: 'pencil-simple', search: 'magnifying-glass', list: 'folder',
  web: 'globe', browser: 'globe', computer: 'monitor', chat: 'chat-text', task: 'list-checks', agent: 'users',
  memory: 'lightbulb', image: 'image', mcp: 'plugs', plan: 'list-checks', tool: 'wrench',
};

const KINDS = new Set(Object.keys(STEP_ICONS));
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Journaled args are a JSON preview (a string, maybe cut): the object when it still parses. */
export function parsedArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** The line of a tool call: the runtime's own step when it journaled one, else derived here. */
export function callStep(call: Pick<RunItem, 'name' | 'data'>): StepLabel {
  const step = call.data.step as Partial<StepLabel> | undefined;
  if (step && typeof step === 'object' && KINDS.has(str(step.kind)) && typeof step.target === 'string') {
    return { kind: step.kind as StepKind, verb: str(step.verb), active: str(step.active), target: step.target };
  }
  return stepLabel(call.name, parsedArgs(call.data.args), {
    own: call.data.own === true, summary: str(call.data.summary) || undefined, title: str(call.data.title) || undefined,
  });
}

/** "Thought · <headline>": the verb while it is still written, and the headline of its text. */
export function thoughtLine(item: Pick<RunItem, 'data'>, live: boolean): { verb: string; headline: string; text: string; live: boolean } {
  const text = str(item.data.summary);
  const writing = live && item.data.live === true;
  return { verb: writing ? 'Thinking' : 'Thought', headline: reasoningHeadline(text), text, live: writing };
}

/** A reasoning summary as paragraphs; a "**Title**" line is a heading. */
export function thoughtParts(text: string): Array<{ heading: boolean; text: string }> {
  return text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const title = /^\*\*([^*\n]+)\*\*$/.exec(part);
    return title ? { heading: true, text: title[1].trim() } : { heading: false, text: part.replace(/\*\*/g, '') };
  });
}

export type AnswerBranch = 'internal' | 'quiet' | 'posted';

/** The final answer's run item (PUBLISHING, D4: kind 'note', data.answer) – undefined for any other item. */
export function answerOf(item: Pick<RunItem, 'kind' | 'data'>): { branch: AnswerBranch; label: string; text: string } | undefined {
  if (item.kind !== 'note' || item.data.answer !== true) return undefined;
  const visibility = str(item.data.visibility);
  const branch: AnswerBranch = visibility === 'internal' ? 'internal' : visibility === 'silent' || visibility === 'quiet' ? 'quiet' : 'posted';
  const label = branch === 'internal' ? 'Kept internal' : branch === 'quiet' ? 'Posted quietly' : 'Posted';
  return { branch, label, text: str(item.data.text) };
}

/** The live list's window: the newest `max` entries, and how many earlier ones are folded. */
export function liveWindow<T>(entries: readonly T[], max = 6, all = false): { hidden: number; shown: readonly T[] } {
  if (all || entries.length <= max) return { hidden: 0, shown: entries };
  return { hidden: entries.length - max, shown: entries.slice(-max) };
}

/**
 * B-075: step values as run items for RunItemList – a step is a call (its result when it no longer runs, failed
 * when it failed), a thought a reasoning summary ("Thought · <headline>", written while `running`). They carry no
 * input or output: the row never holds one.
 */
export function stepItems(runId: string, steps: readonly LiveStep[]): RunItem[] {
  const items: RunItem[] = [];
  steps.forEach((step, index) => {
    const base = { runId, createdAt: 0, effectStatus: 'none' as const };
    if (step.thought) {
      items.push({ ...base, id: `${runId}:${index}`, seq: items.length, kind: 'reasoning', data: { summary: `**${step.target}**`, live: step.running === true } });
      return;
    }
    const callId = `${runId}:${index}`;
    items.push({ ...base, id: callId, seq: items.length, kind: 'tool_call', data: { callId, step: { kind: step.kind, verb: step.verb, active: step.active, target: step.target } } });
    if (!step.running) items.push({ ...base, id: `${callId}:result`, seq: items.length, kind: 'tool_result', data: { callId, ok: step.failed !== true } });
  });
  return items;
}

/** True for an entry the person reads as a line (not a reasoning item without words, not an answer's later journal part). */
export function shownEntry(entry: RunEntry): boolean {
  if (entry.kind === 'tool') return true;
  if (entry.item.kind === 'reasoning') return str(entry.item.data.summary).trim() !== '';
  if (answerOf(entry.item)) return typeof entry.item.data.part !== 'number' || entry.item.data.part <= 1;
  return true;
}
