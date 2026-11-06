// DecisionHub (first available backend, validation, none option, redaction, deadline and stop, RT9's choice outcome
// choice / none_fit / unsure) and the LLM backend's schema and parsing with a fake runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionHub, SURE_CONFIDENCE, outcomeOf } from '../../../src/runtime/decision/service.ts';
import { LlmDecisionBackend } from '../../../src/runtime/decision/llm-fallback.ts';
import type { DecisionBackend } from '../../../src/runtime/decision/types.ts';
import type { DecisionRequest, DecisionResult } from '../../../src/runtime/contracts.ts';

function stub(id: string, answer: (request: DecisionRequest) => DecisionResult | Error, up = true) {
  const seen: DecisionRequest[] = [];
  const backend: DecisionBackend = {
    id, available: () => up,
    async decide(request) { seen.push(request); const out = answer(request); if (out instanceof Error) throw out; return out; },
  };
  return { backend, seen };
}

const choice: DecisionRequest = { type: 'choice', question: 'Which widget?', options: ['record', 'timer'], purpose: 'widget' };

test('the first available backend answers; a failure falls through; "none" is always offered', async () => {
  const down = stub('a', () => new Error('down'));
  const off = stub('b', () => ({ choice: 'timer', confidence: 0.9, by: 'b' }), false);
  const llm = stub('llm', () => ({ choice: 'record', confidence: 0.8, by: 'llm' }));
  const hub = new DecisionHub({ backends: [down.backend, off.backend, llm.backend] });
  assert.equal(hub.available(), true);
  assert.deepEqual(await hub.decide(choice), { choice: 'record', confidence: 0.8, by: 'llm', outcome: 'choice' });
  assert.equal(down.seen.length, 1);
  assert.equal(off.seen.length, 0);
  assert.deepEqual(llm.seen[0].options, ['record', 'timer', 'none']);
  const none = new DecisionHub({ backends: [] });
  assert.equal(none.available(), false);
  assert.deepEqual(await none.decide(choice), { confidence: 0, by: 'none', outcome: 'unsure' });
});

test('validation: unknown option and "none" give no choice; confidence is clamped', async () => {
  let answer: DecisionResult = { choice: 'banana', confidence: 0.99, by: 'x' };
  const llm = stub('llm', () => answer);
  const hub = new DecisionHub({ backends: [llm.backend] });
  assert.deepEqual(await hub.decide(choice), { confidence: 0, by: 'x', outcome: 'unsure' });
  answer = { choice: 'none', confidence: 0.9, by: 'x' };
  assert.deepEqual(await hub.decide(choice), { confidence: 0.9, by: 'x', outcome: 'none_fit' });
  answer = { choice: 'TIMER', confidence: 7, by: 'x' };
  assert.deepEqual(await hub.decide(choice), { choice: 'timer', confidence: 1, by: 'x', outcome: 'choice' });
  answer = { value: true, confidence: 0.8, by: 'x' };
  assert.deepEqual(await hub.decide({ type: 'predicate', question: 'ok?', purpose: 'other' }), { value: true, confidence: 0.8, by: 'x' });
});

test('outcome: "none" at 0.8 is none_fit, at 0.3 unsure; a low-confidence pick is unsure but kept', async () => {
  let answer: DecisionResult = { choice: 'none', confidence: 0.8, by: 'x' };
  const llm = stub('llm', () => answer);
  const hub = new DecisionHub({ backends: [llm.backend] });
  assert.equal((await hub.decide(choice)).outcome, 'none_fit');
  answer = { choice: 'none', confidence: 0.3, by: 'x' };
  assert.deepEqual(await hub.decide(choice), { confidence: 0.3, by: 'x', outcome: 'unsure' });
  answer = { choice: 'none', confidence: SURE_CONFIDENCE, by: 'x' };
  assert.equal((await hub.decide(choice)).outcome, 'none_fit', 'the threshold itself counts as sure');
  answer = { choice: 'timer', confidence: 0.3, by: 'x' };
  assert.deepEqual(await hub.decide(choice), { choice: 'timer', confidence: 0.3, by: 'x', outcome: 'unsure' });
  answer = { choice: 'none', confidence: 0.9, by: 'x' };
  assert.deepEqual(await hub.decide({ ...choice, options: ['record', 'none'] }), { choice: 'none', confidence: 0.9, by: 'x', outcome: 'choice' }, "a caller's own none is an option");
  answer = { value: true, confidence: 0.9, by: 'x' };
  assert.equal((await hub.decide({ type: 'predicate', question: 'ok?', purpose: 'other' })).outcome, undefined);
  assert.deepEqual(await hub.decide({ ...choice, options: [] }), { confidence: 0, by: 'none', outcome: 'unsure' });
});

