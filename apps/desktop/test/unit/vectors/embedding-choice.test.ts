// Which model the use "embeddings" resolves to, the HTTP client and the tokenizer's splitting.
// Owns: these assertions only. Never: real servers or the real model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingChoice } from '../../../src/runtime/models/embeddings.ts';
import { embeddingsUrl, HttpEmbedder } from '../../../src/runtime/vectors/embedders.ts';
import { UnigramTokenizer } from '../../../src/runtime/vectors/tokenizer.ts';

type Services = Parameters<typeof embeddingChoice>[0];

const account = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({ id, provider, enabled: true, auth: 'api_key', state: 'ok', ...extra });
const model = (provider: string, name: string, accounts: string[]) => ({ provider, model: name, id: `${provider}:${name}`, name, available: true, accounts, functions: [], strengths: {} });

function services(value: string, accounts: unknown[], models: unknown[] = []): Services {
  return {
    settings: { get: () => ({ routing: { embeddings: value } }) },
    accounts: { list: () => accounts },
    catalog: { list: () => models },
  } as unknown as Services;
}

const ollama = account('a_ollama', 'ollama', { auth: 'local', baseUrl: 'http://127.0.0.1:11434/v1' });
const openai = account('a_openai', 'openai', { baseUrl: 'https://api.openai.com/v1' });
const codex = account('a_codex', 'codex', { auth: 'cli' });

test('auto: this PC first, then a local server, then an API key, then nothing', () => {
  const all = services('auto', [codex, openai, ollama], [model('ollama', 'bge-m3:latest', ['a_ollama']), model('ollama', 'llama3', ['a_ollama'])]);
  assert.deepEqual(embeddingChoice(all, true), { kind: 'local' });
  const server = embeddingChoice(all, false);
  assert.equal(server?.kind === 'http' && server.model, 'bge-m3:latest');
  assert.equal(server?.kind === 'http' && server.local, true);
  const key = embeddingChoice(services('auto', [codex, openai]), false);
  assert.equal(key?.kind === 'http' && key.model, 'text-embedding-3-small');
  assert.equal(key?.kind === 'http' && key.local, false);
  assert.equal(embeddingChoice(services('auto', [codex]), false), undefined, 'a plan alone does not embed');
});

test('off is off; a named model is that model or nothing, never another', () => {
  assert.equal(embeddingChoice(services('off', [ollama]), true), undefined);
  const named = embeddingChoice(services('openai:text-embedding-3-large', [ollama, openai]), true);
  assert.equal(named?.kind === 'http' && named.model, 'text-embedding-3-large');
  assert.equal(embeddingChoice(services('openai:text-embedding-3-large', [ollama]), true), undefined);
  assert.deepEqual(embeddingChoice(services('local', []), true), { kind: 'local' });
  assert.equal(embeddingChoice(services('local', []), false), undefined);
});

test('the HTTP client: address, no redirects, order by index, unit vectors, shorter vectors where the model allows', async () => {
  assert.equal(embeddingsUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(embeddingsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/embeddings');
  assert.equal(embeddingsUrl('https://x.dev/v1beta/openai'), 'https://x.dev/v1beta/openai/embeddings');
  let sent: { url: string; init: RequestInit } | undefined;
  const client = new HttpEmbedder({
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', remote: true, sendDimensions: true,
    apiKey: async () => 'key',
    fetch: async (url, init) => {
      sent = { url, init };
      return { ok: true, status: 200, json: async () => ({ data: [{ index: 1, embedding: [0, 2, ...Array(600).fill(0)] }, { index: 0, embedding: [3, 0] }] }) };
    },
  });
  assert.equal(client.id, 'openai:text-embedding-3-small:d512');
  const [first, second] = await client.embed(['a', 'b'], 'document');
  assert.deepEqual([...first], [1, 0]);
  assert.equal(second.length, 512);
  assert.equal(second[1], 1);
  assert.equal(sent?.init.redirect, 'error');
  assert.equal((sent?.init.headers as Record<string, string>).authorization, 'Bearer key');
  assert.equal(JSON.parse(String(sent?.init.body)).dimensions, 512);
  const down = new HttpEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'bge-m3', remote: false, sendDimensions: false, apiKey: async () => undefined, fetch: async () => { throw new Error('refused'); } });
  await assert.rejects(down.embed(['a'], 'query'), /could not be reached/);
});

test('the tokenizer takes the best-scoring pieces, marks word starts and keeps the length limit', () => {
  const vocab: Array<[string, number]> = [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁Rech', -5], ['nung', -5], ['▁Rechnung', -6], ['▁an', -4], ['▁', -9], ['a', -9]];
  const tokenizer = new UnigramTokenizer({ model: { type: 'Unigram', unk_id: 3, vocab } });
  assert.deepEqual(tokenizer.encode('Rechnung  an'), [0, 6, 7, 2]);
  assert.deepEqual(tokenizer.encode('Rechnung\nan', 3), [0, 6, 2]);
  assert.deepEqual(tokenizer.encode('   '), [0, 2]);
  assert.deepEqual(tokenizer.encode('a€'), [0, 8, 9, 3, 2]);
  assert.throws(() => new UnigramTokenizer({ model: { type: 'BPE', vocab: [] } }));
});
