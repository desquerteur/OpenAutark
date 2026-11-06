// B-078 D14: the subconscious's own thoughts (subconscious/thoughts.ts): thought.keep appends dated keyword lines to the
// memory file agents/<id>/thoughts.md, a thought is kept once, a secret value stays out, the newest lines are what a run
// opens with; the temperature a runner gets reaches the engine turn (decision/engine-runner.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentThoughts, thoughtTool, thoughtsPath } from '../../../src/runtime/subconscious/thoughts.ts';
import { FLOW_TOOLS, type FlowRun } from '../../../src/runtime/subconscious/tools.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { MemoryWriteInput } from '../../../src/shared/model/memory.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';

function memory() {
  const files = new Map<string, string>();
  const writes: MemoryWriteInput[] = [];
  const services = {
    clock: { now: () => Date.UTC(2026, 10, 6, 12) },
    settings: { get: () => ({ profile: { timezone: 'UTC' } }) },
    secrets: { redact: (text: string) => text.replace(/hunter2/g, 'secret://pw') },
    knowledge: {
      memoryRead: (file: string) => (files.has(file) ? { path: file, title: 'Thoughts', text: files.get(file)!, updated: 0 } : undefined),
      memoryWrite: (input: MemoryWriteInput) => { writes.push(input); files.set(input.path!, input.text); return { path: input.path!, outcome: 'updated' as const }; },
    },
  } as unknown as RuntimeServices;
  const run = { services, agent: { id: 'ag_v', name: 'Vic' }, kind: 'after-turn' } as unknown as FlowRun;
  return { services, run, files, writes };
}

test('thought.keep: dated keyword lines in agents/<id>/thoughts.md, each thought once, no secret value; the newest open a run', async () => {
  const t = memory();
  assert.ok(FLOW_TOOLS.some((tool) => tool.name === 'thought.keep'), 'a flow tool of both brains');
  assert.equal(await thoughtTool.run({ text: 'invoices late again\n- Vic prefers short cuts' }, t.run), 'kept: 2');
  assert.equal(t.writes[0].path, thoughtsPath('ag_v'));
  assert.equal(t.writes[0].path, 'agents/ag_v/thoughts.md');
  assert.equal(t.files.get('agents/ag_v/thoughts.md'), '- 2026-11-06: invoices late again\n- 2026-11-06: Vic prefers short cuts');
  assert.equal(await thoughtTool.run({ text: 'invoices late again' }, t.run), 'kept already');
  assert.equal(await thoughtTool.run({ text: 'password is hunter2' }, t.run), 'kept: 1');
  assert.ok(!t.files.get('agents/ag_v/thoughts.md')!.includes('hunter2'));
  assert.equal(await thoughtTool.run({}, t.run), 'thought.keep needs a text.');
  for (let index = 0; index < 20; index++) await thoughtTool.run({ text: `thought ${index}` }, t.run);
  const recent = recentThoughts(t.services, 'ag_v').split('\n');
  assert.equal(recent.length, 12);
  assert.equal(recent.at(-1), '- 2026-11-06: thought 19');
});

test('a runner\'s temperature reaches the engine turn, clamped; without one the turn carries none', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const account = { id: 'acc', provider: 'openai' };
  const runner = createEngineRunner({
    engines: { get: () => ({ run: async (input: Record<string, unknown>) => { seen.push(input); return { stop: 'done', text: 'ok' }; } }) },
    router: { route: async () => ({ modelId: 'm', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'chat', reason: '', by: 'rules', alternatives: [] }) },
    accounts: { get: () => account, markLimited() {}, markUnavailable() {}, updateLimits() {} },
    catalog: { get: () => ({ id: 'm', model: 'm', efforts: [] }) },
    paths: { temp: (await import('node:os')).tmpdir() },
    clock: { now: () => 0 },
  } as unknown as Parameters<typeof createEngineRunner>[0]);
  await runner({ purpose: 'test', system: 's', prompt: 'p', temperature: 3 });
  await runner({ purpose: 'test', system: 's', prompt: 'p' });
  assert.equal(seen[0].temperature, 2);
  assert.equal('temperature' in seen[1], false);
});
