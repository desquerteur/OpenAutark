// settings.json's providers section ↔ accounts (runtime/accounts/provider-file.ts, shared/model/provider-entries.ts): an entry
// is an account with its id, a change follows, a removed entry takes its account along, accounts.add writes an entry, older API
// connections move in once and keep their key, state and runs; a detected local server and a plan row stay out of the file; a
// section that is not valid removes nothing.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { ProviderFile } from '../../../src/runtime/accounts/provider-file.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { entryConnection, entryProblem, modelOwner, providerNotes } from '../../../src/shared/model/provider-entries.ts';
import type { Account, ProviderId } from '../../../src/shared/model/providers.ts';

function setup(seed: Array<Partial<Account> & { id: string; provider: ProviderId }> = []) {
  const db = new Db(':memory:');
  migrate(db);
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock();
  const settings = new SettingsStore({ bus, clock, env: { locale: 'en', timezone: 'UTC' } });
  const repo = new AccountRepo(db);
  const row = (provider: ProviderId, patch: Partial<Account>): Account => ({
    id: 'x', provider, label: provider, auth: 'none', state: 'unknown', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...patch,
  });
  for (const account of seed) repo.save(row(account.provider, account));
  const checked: string[] = [];
  const forgotten: string[] = [];
  const file = new ProviderFile({
    db, repo, settings, now: () => clock.now(), save: (account) => repo.save(account), blank: row,
    forget: (account) => { forgotten.push(account.id); repo.remove(account.id); },
    check: (id) => checked.push(id),
  });
  bus.on('settings.updated', () => file.sync());
  return { db, repo, settings, file, checked, forgotten };
}

test('an entry is an account with its id; a change follows; a removed entry takes its account along', () => {
  const { repo, settings, checked, forgotten } = setup();
  settings.update({ providers: { deepinfra: { name: 'Deep', key: 'secret://sec_1' }, mine: { protocol: 'anthropic', url: 'https://llm.example.test/' } } });
  const deep = repo.get('deepinfra')!;
  assert.deepEqual([deep.provider, deep.baseUrl, deep.label, deep.auth, deep.secretId], ['compatible', 'https://api.deepinfra.com/v1/openai', 'Deep', 'api_key', 'secret://sec_1'], 'the table fills what the entry leaves out');
  assert.deepEqual([repo.get('mine')!.provider, repo.get('mine')!.baseUrl, repo.get('mine')!.auth], ['anthropic', 'https://llm.example.test', 'none']);
  assert.deepEqual(checked, ['deepinfra', 'mine']);
  repo.save({ ...deep, state: 'ok', priority: 7 });
  settings.update({ providers: { deepinfra: { name: 'DeepInfra' } } });
  assert.deepEqual([repo.get('deepinfra')!.label, repo.get('deepinfra')!.state, repo.get('deepinfra')!.priority], ['DeepInfra', 'ok', 7], 'a new name is no new connection');
  settings.update({ providers: { deepinfra: { key: 'secret://sec_2' } } });
  assert.deepEqual([repo.get('deepinfra')!.secretId, repo.get('deepinfra')!.state, repo.get('deepinfra')!.priority], ['secret://sec_2', 'unknown', 7], 'a new key is checked again, its place stays');
  settings.update({ providers: { mine: null } } as never);
  assert.deepEqual(forgotten, ['mine']);
  assert.equal(repo.get('mine'), undefined);
});

