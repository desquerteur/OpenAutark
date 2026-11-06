// SG – "low by default, medium when needed": the LLM decision fallback asks once more at medium
// when a low-effort answer is unsure or unreadable (never a third call, never after the caller
// stopped, never when the model cannot run higher), and the engine runner passes the asked effort
// to the router as an effort-only request and reports the effort that ran and the model's efforts.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { account, setup } from '../models/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { LlmDecisionBackend } from '../../../src/runtime/decision/llm-fallback.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';

const TEMP = tempDir('wf-escalate-');
after(() => TEMP.cleanup());

function scripted(answers: Array<{ effort: string; text: string; efforts?: string[] }>) {
  const calls: Array<string | undefined> = [];
  const run: StructuredRunner = async (input) => {
    calls.push(input.effort);
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return { text: next.text, by: 'codex:gpt-6-luna', effort: next.effort as never, ...(next.efforts ? { efforts: next.efforts as never } : {}) };
  };
  return { run, calls };
}

const choice = { type: 'choice' as const, purpose: 'route' as const, question: 'Which?', options: ['a', 'b'] };

test('an unsure low-effort answer is asked again at medium; the surer answer counts', async () => {
  const { run, calls } = scripted([{ effort: 'low', text: '{"choice":"a","confidence":0.3}' }, { effort: 'medium', text: '{"choice":"b","confidence":0.9}' }]);
  const answer = await new LlmDecisionBackend(run).decide(choice, new AbortController().signal);
  assert.deepEqual(calls, [undefined, 'medium']);
  assert.deepEqual([answer.choice, answer.confidence], ['b', 0.9]);
});

test('a sure answer, an answer that already ran at medium, or a stopped caller: one call only', async () => {
  const sure = scripted([{ effort: 'low', text: '{"choice":"a","confidence":0.8}' }]);
  assert.equal((await new LlmDecisionBackend(sure.run).decide(choice, new AbortController().signal)).choice, 'a');
  assert.deepEqual(sure.calls, [undefined]);
  const medium = scripted([{ effort: 'medium', text: '{"choice":"a","confidence":0.2}' }]);
  await new LlmDecisionBackend(medium.run).decide(choice, new AbortController().signal);
  assert.equal(medium.calls.length, 1);
  const stopped = new AbortController();
  stopped.abort();
  const late = scripted([{ effort: 'low', text: 'not json' }]);
  assert.equal((await new LlmDecisionBackend(late.run).decide(choice, stopped.signal)).confidence, 0);
  assert.equal(late.calls.length, 1);
});

test('no retry when the answering model cannot run above the effort that ran (it would be the same call again)', async () => {
  const fixed = scripted([{ effort: 'none', text: '{"choice":"a","confidence":0.2}', efforts: ['none'] }]);
  const answer = await new LlmDecisionBackend(fixed.run).decide(choice, new AbortController().signal);
  assert.deepEqual([fixed.calls.length, answer.choice], [1, 'a']);
  const lowOnly = scripted([{ effort: 'low', text: 'hmm', efforts: ['none', 'low'] }]);
  await new LlmDecisionBackend(lowOnly.run).decide(choice, new AbortController().signal);
  assert.equal(lowOnly.calls.length, 1);
  const raisable = scripted([{ effort: 'low', text: 'hmm', efforts: ['low', 'high'] }, { effort: 'high', text: '{"choice":"b","confidence":0.8}' }]);
  assert.equal((await new LlmDecisionBackend(raisable.run).decide(choice, new AbortController().signal)).choice, 'b', 'medium clamps up to high: a real step');
});

test('an unreadable low answer is retried; a worse or failed retry keeps the first answer', async () => {
  const unreadable = scripted([{ effort: 'low', text: 'hmm' }, { effort: 'medium', text: '{"value":true,"confidence":0.7}' }]);
  const predicate = await new LlmDecisionBackend(unreadable.run).decide({ type: 'predicate', purpose: 'verify', question: 'Done?' }, new AbortController().signal);
  assert.deepEqual([predicate.value, predicate.confidence], [true, 0.7]);
  const failing = scripted([{ effort: 'low', text: '{"choice":"a","confidence":0.4}' }]);
  const kept = await new LlmDecisionBackend(failing.run).decide(choice, new AbortController().signal);
  assert.deepEqual([kept.choice, kept.confidence, failing.calls.length], ['a', 0.4, 2]);
});

test('engine runner: the helper default runs at low, an asked effort reaches the route, the answer names it', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high'] }]);
  await h.catalog.refresh({ force: true });
  const runs: EngineTurnInput[] = [];
  const engines = { get: () => ({ run: async (input: EngineTurnInput) => { runs.push(input); return { text: '{}', stop: 'done' }; } }) } as unknown as EngineRegistry;
  const runner = createEngineRunner({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, paths: { temp: TEMP.dir }, clock: h.clock });
  const low = await runner({ purpose: 'decision', system: 'Decide.', prompt: 'Which?' });
  const medium = await runner({ purpose: 'decision', system: 'Decide.', prompt: 'Which?', effort: 'medium' });
  assert.deepEqual([low.effort, medium.effort], ['low', 'medium']);
  assert.deepEqual(low.efforts, ['none', 'low', 'medium', 'high'], 'the answer names what the model supports');
  assert.deepEqual(runs.map((run) => [run.model, run.effort]), [['gpt-6-luna', 'low'], ['gpt-6-luna', 'medium']]);
});
