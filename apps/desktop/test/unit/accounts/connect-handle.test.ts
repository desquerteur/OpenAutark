// accounts.add and accounts.test take a secret://<id> handle as apiKey (runtime/accounts/connect.ts, endpoint-test.ts): the
// account keeps the handle, nothing is copied, a handle without a value is refused, and only the account's own typed key
// is deleted with the account (service.ts).
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connection, handleId, vaultId } from '../../../src/runtime/accounts/connect.ts';
import { testEndpoint } from '../../../src/runtime/accounts/endpoint-test.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';

const secrets = () => {
  const saved: string[] = [];
  return { saved, save: async (input: { value: string }) => { saved.push(input.value); return { id: 'typed-key' }; }, read: async (id: string) => (id === 'deepinfra-key' ? 'sk-real' : undefined) };
};

test('a handle stays a handle; a typed key goes to the vault', async () => {
  const port = secrets();
  const linked = await connection({ provider: 'compatible', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: ' secret://deepinfra-key ' }, { env: {}, secrets: port });
  assert.deepEqual([linked.auth, linked.secretId, port.saved], ['api_key', 'secret://deepinfra-key', []]);
  const typed = await connection({ provider: 'compatible', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'sk-typed' }, { env: {}, secrets: port });
  assert.deepEqual([typed.secretId, port.saved], ['typed-key', ['sk-typed']]);
  assert.equal(vaultId('secret://deepinfra-key'), 'deepinfra-key');
  assert.equal(vaultId('typed-key'), 'typed-key');
  assert.equal(handleId('sk-typed'), undefined);
});

test('a handle without a stored value is refused with a clear line', async () => {
  await assert.rejects(connection({ provider: 'openai', label: 'OpenAI', apiKey: 'secret://nothing-here' }, { env: {}, secrets: secrets() }),
    (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && /secret:\/\/nothing-here/.test(error.message));
});

test('accounts.test reads the value behind the handle for this one call', async () => {
  const keys = new Map<string, string>();
  let seen: string | undefined;
  const engine = { listModels: async (account: { id: string }) => { seen = keys.get(account.id); return [{ model: 'qwen' }]; } } as unknown as Engine;
  const result = await testEndpoint({ provider: 'compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'secret://deepinfra-key' }, { engine: () => engine, keys, secrets: secrets(), now: () => 1 });
  assert.deepEqual(result, { models: ['qwen'] });
  assert.equal(seen, 'sk-real');
  assert.equal(keys.size, 0, 'gone after the call');
});
