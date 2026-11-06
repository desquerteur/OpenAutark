// The decision protocol as a connection (runtime/decision/systemone.ts, wire.ts): what goes over the wire for each question
// type, how an answer reads, the key and address rules, which connection answers, and a failing connection resting while the next
// backend answers.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionConnection, fromResponse, SystemOneBackend, toRequest, tryDecisionConnection, BACK_OFF_MS } from '../../../src/runtime/decision/systemone.ts';
import { DecisionHub } from '../../../src/runtime/decision/service.ts';
import { optionLabels, unitScore } from '../../../src/runtime/decision/wire.ts';
import type { DecisionRequest } from '../../../src/runtime/contracts.ts';
import type { Account } from '../../../src/shared/model/providers.ts';

const choice: DecisionRequest = { purpose: 'other', type: 'choice', question: 'Which?', context: 'ctx', options: ['alpha', 'none'] };
const connection: Account = {
  id: 'typesafe', provider: 'decision-api', label: 'TypeSafe', auth: 'api_key', baseUrl: 'https://api.typesafe.ai/v1', secretId: 'secret://k', state: 'unknown',
  priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1,
};
const services = (decision: string, models: string[] = [], list: Account[] = [connection]) => ({
  accounts: { list: () => list, apiKey: async () => 'sk-test' },
  settings: { get: () => ({ routing: { decision }, providers: { typesafe: { models } } }) },
}) as never;

test('the wire shape of each question', () => {
  assert.deepEqual(toRequest('jev', choice), { model: 'jev', state: 'ctx', questions: { q: { type: 'choice', instructions: 'Which?', criteria: { alpha: 'alpha', none: 'None of the other options fits, or it cannot be judged from the state.' } } } });
  const predicate = toRequest('jev', { purpose: 'other', type: 'predicate', question: 'Yes?' }) as { state: string; questions: { q: { type: string } } };
  assert.equal(predicate.questions.q.type, 'noul');
  assert.equal(predicate.state, '(no further context)', 'never an empty state');
  const score = toRequest('jev', { purpose: 'other', type: 'score', question: 'How much?' }) as { questions: { q: { criteria: string[] } } };
  assert.equal(score.questions.q.criteria.length, 5);
  assert.equal(optionLabels(['x'.repeat(90)])[0].label, 'option_1', 'a long option travels as its description');
});

test('an answer reads back on the hub\'s scale', () => {
  assert.deepEqual(fromResponse({ answers: { q: { choice: 'alpha', probabilities: { alpha: 0.9 } } } }, choice, 'by'), { choice: 'alpha', confidence: 0.9, by: 'by' });
  assert.deepEqual(fromResponse({ answers: { q: { noul: 0.2 } } }, { type: 'predicate' } as DecisionRequest, 'by'), { value: false, confidence: 0.8, by: 'by' });
  assert.deepEqual(fromResponse({ answers: { q: { score: 2, confidence: 0.7 } } }, { type: 'score' } as DecisionRequest, 'by'), { score: 0.5, confidence: 0.7, by: 'by' });
  assert.equal(unitScore(9, 5), 1);
  assert.deepEqual(fromResponse({}, { type: 'score' } as DecisionRequest, 'by'), { score: undefined, confidence: 0, by: 'by' });
});

test('which connection answers: the named one, on auto the first with a model; none without', () => {
  assert.deepEqual(decisionConnection(services('typesafe:jev-latest')), { account: connection, model: 'jev-latest' });
  assert.equal(decisionConnection(services('openai:gpt-small')), undefined, 'another model is named: the LLM backend answers');
  assert.equal(decisionConnection(services('auto')), undefined, 'no model known yet');
  assert.deepEqual(decisionConnection(services('auto', ['jev-1']))?.model, 'jev-1');
  assert.equal(decisionConnection(services('typesafe:x', [], [{ ...connection, enabled: false }])), undefined);
});

test('the call: its address, its key, no redirect; Baseten\'s own word', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ answers: { q: { choice: 'alpha', confidence: 0.8 } } })); }) as unknown as typeof fetch;
  const backend = new SystemOneBackend({ services: () => services('typesafe:jev'), fetch: fetchFn });
  assert.ok(backend.available());
  const answer = await backend.decide(choice, new AbortController().signal);
  assert.deepEqual(answer, { choice: 'alpha', confidence: 0.8, by: 'typesafe:jev' });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.redirect, 'error');
  const baseten = { ...connection, baseUrl: 'https://inference.baseten.co/v1/' };
  await new SystemOneBackend({ services: () => services('typesafe:elephant', [], [baseten]), fetch: fetchFn }).decide(choice, new AbortController().signal);
  assert.equal(calls[1].url, 'https://inference.baseten.co/v1/systemone');
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Api-Key sk-test');
});

test('a failing connection rests while the next backend answers; a stopped caller does not count', async () => {
  let now = 1000;
  let healthy = false;
  const fetchFn = (async () => (healthy ? new Response(JSON.stringify({ answers: { q: { noul: 1 } } })) : new Response('{}', { status: 500 }))) as unknown as typeof fetch;
  const backend = new SystemOneBackend({ services: () => services('typesafe:jev'), fetch: fetchFn, now: () => now });
  const next = { id: 'llm', available: () => true, decide: async () => ({ value: false, confidence: 0.6, by: 'llm' }) };
  const hub = new DecisionHub({ backends: [backend, next] });
  const question: DecisionRequest = { purpose: 'other', type: 'predicate', question: 'Yes?' };
  assert.equal((await hub.decide(question)).by, 'llm');
  assert.equal(backend.available(), false);
  now += BACK_OFF_MS + 1;
  assert.equal(backend.available(), true);
  healthy = true;
  assert.equal((await hub.decide(question)).by, 'typesafe:jev');
  healthy = false;
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(backend.decide(question, stopped.signal));
  assert.equal(backend.available(), true, 'the caller ended it');
});

test('accounts.try on a decision connection: one real question', async () => {
  const good = (async () => new Response(JSON.stringify({ answers: { q: { noul: 0.99 } } }))) as unknown as typeof fetch;
  const result = await tryDecisionConnection(services('typesafe:jev'), connection, good);
  assert.deepEqual([result.ok, result.ok && result.model], [true, 'typesafe:jev']);
  assert.match((await tryDecisionConnection(services('auto'), connection, good) as { message: string }).message, /no model yet/);
  const odd = (async () => new Response('{}')) as unknown as typeof fetch;
  assert.deepEqual(await tryDecisionConnection(services('typesafe:jev'), connection, odd), { ok: false, reason: 'error', message: 'TypeSafe answered, but not with what the decision protocol describes.' });
});