test('accounts.add writes an entry: the id comes from the service, then the name', () => {
  const { repo, settings, file } = setup();
  const first = file.add({ provider: 'compatible', label: 'DeepInfra' }, { auth: 'api_key', baseUrl: 'https://api.deepinfra.com/v1/openai', secretId: 'sec_9', detected: false });
  assert.equal(first.id, 'deepinfra');
  assert.deepEqual(settings.get().providers?.deepinfra, { name: 'DeepInfra', protocol: 'openai-chat', url: 'https://api.deepinfra.com/v1/openai', key: 'secret://sec_9' });
  const second = file.add({ provider: 'compatible', label: 'DeepInfra 2', rotation: true }, { auth: 'api_key', baseUrl: 'https://api.deepinfra.com/v1/openai', secretId: 'secret://sec_8', detected: false });
  assert.equal(second.id, 'deepinfra-2');
  assert.equal(second.rotation, true);
  const other = file.add({ provider: 'compatible', label: 'llm.example.test' }, { auth: 'none', baseUrl: 'https://llm.example.test/v1', detected: false });
  assert.equal(other.id, 'llm-example-test');
  assert.equal(settings.get().providers?.['llm-example-test'].key, undefined);
  const openai = file.add({ provider: 'openai', label: 'OpenAI' }, { auth: 'api_key', secretId: 'sec_1', detected: false });
  assert.deepEqual([openai.id, openai.provider, openai.baseUrl], ['openai', 'openai', 'https://api.openai.com/v1'], 'the known address is written out');
  const proxy = file.add({ provider: 'anthropic', label: 'claude.example.test' }, { auth: 'api_key', baseUrl: 'https://claude.example.test/v1', secretId: 'sec_2', detected: false });
  assert.deepEqual([proxy.id, proxy.provider], ['claude-example-test', 'anthropic'], 'another address never takes a service\'s id');
  file.rename('openai', 'Work key');
  assert.equal(repo.get('openai')!.label, 'Work key');
  assert.equal(settings.get().providers?.openai.name, 'Work key');
  file.remove('openai');
  assert.equal(repo.get('openai'), undefined);
});

