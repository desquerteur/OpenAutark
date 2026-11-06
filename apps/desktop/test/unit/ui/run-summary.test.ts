// The "Worked … · N steps" line under an agent answer (C5, src/ui/chat/run-summary.ts): step
// count (tool calls, each once), duration wording, no line for plain answers or unloaded items,
// the live wording, the span a chat client can read, and the merge of live run items.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunItem, RunItemKind } from '../../../src/shared/model/runs.ts';
import { END_SLACK, mergeItem, runSpan, runSummary, showsEnd, stepCount, workedFor } from '../../../src/ui/chat/run-summary.ts';

const T0 = Date.UTC(2026, 9, 20, 9);
const SEC = 1000;
const MIN = 60 * SEC;

let seq = 0;
function item(kind: RunItemKind, at: number, data: Record<string, unknown> = {}, patch: Partial<RunItem> = {}): RunItem {
  seq++;
  return { id: `ri_${seq}`, runId: 'run_1', seq, kind, data, createdAt: at, ...patch };
}

/** n tool calls with results, one per `gap` ms from `start`. */
function toolRun(n: number, start: number, gap: number): RunItem[] {
  const out: RunItem[] = [];
  for (let i = 0; i < n; i++) {
    out.push(item('tool_call', start + i * gap, { callId: `c${i}`, args: { i } }, { name: 'files.read' }));
    out.push(item('tool_result', start + i * gap + 10, { callId: `c${i}`, ok: true, preview: 'ok' }));
  }
  return out;
}

test('steps are the tool calls – results, notes, plans and reasoning do not count; a repeated call id counts once', () => {
  const items = [
    item('reasoning', T0, { summary: 'Looked at the brief' }),
    item('plan', T0 + 1, { steps: ['Read', 'Write'] }),
    ...toolRun(3, T0 + 2, 100),
    item('note', T0 + 900, { sessionRenewed: 'context' }),
    item('tool_call', T0 + 950, { callId: 'c1' }, { name: 'files.read' }), // the same call journaled again
    item('tool_call', T0 + 960, {}, { name: 'bash' }), // no call id: counts on its own
  ];
  assert.equal(stepCount(items), 4);
  assert.equal(stepCount([]), 0);
});

test('durations read short and calm', () => {
  assert.equal(workedFor(0), '1 s', 'never "0 s"');
  assert.equal(workedFor(-5), '1 s');
  assert.equal(workedFor(12_400), '12 s');
  assert.equal(workedFor(59_400), '59 s');
  assert.equal(workedFor(60 * SEC), '1 min');
  assert.equal(workedFor(2 * MIN + 10 * SEC), '2 min');
  assert.equal(workedFor(2 * MIN + 40 * SEC), '3 min');
  assert.equal(workedFor(59 * MIN + 50 * SEC), '1 h');
  assert.equal(workedFor(65 * MIN), '1 h 5 min');
  assert.equal(workedFor(3 * 60 * MIN), '3 h');
});

test('a finished run with tool calls: "Worked 2 min · 6 steps"', () => {
  const items = toolRun(6, T0 + 5 * SEC, 23 * SEC);
  const span = runSpan(items, T0);
  assert.deepEqual(span, { startedAt: T0, endedAt: T0 + 5 * SEC + 5 * 23 * SEC + 10 });
  const summary = runSummary(items, false, span);
  assert.deepEqual(summary, { steps: 6, live: false, text: 'Worked 2 min · 6 steps' });
  assert.equal(runSummary(toolRun(1, T0 + 2 * SEC, 0), false, { startedAt: T0, endedAt: T0 + 12 * SEC })?.text, 'Worked 12 s · 1 step');
});

test('no line for plain answers, empty runs and items not loaded yet', () => {
  assert.equal(runSummary(null, false), null, 'not loaded');
  assert.equal(runSummary(undefined, true), null);
  assert.equal(runSummary([], false, { startedAt: T0, endedAt: T0 + MIN }), null, 'empty run');
  const plain = [item('reasoning', T0, { summary: 'Thought about it' }), item('note', T0 + 5, { fresh: 'mode' })];
  assert.equal(runSummary(plain, false, runSpan(plain, T0)), null, 'reasoning and notes alone are no steps');
  assert.equal(runSummary(plain, true), null, 'a live run without a step shows nothing yet');
});

