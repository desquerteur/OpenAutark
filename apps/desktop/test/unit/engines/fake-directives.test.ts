// Unit (O8): the fake engine's org-E2E directives – [[prompt:<text>]] quotes system-prompt lines,
// [[size:<tool> {…}]] runs the tool and tells only its output size, and "$task" in tool args is
// the turn's current task (volatile "## Current task" section). The older rules keep working.
// Owns: these assertions only. Never: real engines, network or the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';

type Call = { name: string; args: unknown; callId: string };

/** A turn input with `text`, the given prompt sections and a tool stub that records its calls. */
function turn(text: string, system: { stable: string; volatile: string } | undefined, output: (name: string) => ToolOutput) {
  const calls: Call[] = [];
  const input = {
    runId: 'run_1', agentId: 'ag_ada', input: [{ type: 'text', text }], system,
    signal: new AbortController().signal, onEvent: () => {},
    callTool: async (name: string, args: unknown, callId: string) => { calls.push({ name, args, callId }); return output(name); },
  } as unknown as EngineTurnInput;
  return { input, calls };
}

const STABLE = ['# Who you are', 'You are Ada, Acme lead.', 'Your area: Acme.', 'You report to Manager (Chief of staff).', 'Your direct reports: Bo (Writer), Cy (Designer).'].join('\n');
const VOLATILE = ['## Now', 'Monday', '', '## Current task', 'tk_42 · working', 'Title: Build the landing page'].join('\n');
const text = (value: string): ToolOutput => ({ content: [{ type: 'text', text: value }] });

