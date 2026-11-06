// Settings › Models' use rows (ui/settings/uses-view.ts): the selects show what the use resolves to (models.uses), the
// provider select lists the accounts that can serve it plus This PC and Off, the model select that account's models, and a
// pick becomes the change of settings.json that makes it real. The word Automatic has no option here, and a cell where a
// model resolves names that model (B-072: GPT Image on the ChatGPT plan, the models a call on this PC hears and speaks with).
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelOptions, namedValue, OTHER, providerOptions, servingAccounts, setUpRequest, THIS_PC, useRowView, writeModel, writeProvider } from '../../../src/ui/settings/uses-view.ts';
import type { LocalSpeechOffer } from '../../../src/shared/model/local-speech-models.ts';
import type { ModelUse, UseNow } from '../../../src/shared/model/models-uses.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';

const account = (id: string, provider: Account['provider'], patch: Partial<Account> = {}): Account => ({
  id, provider, label: id === 'acc_codex' ? 'Codex · work' : id, auth: provider === 'codex' ? 'cli' : 'api_key', state: 'ok', priority: 0, rotation: false,
  enabled: true, detected: false, createdAt: 1, ...patch,
});
const model = (id: string, name: string, accounts: string[], patch: Partial<ModelInfo> = {}): ModelInfo => ({
  id, provider: id.split(':')[0] as ModelInfo['provider'], model: id.split(':')[1], name, engine: 'compatible', efforts: [], caps: {}, tier: 'strong',
  strengths: {}, available: true, accounts, ...patch,
});
const now = (use: ModelUse, patch: Partial<UseNow>): UseNow => ({ use, stored: 'auto', kind: 'model', state: 'ready', ...patch });
const offer = (id: string, purpose: 'stt' | 'tts', patch: Partial<LocalSpeechOffer> = {}) => ({ id, purpose, label: id, downloadMb: 100, installed: false, recommended: false, ...patch }) as LocalSpeechOffer;

const ACCOUNTS = [account('acc_codex', 'codex', { plan: 'plus' }), account('acc_or', 'openrouter', { label: 'OpenRouter' }), account('acc_di', 'compatible', { label: 'DeepInfra' })];
const MODELS = [
  model('codex:gpt-6.1-sol', 'GPT-6.1 Sol', ['acc_codex']),
  model('openrouter:qwen/qwen3-8b', 'Qwen3 8B', ['acc_or']),
  model('openrouter:openai/whisper-1', 'Whisper', ['acc_or'], { functions: ['stt'] }),
  model('compatible:Qwen/Qwen3-Embedding-8B', 'Qwen3 Embedding', ['acc_di']),
];
const OFFERS = [offer('canary', 'stt', { installed: true }), offer('fastconformer', 'stt', { recommended: true }), offer('supertonic', 'tts', { recommended: true })];

test('the provider select lists who can serve the use, This PC and Off where they apply; there is no Automatic', () => {
  assert.deepEqual(servingAccounts('stt', MODELS, ACCOUNTS).map((entry) => entry.id), ['acc_or']);
  assert.deepEqual(providerOptions('work', now('work', { accountId: 'acc_codex' }), MODELS, ACCOUNTS).map((option) => option.value), ['acc_codex', 'acc_or', 'acc_di']);
  assert.deepEqual(providerOptions('stt', now('stt', { kind: 'this-pc', thisPc: true }), MODELS, ACCOUNTS).map((option) => option.label), ['OpenRouter', 'This PC', 'Off']);
  const all = ['work', 'decision', 'stt', 'embeddings'] as const;
  for (const use of all) assert.equal(providerOptions(use, now(use, {}), MODELS, ACCOUNTS).some((option) => /automatic/i.test(option.label)), false);
});

test('before models.uses answers: both cells empty, the empty dot, no None and no action', () => {
  const view = useRowView('video', undefined, MODELS, ACCOUNTS, OFFERS, undefined, true);
  assert.deepEqual([view.provider, view.providers, view.model, view.models], ['', [{ value: '', label: '' }], '', [{ value: '', label: '' }]]);
  assert.deepEqual([view.state, view.modelFixed, view.button], ['pending', true, undefined]);
});

