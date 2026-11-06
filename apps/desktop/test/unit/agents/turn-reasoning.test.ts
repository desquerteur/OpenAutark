// D5 in one engine attempt (agents/turn-attempt.ts): reasoning is journaled live as one item per
// block in its place between the tool calls (not once after engine.run), the live status is the
// reasoning headline or the running step in words (not the word "thinking"), and an engine-native
// call is journaled with its human line (summary + step) next to its args.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { setup } from './fixture.ts';

function journal() {
  const items: Array<{ id: string; kind: string; name?: string; data: Record<string, unknown> }> = [];
  const runs = {
    list: () => [], start: () => {}, finish: () => {},
    item: (_runId: string, item: { kind: string; name?: string; data?: Record<string, unknown> }) => {
      const saved = { id: `ri_${items.length + 1}`, kind: item.kind, name: item.name, data: { ...(item.data ?? {}) } };
      items.push(saved);
      return saved;
    },
    updateItem: (id: string, patch: { data?: Record<string, unknown> }) => {
      const item = items.find((entry) => entry.id === id);
      if (item && patch.data) item.data = { ...item.data, ...patch.data };
    },
  };
  return { items, runs };
}

test('reasoning blocks are journaled live between the tool calls; the status is the headline, then the step in words', async () => {
  const h = setup();
  const j = journal();
  Object.assign(h.services, { runs: j.runs });
  const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  const statuses: string[] = [];
  const seenDuring: string[] = [];
  h.state.script = async (input) => {
    input.onEvent({ type: 'reasoning', delta: '**Planning the PC search**\n\nStart with the documents folder.', id: 'rs_1' });
    seenDuring.push(...j.items.map((item) => item.kind)); // journaled while the engine still runs
    input.onEvent({ type: 'reasoning_end', id: 'rs_1' });
    input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: { command: ['bash', '-lc', 'ls ~/Documents'] }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'c1', ok: true, summary: 'exit 0' });
    input.onEvent({ type: 'reasoning', delta: 'Found the invoices; reading the newest.', id: 'rs_2' });
    input.onEvent({ type: 'tool_start', callId: 'c2', name: 'Read', args: { file_path: 'C:\\Users\\me\\Documents\\invoices\\2026\\oct.pdf' }, own: true, title: 'Read oct.pdf' });
    input.onEvent({ type: 'tool_end', callId: 'c2', ok: true, summary: 'read' });
    return { text: 'Done.', stop: 'done' };
  };
  const attempt = await runAttempt(h.services, plan, h.routed(), h.request({ onStatus: (note: string) => statuses.push(note) }), undefined);
  assert.equal(attempt.result.stop, 'done');
  assert.deepEqual(seenDuring, ['reasoning'], 'live, before engine.run returned');
  assert.deepEqual(j.items.map((item) => item.kind), ['reasoning', 'tool_call', 'tool_result', 'reasoning', 'tool_call', 'tool_result'], 'interleaved in their order');
  assert.deepEqual(j.items[0].data, { summary: '**Planning the PC search**\n\nStart with the documents folder.', live: false });
  assert.deepEqual(j.items[3].data, { summary: 'Found the invoices; reading the newest.', live: false }, 'the next step closes an open block');
  assert.equal(j.items[1].data.summary, 'Ran ls ~/Documents', 'an engine-native call says what it did');
  assert.deepEqual(j.items[1].data.step, { kind: 'command', verb: 'Ran', active: 'Running', target: 'ls ~/Documents' });
  assert.deepEqual(j.items[4].data.step, { kind: 'read', verb: 'Read', active: 'Reading', target: '…/invoices/2026/oct.pdf' });
  assert.equal(j.items[4].data.title, 'Read oct.pdf');
  assert.equal(statuses.includes('thinking'), false, 'never the fixed word');
  assert.deepEqual(statuses.filter((note) => note !== 'Working'), [
    'Planning the PC search', 'Running ls ~/Documents', 'Found the invoices; reading the newest', 'Reading …/invoices/2026/oct.pdf',
  ]);
  assert.match(attempt.reasoning, /Planning the PC search[\s\S]*Found the invoices/);
});

test('the engine\'s raw line for a running native call never replaces the worded step status', async () => {
  // Review fix: Codex/Claude/ACP emit `status: running <raw command>` right after tool_start.
  const h = setup();
  const j = journal();
  Object.assign(h.services, { runs: j.runs });
  const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  const statuses: string[] = [];
  const raw = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"';
  h.state.script = async (input) => {
    input.onEvent({ type: 'status', note: 'model choice not applied' });
    input.onEvent({ type: 'tool_start', callId: 'c1', name: 'shell', args: { command: raw }, own: true });
    input.onEvent({ type: 'status', note: `running ${raw.slice(0, 60)}` });
    input.onEvent({ type: 'tool_end', callId: 'c1', ok: true, summary: 'exit 0' });
    input.onEvent({ type: 'status', note: 'compacting' });
    return { text: 'Done.', stop: 'done' };
  };
  await runAttempt(h.services, plan, h.routed(), h.request({ onStatus: (note: string) => statuses.push(note) }), undefined);
  assert.deepEqual(statuses.filter((note) => note !== 'Working'), ['model choice not applied', 'Running npm test', 'compacting']);
  assert.equal(j.items[0].data.summary, 'Ran npm test', 'the wrapper is gone from the journaled line too');
});

test('a block still open when the attempt ends is closed (live: false)', async () => {
  const h = setup();
  const j = journal();
  Object.assign(h.services, { runs: j.runs });
  const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  h.state.script = async (input) => {
    input.onEvent({ type: 'reasoning', delta: 'Thinking it over' });
    input.onEvent({ type: 'reasoning', delta: ' once more.' });
    return { text: 'Answer.', stop: 'done' };
  };
  await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.deepEqual(j.items.map((item) => [item.kind, item.data.summary, item.data.live]), [['reasoning', 'Thinking it over once more.', false]]);
});
