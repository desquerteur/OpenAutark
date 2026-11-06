// D5 step lines (src/ui/team/step-view.ts): a call's line from the runtime's journaled step or from
// its name, preview args and summary; a thought's "Thought · <headline>" (Thinking while written,
// only while the run is live); the final answer's branch; the live
// list's window ("+N earlier"); a reasoning item without words is not shown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunItem, RunItemKind } from '../../../src/shared/model/runs.ts';
import { STEP_ICONS, answerOf, callStep, liveWindow, parsedArgs, shownEntry, stepItems, thoughtLine, thoughtParts } from '../../../src/ui/team/step-view.ts';
import { runEntries } from '../../../src/ui/team/model.ts';

let seq = 0;
const item = (kind: RunItemKind, data: Record<string, unknown> = {}, patch: Partial<RunItem> = {}): RunItem =>
  ({ id: `ri_${++seq}`, runId: 'run_1', seq, kind, data, createdAt: seq, ...patch });

test('a call uses the journaled step; otherwise it is derived from its preview args and summary', () => {
  const native = item('tool_call', { callId: 'c1', own: true, args: '{"command":"npm test"}', summary: 'Ran npm test', step: { kind: 'command', verb: 'Ran', active: 'Running', target: 'npm test' } }, { name: 'shell' });
  assert.deepEqual(callStep(native), { kind: 'command', verb: 'Ran', active: 'Running', target: 'npm test' });
  const old = item('tool_call', { callId: 'c2', own: true, args: '{"file_path":"src/app.ts"}' }, { name: 'Read' });
  assert.deepEqual(callStep(old), { kind: 'read', verb: 'Read', active: 'Reading', target: 'src/app.ts' }, 'items journaled before D5');
  const ours = item('tool_call', { callId: 'c3', args: '{"text":"hi"', summary: 'Send a message to #team' }, { name: 'chat.send' });
  assert.equal(callStep(ours).target, 'Send a message to #team', 'a cut preview still gets its summary');
  const bogus = item('tool_call', { callId: 'c4', step: { kind: 'nonsense', target: 'x' }, args: '{}' }, { name: 'Bash' });
  assert.equal(callStep(bogus).kind, 'command', 'an unknown journaled kind is ignored');
  assert.deepEqual(parsedArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parsedArgs('{"a":1…'), {});
  for (const icon of Object.values(STEP_ICONS)) assert.equal(typeof icon, 'string');
});

test('thoughts: "Thought · <headline>", "Thinking" only while written in a live run; titles become headings', () => {
  const live = item('reasoning', { summary: '**Planning**\n\nRead the brief first.', live: true });
  assert.deepEqual(thoughtLine(live, true), { verb: 'Thinking', headline: 'Planning', text: '**Planning**\n\nRead the brief first.', live: true });
  assert.equal(thoughtLine(live, false).verb, 'Thought', 'a run that ended (or crashed) never shimmers');
  assert.deepEqual(thoughtParts('**Planning**\n\nRead **the** brief.\n\n'), [{ heading: true, text: 'Planning' }, { heading: false, text: 'Read the brief.' }]);
  assert.equal(shownEntry({ kind: 'item', item: item('reasoning', { summary: '  ' }) }), false);
  assert.equal(shownEntry({ kind: 'item', item: live }), true);
});

test('the final answer\'s branch: kept internal, posted quietly or posted; other notes are no answer', () => {
  assert.deepEqual(answerOf(item('note', { answer: true, text: 'Saved.', visibility: 'internal' })), { branch: 'internal', label: 'Kept internal', text: 'Saved.' });
  assert.equal(answerOf(item('note', { answer: true, text: 'x', visibility: 'silent' }))?.label, 'Posted quietly');
  assert.equal(answerOf(item('note', { answer: true, text: 'x', visibility: 'notify' }))?.label, 'Posted');
  assert.equal(answerOf(item('note', { commentary: true, text: 'x' })), undefined);
  assert.equal(shownEntry({ kind: 'item', item: item('note', { answer: true, text: 'part 2', visibility: 'notify', part: 2, parts: 2 }) }), false, 'one line per answer, not per journal part');
});

test('the live window keeps the newest steps at the bottom and counts the folded ones', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(liveWindow(list, 6), { hidden: 2, shown: [3, 4, 5, 6, 7, 8] });
  assert.deepEqual(liveWindow(list, 6, true), { hidden: 0, shown: list });
  assert.deepEqual(liveWindow([1, 2], 6), { hidden: 0, shown: [1, 2] });
});

test('B-075: a row\'s step values become the items the same list renders – a call with its result (failed kept), a running one without, a thought', () => {
  const items = stepItems('run_9', [
    { kind: 'command', verb: 'Ran', active: 'Running', target: 'npm test' },
    { kind: 'read', verb: 'Read', active: 'Reading', target: 'src/app.ts', failed: true },
    { kind: 'plan', verb: 'Thought', active: 'Thinking', target: 'Checking the plan', thought: true, running: true },
    { kind: 'web', verb: 'Opened', active: 'Opening', target: 'example.com', running: true },
  ]);
  const entries = runEntries(items);
  assert.deepEqual(entries.map((entry) => entry.kind === 'tool' ? [callStep(entry.call).target, entry.result?.data.ok] : [entry.item.kind]), [
    ['npm test', true], ['src/app.ts', false], ['reasoning'], ['example.com', undefined],
  ]);
  const thought = entries[2]!.kind === 'item' ? entries[2]!.item : undefined;
  assert.deepEqual(thoughtLine(thought!, true), { verb: 'Thinking', headline: 'Checking the plan', text: '**Checking the plan**', live: true });
  assert.ok(items.every((item) => item.data.args === undefined && item.data.output === undefined), 'no input or output');
  assert.deepEqual(stepItems('run_9', []), []);
});
