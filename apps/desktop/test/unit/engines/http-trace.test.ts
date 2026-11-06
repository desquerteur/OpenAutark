// The subconscious's trace on the HTTP API engines (engines/http/*.ts injectTrace): real assistant tool-call + tool-result
// messages with valid, pairing ids, after the turn's input and before the model's next turn, in each API's wire format; an empty
// trace leaves the request as it always was; the tool loop goes on behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEngine } from '../../../src/runtime/engines/http/anthropic.ts';
import { OpenAiEngine } from '../../../src/runtime/engines/http/openai.ts';
import { CompatibleEngine } from '../../../src/runtime/engines/http/compatible.ts';
import type { SubconsciousTrace } from '../../../src/shared/model/subconscious.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve, type Route } from './http-fixture.ts';

const KEY = 'sk-test-0123456789abcdef';
const TRACE: SubconsciousTrace = { calls: [
  { tool: 'vector.search', args: { query: 'invoices', in: ['memory/company'] }, output: 'memory/company/billing.md: Invoices go out on the 3rd.' },
  { tool: 'agent.tell', args: {}, output: 'Frau Berger bekommt die Mahnungen.' },
] };
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

const anthropicText = (text: string) => [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const openAiText = (text: string) => [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];
const compatibleText = (text: string) => [{ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }, '[DONE]'];

async function run(kind: 'anthropic' | 'openai' | 'compatible', route: Route, patch: Record<string, unknown>) {
  const server = await serve(route);
  const engine = kind === 'anthropic' ? new AnthropicEngine({ apiKey: async () => KEY }) : kind === 'openai' ? new OpenAiEngine({ apiKey: async () => KEY }) : new CompatibleEngine({ apiKey: async () => KEY });
  const acc = account({ provider: kind, auth: 'api', baseUrl: `${server.url}/v1` });
  const result = await engine.run(turnInput({ account: acc, model: kind === 'anthropic' ? 'claude-opus-5-5' : 'm', ...patch }).input);
  await server.close();
  return { result, body: server.requests[0].body };
}

test('anthropic: one assistant turn of tool_use blocks, all results in ONE user message, ids pairing and valid', async () => {
  const { result, body } = await run('anthropic', (_req, res) => sendSse(res, anthropicText('Ok.')), { trace: TRACE });
  assert.equal(result.stop, 'done');
  const [user, assistant, results, ...rest] = body.messages;
  assert.equal(rest.length, 0, 'the model answers next');
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].text, 'hello');
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content.map((block: any) => [block.type, block.name, block.input]), [['tool_use', 'vector__search', TRACE.calls[0].args], ['tool_use', 'agent__tell', {}]]);
  assert.equal(results.role, 'user');
  assert.deepEqual(results.content.map((block: any) => [block.type, block.tool_use_id, block.content]), [['tool_result', assistant.content[0].id, TRACE.calls[0].output], ['tool_result', assistant.content[1].id, TRACE.calls[1].output]]);
  for (const block of assistant.content) assert.match(block.id, VALID_ID);
  assert.notEqual(assistant.content[0].id, assistant.content[1].id);
});

test('openai: function_call + function_call_output items with one call_id each', async () => {
  const { result, body } = await run('openai', (_req, res) => sendSse(res, openAiText('Ok.')), { trace: TRACE });
  assert.equal(result.stop, 'done');
  const [user, call1, output1, call2, output2, ...rest] = body.input;
  assert.equal(rest.length, 0);
  assert.equal(user.role, 'user');
  assert.deepEqual([call1.type, call1.name, JSON.parse(call1.arguments)], ['function_call', 'vector__search', TRACE.calls[0].args]);
  assert.deepEqual([output1.type, output1.call_id, output1.output], ['function_call_output', call1.call_id, TRACE.calls[0].output]);
  assert.deepEqual([call2.name, output2.call_id, output2.output], ['agent__tell', call2.call_id, TRACE.calls[1].output]);
  assert.match(call1.call_id, VALID_ID);
  assert.notEqual(call1.call_id, call2.call_id);
});

test('compatible: an assistant message with tool_calls and one tool message per call', async () => {
  const { result, body } = await run('compatible', (_req, res) => sendSse(res, compatibleText('Ok.')), { trace: TRACE });
  assert.equal(result.stop, 'done');
  const [system, user, assistant, tool1, tool2, ...rest] = body.messages;
  assert.equal(rest.length, 0);
  assert.deepEqual([system.role, user.role, assistant.role, assistant.content], ['system', 'user', 'assistant', null]);
  assert.deepEqual(assistant.tool_calls.map((call: any) => [call.type, call.function.name, JSON.parse(call.function.arguments)]), [['function', 'vector__search', TRACE.calls[0].args], ['function', 'agent__tell', {}]]);
  assert.deepEqual([tool1.role, tool1.tool_call_id, tool1.content], ['tool', assistant.tool_calls[0].id, TRACE.calls[0].output]);
  assert.deepEqual([tool2.role, tool2.tool_call_id, tool2.content], ['tool', assistant.tool_calls[1].id, TRACE.calls[1].output]);
});

test('an empty or absent trace leaves the request as it always was: nothing at all', async () => {
  for (const patch of [{}, { trace: { calls: [] } }]) {
    const a = await run('anthropic', (_req, res) => sendSse(res, anthropicText('Ok.')), patch);
    assert.equal(a.body.messages.length, 1);
    const o = await run('openai', (_req, res) => sendSse(res, openAiText('Ok.')), patch);
    assert.equal(o.body.input.length, 1);
    const c = await run('compatible', (_req, res) => sendSse(res, compatibleText('Ok.')), patch);
    assert.deepEqual(c.body.messages.map((message: any) => message.role), ['system', 'user']);
  }
});

test('the turn\'s own tool loop goes on behind the trace', async () => {
  const toolTurn = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'tasks__create', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"X"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const server = await serve((_req, res, index) => sendSse(res, index === 0 ? toolTurn : anthropicText('Done.')));
  const engine = new AnthropicEngine({ apiKey: async () => KEY });
  const result = await engine.run(turnInput({ account: account({ provider: 'anthropic', auth: 'api', baseUrl: `${server.url}/v1` }), model: 'claude-opus-5-5', trace: TRACE }).input);
  await server.close();
  assert.equal(result.text, 'Done.');
  assert.deepEqual(server.requests[1].body.messages.map((message: any) => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
});