test('older API connections move in once; plans, environment keys and found servers stay', () => {
  const { db, repo, settings, file, forgotten } = setup([
    { id: 'acc_1', provider: 'compatible', label: 'DeepInfra', auth: 'api_key', baseUrl: 'https://api.deepinfra.com/v1/openai', secretId: 'sec_1', state: 'ok', priority: 3 },
    { id: 'acc_2', provider: 'openai', label: 'OpenAI API', auth: 'api_key', secretId: 'secret://sec_2', state: 'cooling', coolingUntil: 99 },
    { id: 'acc_3', provider: 'codex', label: 'Codex', auth: 'cli', detected: true },
    { id: 'acc_4', provider: 'openai', label: 'From env', auth: 'env', envVar: 'OPENAI_API_KEY', detected: true },
    { id: 'acc_5', provider: 'ollama', label: 'Ollama', auth: 'local', baseUrl: 'http://127.0.0.1:11434/v1', detected: true },
    { id: 'acc_6', provider: 'ollama', label: 'Mine', auth: 'local', baseUrl: 'http://127.0.0.1:11500/v1' },
  ]);
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('catalog', 'listing:acc_1', '{"models":[],"at":1}', 1)`);
  settings.update({ routing: { voice: 'acc_2:gpt-realtime' } });
  file.moveOld();
  file.sync();
  assert.deepEqual(Object.keys(settings.get().providers ?? {}).sort(), ['deepinfra', 'ollama', 'openai']);
  assert.deepEqual(settings.get().providers?.deepinfra, { name: 'DeepInfra', protocol: 'openai-chat', url: 'https://api.deepinfra.com/v1/openai', key: 'secret://sec_1' });
  assert.equal(settings.get().routing.voice, 'openai:gpt-realtime', 'the Voice use follows its account');
  assert.equal(repo.get('acc_1'), undefined);
  const deep = repo.get('deepinfra')!;
  assert.deepEqual([deep.provider, deep.priority, deep.secretId], ['compatible', 3, 'secret://sec_1']);
  assert.equal(repo.get('openai')!.provider, 'openai');
  const mine = repo.get('ollama')!;
  assert.deepEqual([mine.provider, mine.auth, mine.baseUrl], ['ollama', 'local', 'http://127.0.0.1:11500/v1'], 'a local server on its own port stays that server');
  for (const id of ['acc_3', 'acc_4', 'acc_5']) assert.ok(repo.get(id), `${id} stays`);
  assert.deepEqual(forgotten, []);
  file.moveOld();
  assert.equal(Object.keys(settings.get().providers ?? {}).length, 3, 'once');
  assert.ok(db.get(`SELECT 1 FROM kv WHERE ns = 'catalog' AND key = 'listing:deepinfra'`), 'its list comes along');
});

test('an entry that does not fit: what it says, and its section takes nothing away', () => {
  assert.match(entryProblem('deepinfra', { key: 'sk-plain' })!, /handle secret/);
  assert.match(entryProblem('codex', {})!, /an id of/, 'a use says "codex" for the plan');
  assert.match(entryProblem('mine', {})!, /needs a url/);
  assert.match(entryProblem('mine', { url: 'https://x.test', protocol: 'grpc' })!, /protocol/);
  assert.match(entryProblem('mine', { url: 'https://x.test', models: [{ id: 'a', uses: ['nothing'] }] })!, /uses/);
  assert.equal(entryProblem('mine', { url: 'https://x.test', models: ['a', { id: 'b', uses: ['embeddings'] }] }), undefined);
  const { repo, settings, file, forgotten } = setup();
  settings.update({ providers: { mine: { url: 'https://x.test' } } });
  assert.ok(repo.get('mine'));
  assert.throws(() => settings.update({ providers: { mine: { url: 'http://x.test' } } }), /providers\.mine\.url/, 'the engines would refuse it');
  (settings as unknown as { noticeText: string }).noticeText = 'settings.json: providers was not applied (x).';
  (settings as unknown as { cache: unknown }).cache = { ...settings.get(), providers: undefined };
  file.sync();
  assert.deepEqual(forgotten, [], 'a section that is not applied removes nothing');
});

test('a file that cannot be used at all takes nothing away; a problem in another section holds no removal back', () => {
  const { repo, settings, file, forgotten } = setup();
  settings.update({ providers: { mine: { url: 'https://x.test' } } });
  const state = settings as unknown as { noticeText: string; cache: unknown };
  state.cache = { ...settings.get(), providers: undefined }; // a start: the file gave nothing, so no entries
  for (const notice of ['settings.json is not valid JSON. The last good values stay until the file is fixed.', 'settings.json cannot be read. The last good values stay until the file is fixed.', 'settings.json: settings was not applied (x).', 'settings.json: day, providers were not applied (x).']) {
    state.noticeText = notice;
    file.sync();
    assert.deepEqual(forgotten, [], notice);
    assert.ok(repo.get('mine'), notice);
  }
  state.noticeText = 'settings.json: day was not applied (x). The last good values stay until the file is fixed.';
  file.sync();
  assert.deepEqual(forgotten, ['mine']);
});

test('a media service is written without a protocol, and reads back as itself', () => {
  const { repo, settings, file } = setup();
  const fal = file.add({ provider: 'fal', label: 'fal.ai' }, { auth: 'api_key', secretId: 'sec_1', detected: false });
  assert.deepEqual(settings.get().providers?.fal, { name: 'fal.ai', url: 'https://queue.fal.run', key: 'secret://sec_1' });
  assert.deepEqual([fal.id, fal.provider, repo.get('fal')!.auth], ['fal', 'fal', 'api_key']);
});

test('what an entry means; the comment above the section names every service and protocol', () => {
  const connection = (id: string, entry: object) => entryConnection(id, entry) as { provider: string; auth: string; baseUrl?: string };
  assert.equal(connection('groq', { key: 'secret://a' }).provider, 'groq');
  assert.equal(connection('anything', { url: 'https://api.groq.com/openai/v1' }).provider, 'groq', 'a known host keeps its quirks');
  assert.equal(connection('anything', { url: 'https://api.openai.com/v1' }).provider, 'compatible', 'chat completions on OpenAI\'s host');
  assert.equal(connection('anything', { protocol: 'openai-responses', url: 'https://x.test/v1' }).provider, 'openai');
  assert.equal(connection('anything', { protocol: 'decision', url: 'https://api.typesafe.ai/v1' }).provider, 'decision-api');
  assert.equal(connection('fal', {}).provider, 'fal');
  assert.deepEqual([connection('anything', { url: 'http://127.0.0.1:1234/v1' }).provider, connection('anything', { url: 'http://127.0.0.1:1234/v1' }).auth], ['lmstudio', 'local']);
  assert.equal(modelOwner({ id: 'deepinfra', provider: 'compatible' }, { deepinfra: {} }), 'deepinfra');
  assert.equal(modelOwner({ id: 'acc_1', provider: 'compatible' }, { deepinfra: {} }), 'compatible');
  const notes = providerNotes().join('\n');
  for (const words of ['deepinfra | https://api.deepinfra.com/v1/openai | openai-chat | https://deepinfra.com/dash/api_keys', 'ollama | http://127.0.0.1:11434/v1', 'openai-responses:', 'decision:', 'fal | https://queue.fal.run | its own']) assert.ok(notes.includes(words), words);
});
