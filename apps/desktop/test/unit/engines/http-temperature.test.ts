// B-078 (D14, D16): the agent's temperature (EngineTurnInput.temperature, model.set) on the HTTP API engines – the OpenAI
// Responses API sends it to models without reasoning (0..2) and drops it for the reasoning families; the Anthropic API sends
// it to models without thinking (clamped to its 0..1) and drops it for the adaptive models; without one nothing is sent;
// engines/http/temperature.ts answers model.set's "does it reach" from the same rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEngine, anthropicTemperature } from '../../../src/runtime/engines/http/anthropic.ts';
import { OpenAiEngine, openAiTemperature } from '../../../src/runtime/engines/http/openai.ts';
import { takesTemperature } from '../../../src/runtime/engines/http/temperature.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve } from './http-fixture.ts';

const KEY = 'sk-test-0123456789abcdef';

const anthropicText = [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ok.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const openAiText = [{ type: 'response.output_text.delta', delta: 'Ok.' }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Ok.', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];

async function body(kind: 'anthropic' | 'openai', model: string, temperature: number | undefined, effort?: string) {
  const server = await serve((_req, res) => sendSse(res, kind === 'anthropic' ? anthropicText : openAiText));
  const engine = kind === 'anthropic' ? new AnthropicEngine({ apiKey: async () => KEY }) : new OpenAiEngine({ apiKey: async () => KEY });
  const acc = account({ provider: kind, auth: 'api', baseUrl: `${server.url}/v1` });
  const result = await engine.run(turnInput({ account: acc, model, ...(effort ? { effort } : {}), ...(temperature !== undefined ? { temperature } : {}) }).input);
  await server.close();
  assert.equal(result.stop, 'done');
  return server.requests[0].body;
}

test('openai: a model without reasoning gets the temperature; a reasoning model and a turn without one send none', async () => {
  assert.equal((await body('openai', 'gpt-4.1', 1.3, 'none')).temperature, 1.3);
  assert.equal((await body('openai', 'gpt-6.1-sol', 1.3, 'high')).temperature, undefined, 'the reasoning family refuses the field');
  assert.equal((await body('openai', 'o4-mini', 0.2, 'low')).temperature, undefined);
  assert.equal((await body('openai', 'gpt-4.1', undefined, 'none')).temperature, undefined);
  assert.equal(openAiTemperature('gpt-4o', 5), 2, 'clamped to 0..2');
  assert.equal(openAiTemperature('gpt-4o', Number.NaN), undefined);
  assert.equal(openAiTemperature('codex-mini-latest', 0.5), undefined, 'codex-mini reasons too');
});

test('anthropic: a model without thinking gets the temperature clamped to 0..1; a thinking model sends none', async () => {
  assert.equal((await body('anthropic', 'claude-haiku-4-5', 0.4)).temperature, 0.4);
  assert.equal((await body('anthropic', 'claude-haiku-4-5', 1.6)).temperature, 1, 'the API\'s range ends at 1');
  const thinking = await body('anthropic', 'claude-opus-5-5', 0.4, 'medium');
  assert.equal(thinking.temperature, undefined, 'adaptive thinking refuses a changed temperature');
  assert.equal(thinking.thinking.type, 'adaptive');
  assert.equal((await body('anthropic', 'claude-sonnet-4-6', 0.4)).temperature, undefined);
  assert.equal((await body('anthropic', 'claude-haiku-4-5', undefined)).temperature, undefined);
  assert.equal(anthropicTemperature('claude-opus-4-5', -1), 0);
});

test('takesTemperature: compatible always, the APIs per model, the CLIs never', () => {
  assert.equal(takesTemperature('compatible', 'llama3.3'), true);
  assert.equal(takesTemperature('openai', 'gpt-4.1'), true);
  assert.equal(takesTemperature('openai', 'gpt-5.2'), false);
  assert.equal(takesTemperature('anthropic', 'claude-haiku-4-5'), true);
  assert.equal(takesTemperature('anthropic', 'claude-opus-5-5'), false);
  for (const engine of ['codex', 'claude', 'acp']) assert.equal(takesTemperature(engine, 'any'), false);
});
