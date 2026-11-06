// The one connection form (ui/settings/endpoint.ts over shared/model/providers-connect.ts, 01.11.2026): provider →
// key or URL → Test. A named service adds its own provider (DeepInfra, Mistral, Kimi and Qwen as OpenAI-compatible
// addresses) with its key and a fixed URL; "Other" takes any OpenAI- or Anthropic-compatible URL; a local server its
// URL, a key optional; media-only keys have no Test; what accounts.add gets.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionForm, modelsText, servicesOf, startUrl } from '../../../src/ui/settings/endpoint.ts';
import { API_SERVICES, serviceAt, serviceOfAccount } from '../../../src/shared/model/providers-connect.ts';

const form = (service: string, key = '', url = '') => connectionForm({ service, key, url });

test('the API key form lists the providers people know, then Other; no decision vendors', () => {
  const names = servicesOf('api').map((service) => service.name);
  for (const name of ['OpenAI', 'Anthropic', 'Google Gemini', 'OpenRouter', 'DeepInfra', 'Groq', 'Mistral', 'xAI']) assert.ok(names.includes(name), name);
  assert.equal(names.at(-1), 'Other');
  assert.equal(names.filter((name) => name.startsWith('Other')).length, 1, 'one Other with a Protocol select');
  assert.ok(!names.some((name) => /decision/i.test(name)), 'no "… decision model" entries');
  assert.deepEqual(servicesOf('local').map((service) => service.name), ['Ollama', 'LM Studio', 'llama.cpp', 'vLLM']);
});

test('a named service: its key is needed, its URL is fixed, it adds its own provider', () => {
  assert.equal(form('openai').valid, false, 'no key yet');
  const openai = form('openai', ' sk-test ');
  assert.equal(openai.urlEditable, false);
  assert.equal(openai.url, 'https://api.openai.com/v1');
  assert.deepEqual(openai.target, { provider: 'openai', apiKey: 'sk-test', label: 'OpenAI' });
  assert.equal(openai.testable, true);
  assert.deepEqual(form('deepinfra', 'k').target, { provider: 'compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'k', label: 'DeepInfra' });
  assert.deepEqual(form('mistral', 'k').target, { provider: 'compatible', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k', label: 'Mistral' });
  assert.equal(form('groq', 'k').target?.provider, 'groq');
  assert.equal(form('google', 'k').target?.provider, 'google');
  assert.equal(form('elevenlabs', 'k').valid, true);
  assert.equal(form('elevenlabs', 'k').testable, false, 'a media-only key has no model list');
  assert.equal(form('nope', 'k').valid, false);
});

test('"Other": any URL with its protocol – a chat or decision server of one\'s own may take no key, the others need it', () => {
  const other = form('other', '', ' https://llm.example.test/v1/ ');
  assert.equal(other.urlEditable, true);
  assert.equal(other.needsKey, false);
  assert.equal(other.protocolEditable, true);
  assert.equal(other.protocol, 'openai-chat');
  assert.deepEqual(other.target, { provider: 'compatible', baseUrl: 'https://llm.example.test/v1', label: 'llm.example.test' });
  assert.equal(form('other', '', 'llm.example.test').valid, false, 'no http(s) URL');
  assert.equal(form('other', '', 'file:///etc/passwd').valid, false);
  const on = (protocol: 'anthropic' | 'openai-responses' | 'decision', key = '') => connectionForm({ service: 'other', key, url: 'https://llm.example.test', protocol });
  assert.equal(on('anthropic').valid, false, 'needs its key');
  assert.deepEqual(on('anthropic', 'k').target, { provider: 'anthropic', baseUrl: 'https://llm.example.test', apiKey: 'k', label: 'llm.example.test' });
  assert.equal(on('openai-responses', 'k').target?.provider, 'openai');
  assert.equal(on('decision').target?.provider, 'decision-api');
  assert.equal(on('decision').testable, false, 'it lists no models; accounts.try asks it one question');
  assert.equal(form('deepinfra', 'k').protocol, 'openai-chat');
  assert.equal(form('deepinfra', 'k').protocolEditable, false);
  assert.equal(form('anthropic', 'k').protocol, 'anthropic');
  assert.equal(form('fal', 'k').protocol, 'own');
});

test('a local server: its URL (the default address first), a key optional', () => {
  assert.equal(startUrl('ollama', ''), 'http://127.0.0.1:11434/v1');
  assert.equal(startUrl('lmstudio', 'http://x'), 'http://127.0.0.1:1234/v1');
  assert.equal(startUrl('other', 'https://typed.test/v1'), 'https://typed.test/v1', 'Other keeps what was typed');
  assert.equal(startUrl('openai', 'https://typed.test/v1'), '', 'a named service shows its own URL');
  const ollama = form('ollama', '', 'http://127.0.0.1:11434/v1');
  assert.equal(ollama.needsKey, false);
  assert.deepEqual(ollama.target, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', label: 'Ollama' });
  assert.equal(form('vllm', 'secret', 'http://127.0.0.1:8000/v1').target?.apiKey, 'secret');
});

test('which service an address or an account belongs to; the Test line', () => {
  assert.equal(serviceAt('https://API.OPENAI.COM/v1')?.id, 'openai');
  assert.equal(serviceAt('https://api.openai.com.evil.test/v1'), undefined, 'exact host names only');
  assert.equal(serviceOfAccount({ provider: 'compatible', baseUrl: 'https://api.deepinfra.com/v1/openai' })?.name, 'DeepInfra');
  assert.equal(serviceOfAccount({ provider: 'openrouter' })?.name, 'OpenRouter');
  assert.equal(serviceOfAccount({ provider: 'compatible', baseUrl: 'https://llm.example.test/v1' }), undefined);
  assert.equal(new Set(API_SERVICES.map((service) => service.id)).size, API_SERVICES.length);
  assert.equal(modelsText(['a', 'b', 'c', 'd']), '4 models: a, b, c, …');
  assert.equal(modelsText(['a']), '1 model: a');
  assert.equal(modelsText([]), 'The server is reachable, but lists no models.');
});
