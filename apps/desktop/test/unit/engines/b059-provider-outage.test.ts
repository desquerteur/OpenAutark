// B-059 #184/#10 (engines/provider-outage.ts): a provider's transient failure is an outage of the account, not a failure
// of the model – an engine 'timeout' and a cloud provider's HTTP 500/502/504 become 'unavailable' (providerOutage; another
// 5xx and a local runtime's status stay failures, so a lasting local error stalls and escalates), Claude Code's
// "API Error: 5xx / Connection error / Request timed out / overloaded" and assistant error 'server_error' too (claudeDown,
// applied in engines/claude/engine.ts); Codex's and ACP's signals are classified here for their engines' owners. A 4xx, a
// step limit with a number in it, a setup error and every other failure stay as they are; the outage text never reads as
// signed out or not installed (accounts/failure.ts), so it gives a short cooling and failover.
// Owns: these assertions only. Never: real CLIs or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpDown, claudeDown, codexDown, providerDownMessage, providerOutage } from '../../../src/runtime/engines/provider-outage.ts';
import { ERR } from '../../../src/runtime/engines/shared.ts';
import { statusError } from '../../../src/runtime/engines/http/common.ts';
import { accountFailure } from '../../../src/runtime/accounts/failure.ts';
import { errorOutcome } from '../../../src/runtime/agents/turn-finish.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { WorkforceErrorData } from '../../../src/shared/errors.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup } from './claude-fixture.ts';

const failed = (error: WorkforceErrorData): EngineTurnResult => ({ text: '', stop: 'error', error });
const cloud = { provider: 'openai' } as const;

test('providerOutage: an engine timeout and a cloud HTTP 500/502/504 become an outage (text kept) – cooling and failover, no stall', () => {
  for (const error of [ERR.timeout(), statusError(500), statusError(502), statusError(504)]) {
    const result = providerOutage(failed(error), cloud);
    assert.equal(result.error?.code, 'unavailable', error.message);
    assert.equal(result.error?.message, error.message, 'the provider\'s own words stay');
    assert.equal(accountFailure(result), 'overload', 'a short cooling and one failover');
    assert.equal(errorOutcome(result.error), 'unavailable', 'a task: no stall');
  }
});

test('providerOutage: a 4xx, a plain failure, a setup error, a limit and a finished turn stay as they are', () => {
  const kept: EngineTurnResult[] = [
    failed(statusError(400)), failed(ERR.failed()), failed({ code: 'internal', message: 'Reached the maximum number of turns (500).' }),
    failed({ code: 'timeout', message: 'x', details: { setup: true } }), { text: '', stop: 'limit', error: ERR.limit() }, { text: 'Done.', stop: 'done' },
  ];
  for (const result of kept) assert.equal(providerOutage(result, cloud), result);
  assert.equal(accountFailure(failed(statusError(400))), undefined);
});

test('providerOutage: another 5xx (501 not supported, 505, 507) stays a failure', () => {
  for (const status of [501, 505, 507, 599]) {
    const result = failed(statusError(status));
    assert.equal(providerOutage(result, cloud), result, `HTTP ${status}`);
    assert.equal(errorOutcome(result.error), 'failed', 'a task stalls and escalates');
  }
});

test('providerOutage: a local runtime\'s HTTP 500 stays a failure (too little memory, a crashed runner); its timeout is still an outage', () => {
  const locals = [{ provider: 'ollama' }, { provider: 'lmstudio' }, { provider: 'llamacpp' }, { provider: 'vllm' },
    { provider: 'compatible', baseUrl: 'http://127.0.0.1:5000/v1' }, { provider: 'compatible', baseUrl: 'http://localhost:4000/v1' }] as const;
  for (const account of locals) {
    for (const status of [500, 502, 504]) {
      const result = failed(statusError(status));
      assert.equal(providerOutage(result, account), result, `${account.provider} HTTP ${status}`);
    }
    assert.equal(providerOutage(failed(ERR.timeout()), account).error?.code, 'unavailable');
  }
  assert.equal(providerOutage(failed(statusError(500)), { provider: 'compatible', baseUrl: 'https://llm.example.com/v1' }).error?.code, 'unavailable', 'a remote compatible server is a cloud provider');
  assert.equal(providerOutage(failed(statusError(500)), { provider: 'compatible', baseUrl: 'not a url' }).error?.code, 'unavailable');
});

