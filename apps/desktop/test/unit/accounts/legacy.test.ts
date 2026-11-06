// The one-time move of older accounts (runtime/accounts/legacy.ts, 01.11.2026): a 'decision' account becomes a normal
// connection – OpenRouter's its OpenRouter key, a vendor host an OpenAI-compatible address there, a local decision
// server an Ollama or compatible local server – keeping its key, place and on/off; a model data account goes (its key
// stays in the vault); every other account is left alone; a start after it finds nothing to move.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionConnection, migrateOldAccounts } from '../../../src/runtime/accounts/legacy.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { harness, row } from './harness.ts';

const old = (id: string, provider: string, patch: Partial<Account> = {}): Account => row(id, { provider: provider as Account['provider'], label: `${id} decision model`, secretId: `sec_${id}`, ...patch });

test('decision accounts become normal connections; the model data account goes; others stay', () => {
  const db = new Db(':memory:');
  migrate(db);
  const repo = new AccountRepo(db);
  repo.save(old('acc_or', 'decision', { baseUrl: 'https://openrouter.ai/api/v1/systemone', priority: 2 }));
  repo.save(old('acc_liquid', 'decision', { baseUrl: 'https://api.liquid.ai/decisions/v1/systemone', enabled: false, state: 'disabled' }));
  repo.save(old('acc_jev', 'decision', { label: 'My Jev' }));
  repo.save(old('acc_local', 'decision', { baseUrl: 'http://127.0.0.1:11434', auth: 'local', secretId: undefined }));
  repo.save(old('acc_aa', 'artificial-analysis', { label: 'Artificial Analysis' }));
  repo.save(row('acc_openai', { label: 'OpenAI API' }));

  assert.equal(migrateOldAccounts(db), 5);
  const byId = new Map(repo.list().map((account) => [account.id, account]));
  assert.deepEqual(
    [byId.get('acc_or')?.provider, byId.get('acc_or')?.baseUrl, byId.get('acc_or')?.label, byId.get('acc_or')?.secretId, byId.get('acc_or')?.priority, byId.get('acc_or')?.state],
    ['openrouter', undefined, 'OpenRouter', 'sec_acc_or', 2, 'unknown'],
  );
  assert.deepEqual([byId.get('acc_liquid')?.provider, byId.get('acc_liquid')?.baseUrl, byId.get('acc_liquid')?.label, byId.get('acc_liquid')?.state],
    ['compatible', 'https://api.liquid.ai/v1', 'api.liquid.ai', 'disabled']);
  assert.deepEqual([byId.get('acc_jev')?.provider, byId.get('acc_jev')?.baseUrl, byId.get('acc_jev')?.label], ['compatible', 'https://api.typesafe.ai/v1', 'My Jev'], 'no address was TypeSafe Jev; a name of one\'s own stays');
  assert.deepEqual([byId.get('acc_local')?.provider, byId.get('acc_local')?.baseUrl, byId.get('acc_local')?.auth], ['ollama', 'http://127.0.0.1:11434/v1', 'local']);
  assert.equal(byId.has('acc_aa'), false);
  assert.deepEqual([byId.get('acc_openai')?.provider, byId.get('acc_openai')?.label, byId.get('acc_openai')?.state], ['openai', 'OpenAI API', 'ok'], 'untouched');
  assert.equal(migrateOldAccounts(db), 0, 'done once');
});

test('a named API host keeps its own provider; DeepInfra stays an OpenAI-compatible address with its name', () => {
  assert.deepEqual(decisionConnection({ baseUrl: 'https://api.deepinfra.com/v1/openai', auth: 'api_key', label: 'DeepInfra decision model' }),
    { provider: 'compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', label: 'DeepInfra', auth: 'api_key' });
  assert.deepEqual(decisionConnection({ baseUrl: 'http://localhost:8080/systemone', auth: 'none', label: 'x' }),
    { provider: 'compatible', baseUrl: 'http://localhost:8080/v1', label: 'x', auth: 'local' });
});

test('the account service moves them when it starts', () => {
  const db = new Db(':memory:');
  migrate(db);
  new AccountRepo(db).save(old('acc_or', 'decision', { baseUrl: 'https://openrouter.ai/api/v1' }));
  const h = harness({ db });
  assert.deepEqual(h.service.list().map((account) => [account.id, account.provider]), [['acc_or', 'openrouter']]);
});
