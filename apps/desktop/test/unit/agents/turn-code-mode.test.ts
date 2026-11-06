// B-049 F9 – an engine attempt journals Codex code mode as the ledger reads it (agents/turn-attempt.ts): a script call
// (exec, engine-native) whose args preview is cut carries its full length (argsChars – the ledger's estimate); an
// engine-native call made inside a script carries nested and its parent script; a short preview carries no length.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { setup } from './fixture.ts';

test('a cut exec preview is journaled with its full length; a call inside the script with nested and its parent', async () => {
  const h = setup();
  const items: Array<{ kind: string; data: Record<string, unknown> }> = [];
  Object.assign(h.services, { runs: {
    list: () => [], start: () => {}, finish: () => {}, updateItem: () => {},
    item: (_runId: string, item: { kind: string; data?: Record<string, unknown> }) => { items.push({ kind: item.kind, data: { ...(item.data ?? {}) } }); return { id: `ri_${items.length}` }; },
  } });
  const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  const source = `const r = await tools.files__read({path:"a.log"});\n${'text(r.length);\n'.repeat(300)}`;
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'call_x1', name: 'exec', args: { source }, own: true });
    input.onEvent({ type: 'tool_start', callId: 'exec-bbb', name: 'shell', args: { command: 'git status' }, own: true, nested: true, parent: 'call_x1' });
    input.onEvent({ type: 'tool_end', callId: 'exec-bbb', ok: true, summary: 'exit 0' });
    input.onEvent({ type: 'tool_end', callId: 'call_x1', ok: true, summary: 'Script completed', output: 'Script completed\nOutput:\n300' });
    return { text: 'Done.', stop: 'done' };
  };
  assert.equal((await runAttempt(h.services, plan, h.routed(), h.request(), undefined)).result.stop, 'done');
  const calls = items.filter((item) => item.kind === 'tool_call').map((item) => item.data);
  assert.equal(calls.length, 2);
  assert.ok(String(calls[0].args).endsWith('…'), 'the journal keeps a preview');
  assert.equal(calls[0].argsChars, JSON.stringify({ source }).length);
  assert.equal(calls[0].nested, undefined);
  assert.equal(calls[1].nested, true);
  assert.equal(calls[1].parent, 'call_x1');
  assert.equal('argsChars' in calls[1], false, 'a whole preview needs no length');
});