test('the outage text reads neither as signed out nor as not installed', () => {
  for (const who of ['Anthropic', 'OpenAI', 'Gemini CLI']) assert.equal(accountFailure(failed(ERR.unavailable(providerDownMessage(who)))), 'overload');
});

test('claudeDown: server_error and the API\'s 5xx, connection and timeout errors – never a 400 or a step limit', () => {
  assert.equal(claudeDown('server_error', undefined), true);
  assert.equal(claudeDown(undefined, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), true);
  assert.equal(claudeDown(undefined, 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), true);
  assert.equal(claudeDown(undefined, 'API Error: Connection error.'), true);
  assert.equal(claudeDown(undefined, 'API Error: Request timed out.'), true);
  assert.equal(claudeDown(undefined, 'API Error: Repeated 529 Overloaded errors'), true);
  assert.equal(claudeDown(undefined, 'API Error: 400 messages.3: invalid'), false);
  assert.equal(claudeDown(undefined, 'Reached maximum number of turns (500)'), false);
  assert.equal(claudeDown('rate_limit', 'You have hit your limit'), false);
  assert.equal(claudeDown(undefined, undefined), false);
});

test('codexDown: overloaded, server errors and lost connections without a 4xx; acpDown: 5xx status, UNAVAILABLE, overloaded', () => {
  for (const info of ['serverOverloaded', 'internalServerError', 'flexUnavailable', { responseStreamDisconnected: { httpStatusCode: null } },
    { httpConnectionFailed: { httpStatusCode: 502 } }, { responseTooManyFailedAttempts: {} }, { responseStreamConnectionFailed: { httpStatusCode: 408 } }]) {
    assert.equal(codexDown(info), true, JSON.stringify(info));
  }
  for (const info of ['badRequest', 'cyberPolicy', 'usageLimitExceeded', 'contextWindowExceeded', { httpConnectionFailed: { httpStatusCode: 401 } }, undefined, 3]) {
    assert.equal(codexDown(info), false, JSON.stringify(info));
  }
  assert.equal(acpDown('[API Error: got status: 503 Service Unavailable.]'), true);
  assert.equal(acpDown('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'), true);
  assert.equal(acpDown('read ECONNRESET'), true);
  assert.equal(acpDown('Reached the maximum number of turns (500).'), false);
  assert.equal(acpDown('The model gemini-x is unavailable for your account.'), false, 'only gRPC\'s UNAVAILABLE, not the word');
  assert.equal(acpDown(undefined), false);
});

test('claude engine: an overloaded or unreachable API ends the turn unavailable; a 400 stays a failure', async () => {
  const ok = (session: string) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session });
  const runs: Array<[(session: string) => unknown[], string]> = [
    [(session) => [{ ...ok(session), subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }], 'unavailable'],
    [(session) => [{ type: 'assistant', error: 'server_error', message: { id: 'm', content: [{ type: 'text', text: 'API Error' }] } }, { ...ok(session), is_error: true, result: 'API Error' }], 'unavailable'],
    [(session) => [{ ...ok(session), subtype: 'error_during_execution', is_error: true, errors: ['API Error: 400 messages.3: invalid'] }], 'internal'],
  ];
  for (const [turn, code] of runs) {
    const h = claudeSetup({ turn: (_call, session) => turn(session) });
    const result = await h.engine.run(turnInput({ model: 'claude-opus-5-5', account: claudeAccount() }).input);
    assert.equal(result.stop, 'error');
    assert.equal(result.error?.code, code);
    if (code === 'unavailable') assert.equal(result.error?.message, providerDownMessage('Anthropic'));
  }
});