test('a timed-out choice is unsure; outcomeOf derives the outcome for services without the field', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = stub('llm', () => new Error('unused'));
  slow.backend.decide = () => new Promise(() => {});
  const hub = new DecisionHub({ backends: [slow.backend] });
  const pending = hub.decide({ ...choice, timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, { confidence: 0, by: 'timeout', outcome: 'unsure' });
  assert.equal(outcomeOf({ choice: 'timer', confidence: 0.9, by: 'fake' }), 'choice');
  assert.equal(outcomeOf({ choice: 'timer', confidence: 0.2, by: 'fake' }), 'unsure');
  assert.equal(outcomeOf({ confidence: 0.9, by: 'hub', outcome: 'none_fit' }), 'none_fit');
});

test('a request with its own deadline has that time, not the default of one attempt', async () => {
  const slow = stub('llm', () => new Error('unused'));
  slow.backend.decide = (_request, signal) => new Promise((resolve, reject) => {
    const answer = setTimeout(() => resolve({ choice: 'timer', confidence: 0.9, by: 'llm' }), 60);
    signal?.addEventListener('abort', () => { clearTimeout(answer); reject(new Error('cut')); }, { once: true });
  });
  const hub = new DecisionHub({ backends: [slow.backend], timeoutMs: 5 });
  assert.deepEqual(await hub.decide({ ...choice, timeoutMs: 5000 }), { choice: 'timer', confidence: 0.9, by: 'llm', outcome: 'choice' });
  assert.deepEqual(await hub.decide(choice), { confidence: 0, by: 'none', outcome: 'unsure' }, 'without one the default stands');
});

test('a stopped request aborts the running call, tries no further backend and answers by "stopped"', async () => {
  let attempt: AbortSignal | undefined;
  const slow = stub('a', () => new Error('unused'));
  slow.backend.decide = (_request, signal) => { attempt = signal; return new Promise(() => {}); };
  const next = stub('llm', () => ({ choice: 'timer', confidence: 0.9, by: 'llm' }));
  const hub = new DecisionHub({ backends: [slow.backend, next.backend] });
  const stop = new AbortController();
  const pending = hub.decide({ ...choice, timeoutMs: 60_000, signal: stop.signal });
  stop.abort();
  assert.deepEqual(await pending, { confidence: 0, by: 'stopped', outcome: 'unsure' });
  assert.equal(attempt?.aborted, true);
  assert.equal(next.seen.length, 0);
});

test('redaction runs before the backend sees the request', async () => {
  const llm = stub('llm', () => ({ value: false, confidence: 0.9, by: 'x' }));
  const hub = new DecisionHub({ backends: [llm.backend], redact: (text) => text.replaceAll('sk-very-secret', 'secret://sec_1') });
  await hub.decide({ type: 'predicate', question: 'Send sk-very-secret?', context: 'key sk-very-secret', purpose: 'other' });
  assert.equal(llm.seen[0].question, 'Send secret://sec_1?');
  assert.equal(llm.seen[0].context, 'key secret://sec_1');
});

test('LLM backend uses a JSON schema and parses structured or text JSON', async () => {
  const prompts: any[] = [];
  const backend = new LlmDecisionBackend(async (input) => {
    prompts.push(input);
    return input.schema && (input.schema as any).properties.choice
      ? { text: '', structured: { choice: 'timer', confidence: 0.75 }, by: 'claude:claude-haiku-5-5' }
      : { text: 'Sure: {"value": false, "confidence": 0.6}', by: 'm' };
  });
  assert.deepEqual(await backend.decide({ ...choice, options: ['record', 'timer', 'none'] }, AbortSignal.timeout(1000)),
    { choice: 'timer', confidence: 0.75, by: 'llm:claude:claude-haiku-5-5' });
  assert.deepEqual((prompts[0].schema as any).properties.choice.enum, ['record', 'timer', 'none']);
  assert.deepEqual(await backend.decide({ type: 'predicate', question: 'x', purpose: 'other' }, AbortSignal.timeout(1000)), { value: false, confidence: 0.6, by: 'llm:m' });
});
