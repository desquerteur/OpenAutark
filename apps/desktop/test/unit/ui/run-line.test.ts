// D5 lines around a run's steps (src/ui/chat/run-line.ts): the live block's one line (streamed words,
// else the live status – never the whole body twice) and "Stopped · <last step>"; the collapsed line above an answer,
// which also covers a run that only reasoned; B-059 #74 / B-075: the line from the row's meta (time worked, steps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveStep } from '../../../src/shared/model/chat.ts';
import type { RunItem, RunItemKind } from '../../../src/shared/model/runs.ts';
import { disclosureLine, earlierSteps, lineFromMeta, workingLine } from '../../../src/ui/chat/run-line.ts';

const T0 = Date.UTC(2026, 9, 28, 9);
let seq = 0;
const item = (kind: RunItemKind, at: number, data: Record<string, unknown> = {}, patch: Partial<RunItem> = {}): RunItem =>
  ({ id: `ri_${++seq}`, runId: 'run_1', seq, kind, data, createdAt: at, ...patch });

const ran: LiveStep = { kind: 'command', verb: 'Ran', active: 'Running', target: 'npm test' };
const thinking: LiveStep = { kind: 'plan', verb: 'Thought', active: 'Thinking', target: 'Reading project directories', thought: true, running: true };

test('B-075 the live line from the row: streamed words win, else the live note', () => {
  assert.equal(workingLine({ steps: [], body: 'Intro.\n\nWriting the answer now', note: 'Planning' }), 'Writing the answer now');
  assert.equal(workingLine({ steps: [ran], body: '', note: 'Planning the PC search' }), 'Planning the PC search');
  assert.equal(workingLine({ body: '', note: '' }), 'Working');
});

test('the live line never shows a publishing tag, also one still being streamed (B-047 D4)', () => {
  assert.equal(workingLine({ body: 'Checked the invoices. [[silent]]' }), 'Checked the invoices.');
  assert.equal(workingLine({ body: 'Done here [[QUIET]] for now' }), 'Done here for now');
  assert.equal(workingLine({ body: 'Checked the invoices. [[inter' }), 'Checked the invoices.');
  assert.equal(workingLine({ body: '[[internal]]', note: 'Planning' }), 'Planning', 'a tag alone: the live status');
});

test('a stopped run names its last step in words (a thought after it does not count)', () => {
  assert.equal(workingLine({ stopped: true, steps: [ran, thinking] }), 'Stopped · Ran npm test');
  assert.equal(workingLine({ stopped: true, steps: [] }), 'Stopped');
});

test('the collapsed line: steps as before; a run that only reasoned says how long it thought; a plain answer has none', () => {
  const steps = [item('tool_call', T0, { callId: 'c1' }, { name: 'files.read' }), item('tool_result', T0 + 90_000, { callId: 'c1', ok: true })];
  assert.equal(disclosureLine(steps, false, { startedAt: T0, endedAt: T0 + 120_000 })?.text, 'Worked 2 min · 1 step');
  const thought = [item('reasoning', T0, { summary: 'Weighing it.' }), item('note', T0 + 12_000, { answer: true, text: 'Yes.', visibility: 'notify' })];
  assert.equal(disclosureLine(thought, false, { startedAt: T0, endedAt: T0 + 12_000 })?.text, 'Thought for 12 s');
  assert.equal(disclosureLine(thought, true)?.text, 'Thinking');
  assert.equal(disclosureLine([item('reasoning', T0, { summary: '' })], false), null, 'a block without words is no thought');
  assert.equal(disclosureLine([item('note', T0, { fresh: 'mode' })], false), null);
  assert.equal(disclosureLine(null, false), null);
});

test('the live line never repeats the newest step: a note equal to the running step or thought says "Working"', () => {
  const render: LiveStep = { kind: 'tool', verb: '', active: '', target: 'Render preview', running: true };
  assert.equal(workingLine({ steps: [render], body: '', note: 'Render preview' }), 'Working');
  assert.equal(workingLine({ steps: [ran], body: '', note: 'Running npm test' }), 'Working');
  assert.equal(workingLine({ steps: [render], body: '', note: 'Waiting for the render queue' }), 'Waiting for the render queue', 'a different status stays');
  assert.equal(workingLine({ steps: [render, thinking], body: '', note: 'Reading project directories' }), 'Working');
});

test('B-075: the finished line from the row – time worked and steps, or how long it thought; earlier steps by count', () => {
  assert.deepEqual(lineFromMeta({ steps: 6, ms: 41_000 }), { steps: 6, live: false, text: 'Worked 41 s · 6 steps' });
  assert.equal(lineFromMeta({ thought: true, ms: 12_000 })?.text, 'Thought for 12 s');
  assert.equal(lineFromMeta({ steps: 2, ms: 125_000 })?.text, 'Worked 2 min · 2 steps');
  assert.equal(lineFromMeta({ ms: 5_000 }), null, 'a plain answer has no line');
  assert.equal(earlierSteps({ steps: 64, lines: [ran, thinking, ran] }), 62, 'calls only');
  assert.equal(earlierSteps({ steps: 2, lines: [ran, ran, ran] }), 0);
  assert.equal(earlierSteps({ lines: [ran] }), 0);
});

test('B-059 #74: before the items are loaded the line comes from the answer\'s meta; loaded items only change its text, a refused or empty list never takes it away', () => {
  assert.deepEqual(lineFromMeta({ steps: 6 }), { steps: 6, live: false, text: 'Worked · 6 steps' });
  assert.equal(lineFromMeta({ steps: 1 })?.text, 'Worked · 1 step');
  assert.equal(lineFromMeta({ thought: true })?.text, 'Thought');
  assert.equal(lineFromMeta({ steps: 2, thought: true })?.text, 'Worked · 2 steps', 'steps first');
  for (const meta of [undefined, {}, { steps: 0 }, { steps: -1 }, { steps: Number.NaN }, { thought: false }]) assert.equal(lineFromMeta(meta), null, JSON.stringify(meta));
  // RunDisclosure: (items ? disclosureLine(items) : null) ?? lineFromMeta(meta)
  const shown = (items: RunItem[] | null) => (items ? disclosureLine(items, false, { startedAt: T0, endedAt: T0 + 120_000 }) : null) ?? lineFromMeta({ steps: 1 });
  assert.equal(shown(null)?.text, 'Worked · 1 step', 'first frame: from the meta');
  assert.equal(shown([item('tool_call', T0, { callId: 'c9' }, { name: 'files.read' })])?.text, 'Worked 2 min · 1 step', 'loaded: the exact line in the same place');
  assert.equal(shown([])?.text, 'Worked · 1 step', 'an empty or refused list keeps the line');
});
