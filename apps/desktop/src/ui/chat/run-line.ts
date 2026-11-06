// Pure helpers for the lines around a run's steps in a chat (D5): the live line under the live
// block (the agent's newest words while it writes them, publishing tags stripped, else its live status – "Working" when
// that only repeats the newest step or thought –, "Stopped · <last step>" for a run the person stopped) and the
// collapsed line above a finished answer ("Worked 2 min · 6 steps", or "Thought for 12 s" for a
// run that only reasoned – its live "Thought · …" lines do not vanish without a trace). The newest
// words alone (liveWords) also fill the chat header's working popover (B-048 E4.5).
// B-075: the live line and the finished line come from the run's row – its steps and note (meta.live), the time it
// worked and its steps (meta.ms, meta.steps, meta.lines: lineFromMeta "Worked 41 s · 6 steps", "Thought for 12 s") – the
// same on every device; only an older answer without them falls back to its journaled items (disclosureLine).
// Owns: these rules (unit-tested in test/unit/ui/run-line.test.ts). Never: imports the store, rpc or the DOM.

import type { LiveStep, MessageMeta } from '../../shared/model/chat.ts';
import type { RunItem } from '../../shared/model/runs.ts';
import { stepText } from '../../shared/text/step-label.ts';
import { runSummary, stepsText, workedFor, type RunSpan, type RunSummary } from './run-summary.ts';

/** B-047 D4: publishing tags are stripped before posting, so the live line never shows one – nor one still being written. */
const TAGS = /\[\[\s*(?:internal|silent|quiet|notify)\s*\]\]|\[\[[a-z\s]*\]?$/gi;

/** The last paragraph of a streamed body (what the agent writes right now). */
function tail(body: string | undefined): string {
  return body?.replace(TAGS, '').trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The live block's one line from its row (B-075): the agent's newest words while it writes them, else its live note
 * (meta.live.note) unless that only repeats the newest step. A stopped run: "Stopped · <its last step>".
 */
export function workingLine(input: { stopped?: boolean; steps?: readonly LiveStep[]; body?: string; note?: string }): string {
  const steps = input.steps ?? [];
  if (input.stopped) {
    const step = steps.filter((item) => !item.thought).at(-1);
    const text = step ? stepText(step) : '';
    return `Stopped${text ? ` · ${text}` : ''}`;
  }
  const words = liveWords({ body: input.body });
  if (words) return words;
  const note = flat(input.note ?? '');
  return note && !repeatsNewest(note, steps) ? note : 'Working';
}

/** The agent's newest words while it writes them ('' when none): the last paragraph of its row's body. Also the header popover's words line (B-048 E4.5). */
export function liveWords(input: { body?: string }): string {
  return flat(tail(input.body));
}

/** The note only repeats the newest step (the running call or the thought being written): the slot says "Working" instead. */
function repeatsNewest(note: string, steps: readonly LiveStep[]): boolean {
  const newest = steps.at(-1);
  if (!newest) return false;
  const shown = newest.thought ? [newest.target] : [stepText(newest, true), stepText(newest)];
  return shown.some((text) => flat(text).toLocaleLowerCase() === note.toLocaleLowerCase());
}

/**
 * The collapsed line above an answer: runSummary's "Worked … · N steps" ("Working · N steps"
 * while live); a run without a tool call that journaled reasoning says "Thought for 12 s"
 * ("Thinking" while live); null when there is neither (a plain answer stays clean).
 */
export function disclosureLine(items: readonly RunItem[] | null | undefined, live: boolean, span: RunSpan = {}): RunSummary | null {
  const summary = runSummary(items, live, span);
  if (summary || !items) return summary;
  const thoughts = items.filter((item) => item.kind === 'reasoning' && typeof item.data.summary === 'string' && item.data.summary.trim());
  if (!thoughts.length) return null;
  if (live) return { steps: 0, live, text: 'Thinking' };
  const { startedAt, endedAt } = span;
  const known = startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt;
  return { steps: 0, live, text: known ? `Thought for ${workedFor(endedAt - startedAt)}` : 'Thought' };
}

/**
 * The line an answer's meta says (turn-finish writes meta.steps / meta.thought; B-075 the finish meta.ms): "Worked 41 s ·
 * 6 steps", "Thought for 12 s" – without the time "Worked · 6 steps", "Thought"; null for an answer without steps or thought.
 */
export function lineFromMeta(meta: Pick<MessageMeta, 'steps' | 'thought' | 'ms'> | undefined): RunSummary | null {
  const steps = typeof meta?.steps === 'number' && meta.steps >= 1 ? Math.floor(meta.steps) : 0;
  const time = typeof meta?.ms === 'number' && Number.isFinite(meta.ms) && meta.ms >= 0 ? workedFor(meta.ms) : '';
  if (steps) return { steps, live: false, text: `Worked${time ? ` ${time}` : ''} · ${stepsText(steps)}` };
  return meta?.thought === true ? { steps: 0, live: false, text: time ? `Thought for ${time}` : 'Thought' } : null;
}

/** B-075: the steps a finished answer's list shows before its kept lines, by count only (meta.steps beyond the calls in meta.lines). */
export function earlierSteps(meta: Pick<MessageMeta, 'steps' | 'lines'> | undefined): number {
  const calls = (meta?.lines ?? []).filter((line) => !line.thought).length;
  return typeof meta?.steps === 'number' ? Math.max(0, Math.floor(meta.steps) - calls) : 0;
}
