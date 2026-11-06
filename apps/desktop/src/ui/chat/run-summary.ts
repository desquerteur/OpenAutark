// Pure helpers for the run disclosure under an agent answer (C5, RunDisclosure.tsx): the muted
// line "Worked 2 min · 6 steps" (or "Working · 3 steps" while the run is live), when a run has
// no such line (no tool call yet – plain answers stay clean), the run's time span from what a
// chat client can read (the answer's creation and the journaled items), the merge of a live
// run item into a loaded list and whether the message list shows its end (the line keeps it there).
// Owns: these rules (unit-tested in test/unit/ui/run-summary.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in.

import type { RunItem } from '../../shared/model/runs.ts';

/** What the collapsed line says; null = no line (the run did no step, or nothing is loaded). */
export interface RunSummary {
  steps: number;
  live: boolean;
  text: string;
}

export interface RunSpan {
  startedAt?: number;
  endedAt?: number;
}

/** Steps are the run's tool calls (each call once, also when its id repeats). */
export function stepCount(items: readonly RunItem[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const callId = typeof item.data.callId === 'string' ? item.data.callId : undefined;
    if (callId) {
      if (seen.has(callId)) continue;
      seen.add(callId);
    }
    count++;
  }
  return count;
}

/** "12 s", "2 min", "1 h 5 min" – a short, calm duration (never "0 s"). */
export function workedFor(ms: number): string {
  const seconds = Math.max(1, Math.round(Math.max(0, ms) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "1 step", "6 steps" (also run-line.ts lineFromMeta). */
export function stepsText(steps: number): string {
  return `${steps} ${steps === 1 ? 'step' : 'steps'}`;
}

/**
 * The collapsed line for a run. No line before the items are loaded or when the run made no
 * tool call. Live: "Working · N steps" (a running clock would need a timer). Finished: "Worked
 * <duration> · N steps", or "Worked · N steps" when the span is unknown.
 */
export function runSummary(items: readonly RunItem[] | null | undefined, live: boolean, span: RunSpan = {}): RunSummary | null {
  if (!items) return null;
  const steps = stepCount(items);
  if (!steps) return null;
  if (live) return { steps, live, text: `Working · ${stepsText(steps)}` };
  const { startedAt, endedAt } = span;
  const known = startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt;
  return { steps, live, text: known ? `Worked ${workedFor(endedAt - startedAt)} · ${stepsText(steps)}` : `Worked · ${stepsText(steps)}` };
}

/**
 * The run's span as a chat client can see it (there is no run read for chats): it starts at the
 * earlier of the answer's creation (the turn begins its answer right after routing) and the first
 * journaled item, and ends at the last journaled item. The final writing after the last step is
 * not counted – the person sees that text anyway.
 */
export function runSpan(items: readonly RunItem[], answerCreatedAt: number | undefined): RunSpan {
  let first: number | undefined;
  let last: number | undefined;
  for (const item of items) {
    if (first === undefined || item.createdAt < first) first = item.createdAt;
    if (last === undefined || item.createdAt > last) last = item.createdAt;
  }
  const candidates = [answerCreatedAt, first].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const startedAt = candidates.length ? Math.min(...candidates) : undefined;
  const endedAt = last === undefined ? undefined : Math.max(last, startedAt ?? last);
  return { startedAt, endedAt };
}

/** A live `run.item` (new, or an update of a known item such as a settled effect) merged by id, in seq order. */
export function mergeItem(list: readonly RunItem[], item: RunItem): RunItem[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) return list.map((entry, at) => (at === index ? item : entry));
  const next = [...list, item];
  return next.length > 1 && next[next.length - 2].seq > item.seq ? next.sort((a, b) => a.seq - b.seq) : next;
}

/** Within this many px of its end the message list still counts as at the bottom (MessageList's rule). */
export const END_SLACK = 48;

/** The scroll metrics of the message list (an element, or plain numbers in tests). */
export interface ScrollBox {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True when the list shows its end – it then sticks there while it grows (also by a late line). */
export function showsEnd(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < END_SLACK;
}