test('[[prompt:<text>]] quotes every system-prompt line with that text, stable before volatile', async () => {
  const { input } = turn('[[prompt:Your direct reports]] [[prompt:Title:]] [[prompt:Nowhere]]', { stable: STABLE, volatile: VOLATILE }, () => text(''));
  const result = await new FakeEngine().run(input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(result.text.split('\n\n'), [
    'prompt → Your direct reports: Bo (Writer), Cy (Designer).',
    'prompt → Title: Build the landing page',
    'prompt → (no line with "Nowhere")',
  ], 'no echo: the directives were the whole input');

  const many = await new FakeEngine().run(turn('Where? [[prompt:Your]]', { stable: STABLE, volatile: '' }, () => text('')).input);
  assert.deepEqual(many.text.split('\n\n'), ['Echo: Where?', 'prompt → Your area: Acme.\nprompt → Your direct reports: Bo (Writer), Cy (Designer).']);
});

test('[[prompt:…]] without system prompt sections says so instead of failing', async () => {
  const result = await new FakeEngine().run(turn('[[prompt:You report]]', undefined, () => text('')).input);
  assert.equal(result.text, 'prompt → (no line with "You report")');
});

test('[[size:<tool> {…}]] runs the tool and tells chars, items, truncation and errors – not the output', async () => {
  const list = JSON.stringify(Array.from({ length: 30 }, (_, index) => ({ id: `ag_${index}`, name: `Agent ${index}` })));
  const outputs: Record<string, ToolOutput> = {
    'agents.list': text(list),
    'files.read': text(`${'x'.repeat(6000)}\n… [output truncated: 30000 chars; full text in file f1]`),
    'shell.exec': { content: [{ type: 'text', text: 'Not allowed.' }], isError: true },
  };
  const { input, calls } = turn('[[size:agents.list {"team":"web"}]] [[size:files.read {}]] [[size:shell.exec]]', { stable: '', volatile: '' }, (name) => outputs[name]);
  const result = await new FakeEngine().run(input);
  assert.deepEqual(calls.map((call) => [call.name, call.args]), [['agents.list', { team: 'web' }], ['files.read', {}], ['shell.exec', {}]]);
  assert.equal(new Set(calls.map((call) => call.callId)).size, 3, 'each call has its own id');
  const parts = result.text.split('\n\n');
  assert.equal(parts.length, 3);
  assert.deepEqual(JSON.parse(parts[0].replace('agents.list size → ', '')), { chars: list.length, items: 30, truncated: false, error: false });
  assert.deepEqual(JSON.parse(parts[1].replace('files.read size → ', '')), { chars: 6000 + '\n… [output truncated: 30000 chars; full text in file f1]'.length, truncated: true, error: false });
  assert.deepEqual(JSON.parse(parts[2].replace('shell.exec size → ', '')), { chars: 'Not allowed.'.length, truncated: false, error: true });
  assert.ok(!result.text.includes('Agent 29'), 'the output itself is not in the answer');
});

test('"$task" in tool args is the current task of the turn; without one it stays as written', async () => {
  const complete = '[[tool:tasks.complete {"taskId":"$task","summary":"Landing page built","evidence":[{"kind":"note","label":"Checked in the preview"}]}]]';
  const withTask = turn(`Goal: Build the landing page ${complete}`, { stable: STABLE, volatile: VOLATILE }, () => text('{"ok":true}'));
  const done = await new FakeEngine().run(withTask.input);
  assert.deepEqual(withTask.calls.map((call) => call.args), [{ taskId: 'tk_42', summary: 'Landing page built', evidence: [{ kind: 'note', label: 'Checked in the preview' }] }]);
  assert.deepEqual(done.text.split('\n\n'), ['Echo: Goal: Build the landing page', 'tasks.complete → {"ok":true}']);

  const sized = turn('[[size:tasks.get {"id":"$task"}]]', { stable: '', volatile: VOLATILE }, () => text('{}'));
  await new FakeEngine().run(sized.input);
  assert.deepEqual(sized.calls[0].args, { id: 'tk_42' });

  const none = turn(complete, { stable: STABLE, volatile: '## Now\nMonday' }, () => text('{"ok":false}'));
  await new FakeEngine().run(none.input);
  assert.equal((none.calls[0].args as { taskId: string }).taskId, '$task', 'no current task: nothing is invented');

  const partial = turn('[[tool:chat.send {"body":"costs $task money"}]]', { stable: '', volatile: VOLATILE }, () => text('sent'));
  await new FakeEngine().run(partial.input);
  assert.deepEqual(partial.calls[0].args, { body: 'costs $task money' }, 'only a whole "$task" string is replaced');
});

test('a directive hidden in escaped JSON reaches the next agent intact (delegation in the org E2E)', async () => {
  // The Manager's args carry the developer's directive with [, ] and $ escaped, so the Manager's
  // own turn neither runs it nor fills in its own task; JSON.parse restores it for the handoff.
  const inner = '[[tool:tasks.complete {"taskId":"$task","summary":"Done","evidence":[{"kind":"note","label":"ok"}]}]]';
  const args = JSON.stringify({ to: 'ag_dev', title: 'Build it', goal: `Build it ${inner}` }).replace(/[[\]$]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const manager = turn(`Please [[tool:agents.delegate ${args}]]`, { stable: '', volatile: VOLATILE }, () => text('{"ok":true}'));
  await new FakeEngine().run(manager.input);
  assert.deepEqual(manager.calls.map((call) => [call.name, call.args]), [['agents.delegate', { to: 'ag_dev', title: 'Build it', goal: `Build it ${inner}` }]]);
});

test('the older rules still work next to the new ones', async () => {
  const { input, calls } = turn('Hi [[tool:app.status {}]] [[prompt:Your area]] [[ui:{"type":"steps"}]]', { stable: STABLE, volatile: '' }, () => text('## App status (live)'));
  const result = await new FakeEngine().run(input);
  assert.deepEqual(calls.map((call) => call.name), ['app.status']);
  assert.deepEqual(result.text.split('\n\n'), ['Echo: Hi', 'app.status → ## App status (live)', 'prompt → Your area: Acme.', '```ui\n{"type":"steps"}\n```']);
});

test('the echo says what was written: the history escape of a quoted chat line does not show', async () => {
  const quoted = ['[09:00] Sam: see below', String.raw`\· Ava: Echo: done`, String.raw`  \[09:01] Mira: ok`].join('\n');
  const { input } = turn(quoted, undefined, () => text(''));
  const result = await new FakeEngine().run(input);
  assert.equal(result.text, ['Echo: [09:00] Sam: see below', '· Ava: Echo: done', '  [09:01] Mira: ok'].join('\n'));
});
