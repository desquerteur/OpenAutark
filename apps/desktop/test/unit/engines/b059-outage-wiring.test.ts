// B-059 #184: the outage classifiers applied where the engines map their errors. ACP: a JSON-RPC error's text carries
// the detail an agent puts in `data` (the ACP SDK sends a thrown error as "Internal error" with the real text in
// data.details), and failure() turns an overload/5xx/UNAVAILABLE text into 'unavailable' – after sign-in, limit and a
// lost resumed session, which still win. Codex: a codexErrorInfo outage ends the turn 'unavailable' (engines/codex/turn.ts).
// Owns: these assertions only. Never: real CLIs or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpRpcError, rpcErrorText } from '../../../src/runtime/engines/acp/protocol.ts';
import { failure } from '../../../src/runtime/engines/acp/turn.ts';
import { providerDownMessage } from '../../../src/runtime/engines/provider-outage.ts';

test('rpcErrorText: the message plus data.details / data / data.error.message, at most 300 characters', () => {
  assert.equal(rpcErrorText({ code: -32603, message: 'Internal error', data: { details: '[API Error: got status: 503 UNAVAILABLE]' } }), 'Internal error: [API Error: got status: 503 UNAVAILABLE]');
  assert.equal(rpcErrorText({ message: 'Internal error', data: 'fetch failed' }), 'Internal error: fetch failed');
  assert.equal(rpcErrorText({ message: 'Bad', data: { error: { message: 'overloaded' } } }), 'Bad: overloaded');
  assert.equal(rpcErrorText({ message: 'Same', data: 'Same' }), 'Same', 'no doubled text');
  assert.equal(rpcErrorText({}), 'The agent reported an error.');
  assert.equal(rpcErrorText({ message: 'x'.repeat(400) }).length, 300);
});

test('ACP failure(): an outage text is unavailable; sign-in, limit and a lost resumed session still win; anything else fails', () => {
  const remote = (message: string, code = -32603) => new AcpRpcError('remote', code, message);
  const down = failure(remote('Internal error: [API Error: got status: 503 UNAVAILABLE]'), 'Gemini CLI');
  assert.equal(down.stop, 'error');
  assert.equal(down.error?.code, 'unavailable');
  assert.equal(down.error?.message, providerDownMessage('Gemini CLI'));
  assert.equal(failure(remote('status: 503 – please sign in'), 'Gemini CLI').error?.message, 'Gemini CLI is not signed in for this account.', 'sign-in wins');
  assert.equal(failure(remote('429 Too Many Requests, status: 503'), 'Gemini CLI').stop, 'limit', 'a limit wins');
  assert.equal(failure(remote('session not found (status: 500)'), 'Gemini CLI', true).error?.details?.rebase, true, 'a lost resumed session wins');
  const plain = failure(remote('Internal error'), 'Gemini CLI');
  assert.equal(plain.error?.code, 'internal', 'a plain internal error stays a failure');
});