test('nothing serves it: None in both selects and Set up with AI', () => {
  const view = useRowView('video', now('video', { kind: 'none', state: 'setup' }), MODELS, ACCOUNTS, OFFERS, undefined, true);
  assert.equal(view.provider, '');
  assert.deepEqual(view.providers.map((option) => option.label), ['None', 'Off']);
  assert.deepEqual([view.model, view.models[0].label, view.modelFixed], ['', 'None', true]);
  assert.deepEqual(view.button, { kind: 'ai', label: 'Set up with AI', disabled: false });
  assert.match(setUpRequest('video'), /^Set up Video/);
});

test('the selects show what really runs, also when it is not listed; a cell names the model, never a mode', () => {
  const plan = useRowView('work', now('work', { kind: 'plan', accountId: 'acc_codex', modelId: 'codex', name: 'GPT-6.1 Sol' }), MODELS, ACCOUNTS, [], undefined, true);
  assert.deepEqual([plan.provider, plan.model, plan.models[0].label, plan.button], ['acc_codex', 'codex', 'GPT-6.1 Sol · each turn', undefined]);
  assert.equal(plan.models[0].hint, 'Best for each turn');
  assert.equal(modelOptions('work', 'acc_codex', undefined, MODELS, ACCOUNTS, [])[0].label, 'Best for each turn', 'a plan not in use: its pick is not known yet');
  const local = useRowView('embeddings', now('embeddings', { kind: 'this-pc', modelId: 'local', name: 'MiniLM-L12 multilingual', thisPc: true }), MODELS, ACCOUNTS, [], undefined, true);
  assert.deepEqual([local.provider, local.model, local.models.map((option) => option.label)], [THIS_PC, 'local', ['MiniLM-L12 multilingual']]);
  const usual = useRowView('embeddings', now('embeddings', { accountId: 'acc_or', modelId: 'openrouter:qwen/qwen3-embedding-8b', name: 'qwen/qwen3-embedding-8b' }), MODELS, ACCOUNTS, [], undefined, true);
  assert.deepEqual([usual.provider, usual.model, usual.models[0].label], ['acc_or', 'openrouter:qwen/qwen3-embedding-8b', 'qwen/qwen3-embedding-8b']);
  const gone = useRowView('decision', now('decision', { accountId: 'acc_or', modelId: 'openrouter:qwen/qwen3-8b', gone: 'openai:gpt-6-luna' }), MODELS, ACCOUNTS, [], undefined, true);
  assert.equal(gone.hint, 'openai:gpt-6-luna is not available now');
  assert.equal(gone.button?.kind, 'ai');
  const note = 'No decision model yet – GPT-6.1 Sol, a chat model, answers these calls';
  const standIn = useRowView('decision', now('decision', { accountId: 'acc_codex', modelId: 'codex:gpt-6.1-sol', name: 'GPT-6.1 Sol', state: 'setup', note, action: { kind: 'ai', label: 'Set up with AI', target: 'decision' } }), MODELS, ACCOUNTS, [], undefined, true);
  assert.deepEqual([standIn.model, standIn.models[0].label, standIn.state, standIn.hint, standIn.button], ['codex:gpt-6.1-sol', 'GPT-6.1 Sol', 'setup', note, { kind: 'ai', label: 'Set up with AI', disabled: false }], 'a chat model standing in for a decision model is named as one');
});

