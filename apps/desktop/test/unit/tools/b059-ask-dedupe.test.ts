// B-059 (B-054 N2): human.ask does not add the same open to-do twice. The same agent asking the same thing at the same
// place – title (case and outer spaces ignored), chat (or none), parent task, asked person, reason, widget type – gets its
// open to-do back; another agent, title, parent task, reason or a settled to-do adds a new one.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';
import { humanTools } from '../../../src/runtime/tools/builtin/human.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const textOf = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_lea', 'Lea'));
  const s = f.services as RuntimeServices;
  const ask = async (title: string, agentId = 'ag_ava', extra: Record<string, unknown> = {}) => {
    const ctx = { agent: f.org.get(agentId)!, runId: 'run_1', mode: 'general', services: s, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
    const out = await humanTools.find((tool) => tool.name === 'human.ask')!.run({ title, reason: 'taste', widget: { type: 'confirm', instructions: title }, ...extra } as never, ctx);
    assert.notEqual(out.isError, true, textOf(out));
    return JSON.parse(textOf(out)) as { todoId: string; already?: boolean };
  };
  return { f, ask };
}

test('the same open question from the same agent returns the open to-do instead of a second one', async (t) => {
  const { f, ask } = rig(t);
  const first = await ask('Approve the weekly report');
  const again = await ask('  approve the WEEKLY report ');
  assert.equal(again.todoId, first.todoId);
  assert.equal(again.already, true);
  assert.equal(f.tasks.list({ assigneeKind: 'human' }).length, 1);
});

test('another agent, another title or a settled to-do adds a new one', async (t) => {
  const { f, ask } = rig(t);
  const first = await ask('Approve the weekly report');
  assert.notEqual((await ask('Approve the weekly report', 'ag_lea')).todoId, first.todoId, 'another agent');
  assert.notEqual((await ask('Approve the monthly report')).todoId, first.todoId, 'another title');
  f.tasks.update(first.todoId, { status: 'done' }, 'human');
  const next = await ask('Approve the weekly report');
  assert.notEqual(next.todoId, first.todoId, 'the earlier one is settled');
  assert.equal(next.already, undefined);
});

test('the same title under another task or for another reason is its own to-do; under the same task it is returned', async (t) => {
  const { f, ask } = rig(t);
  const top = await ask('Approve the weekly report');
  const parent = f.tasks.create({ title: 'Weekly report', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'ag_ava' });
  const under = await ask('Approve the weekly report', 'ag_ava', { taskId: parent.id });
  assert.notEqual(under.todoId, top.todoId, 'a step of another task is not the top-level to-do');
  assert.equal((await ask('Approve the weekly report', 'ag_ava', { taskId: parent.id })).todoId, under.todoId, 'the same step again');
  const review = await ask('Approve the weekly report', 'ag_ava', { reason: 'review' });
  assert.notEqual(review.todoId, top.todoId, 'another reason');
});