test('while the run runs the line says "Working · N steps" (no ticking clock)', () => {
  const items = toolRun(3, T0, SEC);
  assert.deepEqual(runSummary(items, true, runSpan(items, T0)), { steps: 3, live: true, text: 'Working · 3 steps' });
  assert.equal(runSummary(items.slice(0, 1), true)?.text, 'Working · 1 step');
});

test('an unknown span still names the steps', () => {
  const items = toolRun(2, T0, SEC);
  assert.equal(runSummary(items, false)?.text, 'Worked · 2 steps');
  assert.equal(runSummary(items, false, { startedAt: T0 + MIN, endedAt: T0 })?.text, 'Worked · 2 steps', 'an end before the start is not shown');
});

test('the span starts at the earlier of the answer and the first item and ends at the last item', () => {
  const early = [item('note', T0 - 3 * SEC, { imagesHidden: true }), ...toolRun(2, T0 + SEC, SEC)];
  assert.deepEqual(runSpan(early, T0), { startedAt: T0 - 3 * SEC, endedAt: T0 + 2 * SEC + 10 }, 'a note journaled before the answer began');
  assert.deepEqual(runSpan(toolRun(1, T0 + SEC, 0), undefined), { startedAt: T0 + SEC, endedAt: T0 + SEC + 10 }, 'no answer time');
  assert.deepEqual(runSpan([], T0), { startedAt: T0, endedAt: undefined }, 'nothing journaled');
  const unordered = [item('tool_result', T0 + 9 * SEC), item('tool_call', T0 + 2 * SEC)];
  assert.deepEqual(runSpan(unordered, T0 + 5 * SEC), { startedAt: T0 + 2 * SEC, endedAt: T0 + 9 * SEC });
});

test('live items merge by id: new ones are appended in seq order, updates replace the known item', () => {
  const [call, result] = toolRun(1, T0, 0);
  const list = [call];
  const added = mergeItem(list, result);
  assert.deepEqual(added.map((entry) => entry.id), [call.id, result.id]);
  assert.equal(list.length, 1, 'the loaded list is not changed in place');
  const settled = { ...call, effectStatus: 'confirmed' as const };
  const updated = mergeItem(added, settled);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].effectStatus, 'confirmed');
  const late = item('tool_call', T0, { callId: 'late' }, { seq: 0 });
  assert.deepEqual(mergeItem(updated, late).map((entry) => entry.seq), [0, call.seq, result.seq], 'kept in seq order');
  assert.equal(stepCount(mergeItem(updated, late)), 2);
});

test('the list shows its end within the slack MessageList uses; a late line keeps only such a list at the end', () => {
  assert.equal(END_SLACK, 48);
  assert.ok(showsEnd({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 }), 'exactly at the end');
  assert.ok(showsEnd({ scrollHeight: 2000, scrollTop: 1353, clientHeight: 600 }), '47 px above the end');
  assert.ok(!showsEnd({ scrollHeight: 2000, scrollTop: 1352, clientHeight: 600 }), '48 px above: scrolled away');
  assert.ok(!showsEnd({ scrollHeight: 2000, scrollTop: 300, clientHeight: 600 }), 'reading older messages');
  assert.ok(showsEnd({ scrollHeight: 400, scrollTop: 0, clientHeight: 600 }), 'everything fits');
  // What the disclosure guards against: a 28 px line under the last answer, read after it rendered.
  const before = { scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 };
  const after = { ...before, scrollHeight: before.scrollHeight + 28 };
  assert.ok(showsEnd(before) && showsEnd(after), 'within the slack the end is still in view …');
  assert.ok(!showsEnd({ ...after, scrollHeight: before.scrollHeight + 3 * 40 }), '… several phone lines push it out – hence the check before the line renders');
});