test('the ChatGPT plan\'s images and a call on this PC name their models, not a mode', () => {
  const images = useRowView('image', now('image', { kind: 'plan', accountId: 'acc_codex', modelId: 'codex', name: 'ChatGPT plan images' }), MODELS, ACCOUNTS, [], undefined, true);
  assert.deepEqual([images.provider, images.model, images.models[0]], ['acc_codex', 'codex', { value: 'codex', label: 'GPT Image', hint: 'On the ChatGPT plan' }]);
  const call = useRowView('voice', now('voice', { kind: 'this-pc', name: 'Canary 180M + Supertonic', thisPc: true }), MODELS, ACCOUNTS, OFFERS, undefined, true);
  assert.deepEqual([call.provider, call.models.map((option) => option.label), call.modelFixed], [THIS_PC, ['Canary 180M + Supertonic'], true]);
  const unnamed = useRowView('voice', now('voice', { kind: 'this-pc', thisPc: true }), MODELS, ACCOUNTS, OFFERS, undefined, true);
  assert.deepEqual(unnamed.models.map((option) => option.label), ['This PC'], 'models.uses names none: the place, no mode phrase');
  const labels = [images, call, unnamed].flatMap((view) => view.models.map((option) => option.label));
  assert.ok(!labels.some((label) => /^auto|automatic|plan images|PC's speech/i.test(label)), labels.join(' | '));
});

test('This PC lists its local models with their download size; a local download sits in the action slot', () => {
  assert.deepEqual(modelOptions('stt', THIS_PC, now('stt', { kind: 'this-pc' }), MODELS, ACCOUNTS, OFFERS).map((option) => [option.value, option.hint]), [['canary', 'On this PC'], ['fastconformer', '100 MB download']]);
  const action = { kind: 'download-model', label: 'Download', target: 'fastconformer' } as const;
  const idle = useRowView('stt', now('stt', { kind: 'none', state: 'setup', action, thisPc: true }), MODELS, ACCOUNTS, OFFERS, undefined, true);
  assert.deepEqual(idle.button, { kind: 'download', label: 'Download', disabled: false, target: 'fastconformer' });
  const running = useRowView('stt', now('stt', { kind: 'none', state: 'setup', action, thisPc: true }), MODELS, ACCOUNTS, OFFERS, { id: 'fastconformer', state: 'downloading', done: 50, total: 200 }, true);
  assert.deepEqual([running.button?.label, running.button?.disabled, running.hint], ['25 %', true, 'Downloading 25 % · fastconformer']);
});

test('a pick writes the keys that make it real', () => {
  assert.deepEqual(writeModel('decision', 'acc_or', 'openrouter:qwen/qwen3-8b', MODELS, []), { routing: { decision: 'openrouter:qwen/qwen3-8b' } });
  assert.deepEqual(writeModel('stt', 'acc_or', 'openrouter:openai/whisper-1', MODELS, []), { routing: { stt: 'openrouter:openai/whisper-1' }, voice: { localStt: '' } }, 'this PC\'s model would come first');
  assert.deepEqual(writeModel('voice', 'acc_or', 'openrouter:gpt-realtime', [model('openrouter:gpt-realtime', 'Realtime', ['acc_or'])], []), { routing: { voice: 'acc_or:gpt-realtime' }, voice: { realtime: 'auto' } });
  assert.deepEqual(writeModel('stt', THIS_PC, 'canary', MODELS, OFFERS), { routing: { stt: 'auto' }, voice: { localStt: 'canary' } });
  assert.deepEqual(writeModel('stt', THIS_PC, 'fastconformer', MODELS, OFFERS), { routing: { stt: 'auto' }, download: 'fastconformer' }, 'it has to come first');
  assert.deepEqual(writeModel('embeddings', THIS_PC, 'local', MODELS, []), { routing: { embeddings: 'local' } });
  assert.deepEqual(writeModel('voice', THIS_PC, '', MODELS, []), { voice: { realtime: 'off' } });
});

test('a provider pick takes its first model; Off and This PC write their keys', () => {
  assert.deepEqual(writeProvider('work', 'acc_codex', MODELS, ACCOUNTS, [], undefined), { routing: { work: 'codex' } }, 'a plan: its best for each turn');
  assert.deepEqual(writeProvider('work', 'acc_or', MODELS, ACCOUNTS, [], undefined), { routing: { work: 'openrouter:qwen/qwen3-8b' } });
  assert.deepEqual(writeProvider('image', 'acc_codex', MODELS, ACCOUNTS, [], undefined), { routing: { image: 'codex' } });
  assert.deepEqual(writeProvider('stt', 'off', MODELS, ACCOUNTS, OFFERS, undefined), { routing: { stt: 'off' }, voice: { localStt: '' } });
  assert.deepEqual(writeProvider('image', 'off', MODELS, ACCOUNTS, [], undefined), { routing: { image: 'off' } });
  assert.deepEqual(writeProvider('stt', THIS_PC, MODELS, ACCOUNTS, OFFERS, { localStt: '', localTts: '' }), { routing: { stt: 'auto' }, voice: { localStt: 'canary' } }, 'the one on this PC');
  assert.deepEqual(writeProvider('tts', THIS_PC, MODELS, ACCOUNTS, OFFERS, { localStt: '', localTts: '' }), { routing: { tts: 'local' }, download: 'supertonic' });
  assert.equal(writeProvider('work', '', MODELS, ACCOUNTS, [], undefined), undefined, 'None writes nothing');
});

test('a connection of the file: listed for any use it can speak, its model cell offers Other…, a typed name is written with its id', () => {
  const accounts = [...ACCOUNTS, account('mine', 'compatible', { label: 'Mine' }), account('claude-key', 'anthropic'), account('typesafe', 'decision-api')];
  const entries = { mine: {}, 'claude-key': {}, typesafe: {} };
  const listed = (use: ModelUse) => providerOptions(use, undefined, MODELS, accounts, entries).map((option) => option.value);
  assert.ok(listed('image').includes('mine'), 'a name can serve what the server does not list');
  assert.ok(!listed('video').includes('mine'), 'the OpenAI protocol has no video endpoint: a name could not run');
  assert.ok(!listed('image').includes('acc_or'), 'an account outside the file: what it lists');
  assert.ok(listed('work').includes('claude-key') && !listed('image').includes('claude-key'), 'Anthropic\'s protocol has no media');
  assert.ok(listed('decision').includes('typesafe') && !listed('work').includes('typesafe'), 'a decision connection serves decisions, and only that');
  assert.equal(modelOptions('work', 'mine', undefined, MODELS, accounts, [], entries).at(-1)?.value, OTHER);
  assert.ok(!modelOptions('work', 'acc_codex', undefined, MODELS, accounts, [], entries).some((option) => option.value === OTHER), 'a plan lists its own');
  assert.equal(writeProvider('image', 'mine', MODELS, accounts, [], undefined), undefined, 'no listed model: the row asks for a name');
  assert.equal(namedValue('mine', ' qwen3:8b ', accounts, entries), 'mine:qwen3:8b');
  assert.equal(namedValue('acc_or', 'x', accounts, entries), 'openrouter:x');
  assert.deepEqual(writeModel('image', 'mine', 'mine:art-x', MODELS, []), { routing: { image: 'mine:art-x' } });
  assert.deepEqual(writeModel('voice', 'mine', 'mine:rt-1', MODELS, []), { routing: { voice: 'mine:rt-1' }, voice: { realtime: 'auto' } });
});

test('Voice: a Google key is offered with Gemini Live while its server lists none; a listed Live model comes instead', () => {
  const accounts = [...ACCOUNTS, account('gem', 'google', { label: 'Gemini' })];
  const listed = providerOptions('voice', undefined, MODELS, accounts).map((option) => option.value);
  assert.ok(listed.includes('gem'));
  assert.ok(!listed.includes('acc_or'), 'nothing tells that OpenRouter talks in real time');
  assert.deepEqual(modelOptions('voice', 'gem', undefined, MODELS, accounts, []).map((option) => option.label), ['gemini-3.8-live']);
  assert.deepEqual(writeProvider('voice', 'gem', MODELS, accounts, [], undefined), { routing: { voice: 'gem:gemini-3.8-live' }, voice: { realtime: 'auto' } });
  const live = [...MODELS, model('google:gemini-3.9-live', 'Gemini 3.9 Live', ['gem'], { provider: 'google' })];
  assert.deepEqual(modelOptions('voice', 'gem', undefined, live, accounts, []).map((option) => option.value), ['google:gemini-3.9-live']);
});
