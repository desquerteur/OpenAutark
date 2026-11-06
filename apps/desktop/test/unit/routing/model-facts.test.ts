// B-078 (D16): the models line of every agent's stable prompt (routing/model-facts.ts factsLine): at most 8 connected work
// models, the smartest first, each with its list price, smarts and how a turn is paid – the same text for the same
// connections (the prompt cache holds), no specialists, about 150 tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACTS_MODELS, factsLine, priceText } from '../../../src/runtime/routing/model-facts.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';

function model(id: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  return { id, provider: 'claude', model: id, name: id, engine: 'claude', efforts: [], caps: {}, tier: 'frontier', strengths: { chat: 0.3 }, available: true, accounts: ['acc_plan'], ...patch };
}
const ACCOUNTS: Account[] = [
  { id: 'acc_plan', provider: 'claude', label: 'Claude Code', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0 },
  { id: 'acc_key', provider: 'openrouter', label: 'OpenRouter', auth: 'api_key', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0 },
  { id: 'acc_local', provider: 'ollama', label: 'Ollama', auth: 'local', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0 },
];

test('price text: "$4/$20", "$0.1/$0.5"; none without a price', () => {
  assert.equal(priceText({ price: { inputPerM: 4, outputPerM: 20, source: 'priors' } }), '$4/$20');
  assert.equal(priceText({ price: { inputPerM: 0.1, outputPerM: 0.5, source: 'priors' } }), '$0.1/$0.5');
  assert.equal(priceText({}), undefined);
});

test('the facts line: smartest first, price · smarts · plan/API key/local, specialists and unavailable models left out', () => {
  const models = [
    model('Claude Fable 5.1', { smarts: 92, price: { inputPerM: 10, outputPerM: 50, source: 'priors' } }),
    model('Claude Opus 5.5', { smarts: 94, price: { inputPerM: 4, outputPerM: 20, source: 'priors' } }),
    model('Mistral Large', { provider: 'openrouter', engine: 'compatible', accounts: ['acc_key'], price: { inputPerM: 2, outputPerM: 6, source: 'feed' } }),
    model('qwen3.8', { provider: 'ollama', engine: 'compatible', tier: 'local', accounts: ['acc_local'], smarts: 62 }),
    model('whisper', { functions: ['stt'], strengths: { stt: 0.9, chat: -1 } }),
    model('Gone', { available: false, smarts: 99 }),
  ];
  const line = factsLine(models, ACCOUNTS);
  assert.equal(line, 'Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): Claude Opus 5.5 $4/$20 · 94 · plan; Claude Fable 5.1 $10/$50 · 92 · plan; qwen3.8 · 62 · local; Mistral Large $2/$6 · API key. A plan costs me nothing per turn while its quota lasts, an API key pays every token, a local model costs nothing.');
  assert.equal(factsLine([...models].reverse(), ACCOUNTS), line, 'the order of the catalog does not change it (cache)');
  assert.equal(factsLine([], ACCOUNTS), '');
});

test(`at most ${FACTS_MODELS} models (the rest counted), duplicates of one model once, about 150 tokens`, () => {
  const many = Array.from({ length: 12 }, (_, i) => model(`Model ${String(i).padStart(2, '0')}`, { smarts: 80 + i, price: { inputPerM: 1, outputPerM: 5, source: 'priors' } }));
  const twice = [...many, model('Model 11', { id: 'other:Model 11', smarts: 91, price: { inputPerM: 1, outputPerM: 5, source: 'priors' } })];
  const line = factsLine(twice, ACCOUNTS);
  assert.equal((line.match(/ · plan/g) ?? []).length, FACTS_MODELS);
  assert.match(line, /\(\+4 more in models\.list\)/);
  assert.ok(line.length < 700, `${line.length} characters`);
});
