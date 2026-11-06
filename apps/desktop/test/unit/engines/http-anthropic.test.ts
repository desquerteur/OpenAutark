// AnthropicEngine against a local server speaking Messages SSE (message_start, content_block_start/
// delta/stop with thinking + signature, text and tool_use input_json_delta, message_delta usage,
// ping, error events): request shape, the parallel tool loop, pause_turn, refusals, cut-offs,
// limits, per-model thinking/effort profiles and the paginated model list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEngine, anthropicProfile } from '../../../src/runtime/engines/http/anthropic.ts';
import { account, turnInput } from './fakes.ts';
import { sendJson, sendSse, serve, type Route } from './http-fixture.ts';

const KEY = 'sk-ant-api03-0123456789';

const start = (input: number, cacheRead = 0, cacheWrite = 0) => ({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } } });
const blockStart = (index: number, block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block: block });
const delta = (index: number, d: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: d });
const stop = (index: number) => ({ type: 'content_block_stop', index });
const end = (reason: string, output: number) => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }, { type: 'message_stop' }];
const textMessage = (text: string, reason = 'end_turn', input = 1, output = 1) => [start(input), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text }), stop(0), ...end(reason, output)];

async function setup(route: Route) {
  const server = await serve(route);
  const engine = new AnthropicEngine({ apiKey: async () => KEY, readFile: async () => new Uint8Array([7]) });
  return { server, engine, acc: account({ provider: 'anthropic', auth: 'api', baseUrl: `${server.url}/v1` }) };
}

test('anthropic: request shape, thinking + signature kept unchanged, parallel tool_use answered in ONE user message, usage incl. cache', async (t) => {
  const { server, engine, acc } = await setup((_req, res, index) => {
    if (index === 0) sendSse(res, [
      start(10, 85, 5),
      { type: 'ping' },
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'Weighing options' }),
      delta(0, { type: 'signature_delta', signature: 'SIG==' }),
      stop(0),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'On ' }),
      delta(1, { type: 'text_delta', text: 'it.' }),
      stop(1),
      blockStart(2, { type: 'tool_use', id: 'toolu_1', name: 'tasks__create', input: {} }),
      delta(2, { type: 'input_json_delta', partial_json: '' }),
      delta(2, { type: 'input_json_delta', partial_json: '{"title": "X' }),
      delta(2, { type: 'input_json_delta', partial_json: '"}' }),
      stop(2),
      blockStart(3, { type: 'tool_use', id: 'toolu_2', name: 'tasks__create', input: {} }),
      delta(3, { type: 'input_json_delta', partial_json: '{"title":"Y"}' }),
      stop(3),
      ...end('tool_use', 40),
    ]);
    else sendSse(res, textMessage('Done.', 'end_turn', 120, 3));
  });
  t.after(() => server.close());
  const { input, events, toolCalls } = turnInput({ account: acc, model: 'claude-opus-5-5', effort: 'high' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'On it.\n\nDone.');
  assert.deepEqual(result.usage, { inputTokens: 220, outputTokens: 43, cacheReadTokens: 85, cacheWriteTokens: 5 }, 'inputTokens stays the total; the cache reads and writes beside it');
  assert.deepEqual(toolCalls.map((c: any) => [c.name, c.args, c.callId]), [['tasks.create', { title: 'X' }, 'toolu_1'], ['tasks.create', { title: 'Y' }, 'toolu_2']]);
  const [first, second] = server.hits('/v1/messages');
  assert.equal(first.headers['x-api-key'], KEY);
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.body.max_tokens, 64_000);
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(first.body.system, [{ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'VOLATILE' }]);
  assert.deepEqual(first.body.tools, [{ name: 'tasks__create', description: 'Create a task', input_schema: input.tools[0].inputSchema }]);
  assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(first.body.output_config, { effort: 'high' });
  assert.equal(first.body.tool_choice, undefined);
  assert.deepEqual(first.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.equal(second.body.messages.length, 3);
  assert.deepEqual(second.body.messages[1], { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Weighing options', signature: 'SIG==' },
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 'toolu_1', name: 'tasks__create', input: { title: 'X' } },
    { type: 'tool_use', id: 'toolu_2', name: 'tasks__create', input: { title: 'Y' } },
  ] });
  assert.deepEqual(second.body.messages[2], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: [{ type: 'text', text: 'created {"title":"X"}' }] },
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: false, content: [{ type: 'text', text: 'created {"title":"Y"}' }] },
  ] });
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning').map((e: any) => e.delta), ['Weighing options']);
  // D5: the thinking block has an id per round and index, and its content_block_stop ends it.
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning' || e.type === 'reasoning_end').map((e: any) => [e.type, e.id]), [['reasoning', 'r0:0'], ['reasoning_end', 'r0:0']]);
  assert.deepEqual(events.filter((e: any) => e.type === 'text').map((e: any) => e.delta), ['On ', 'it.', 'Done.']);
});

test('anthropic: pause_turn re-sends the conversation without new user content; tool errors and images', async (t) => {
  const { server, engine, acc } = await setup((_req, res, index) => {
    if (index === 0) sendSse(res, textMessage('Searching', 'pause_turn'));
    else if (index === 1) sendSse(res, [start(1), blockStart(0, { type: 'tool_use', id: 'toolu_9', name: 'tasks__create', input: {} }), stop(0), ...end('tool_use', 2)]);
    else sendSse(res, textMessage('Found.'));
  });
  t.after(() => server.close());
  const callTool = async () => ({ content: [{ type: 'text' as const, text: 'denied' }, { type: 'image' as const, mime: 'image/png', dataBase64: 'BBBB' }], isError: true });
  const { input } = turnInput({ account: acc, model: 'claude-sonnet-5-5', callTool, input: [{ type: 'image', path: '/s.png', mime: 'image/png' }] });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Searching\n\nFound.');
  const [first, second, third] = server.hits('/v1/messages');
  assert.deepEqual(first.body.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Bw==' } }]);
  assert.deepEqual(second.body.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.deepEqual(third.body.messages[3], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: [
    { type: 'text', text: 'denied\n[image image/png]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
  ] }] });
});

test('anthropic: refusal, cut-off (usage kept), overloaded and rate-limit error events, HTTP 429/529', async (t) => {
  let mode = 'refusal';
  const { server, engine, acc } = await setup((_req, res) => {
    if (mode === 'refusal') return sendSse(res, textMessage('', 'refusal', 50, 2));
    if (mode === 'max_tokens') return sendSse(res, textMessage('Long ans', 'max_tokens', 30, 64_000));
    if (mode === 'overloaded') return sendSse(res, [start(1), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    if (mode === 'ratelimit') return sendSse(res, [start(1), { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }]);
    if (mode === '429') return sendJson(res, 429, { type: 'error', error: { type: 'rate_limit_error' } }, { 'retry-after': '30' });
    sendJson(res, 529, { type: 'error', error: { type: 'overloaded_error' } });
  });
  t.after(() => server.close());
  const run = () => engine.run(turnInput({ account: acc, model: 'claude-opus-5-5' }).input);
  const refused = await run();
  assert.deepEqual([refused.stop, refused.error?.code], ['error', 'forbidden']);
  assert.deepEqual(refused.usage, { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  mode = 'max_tokens';
  const cut = await run();
  assert.equal(cut.error?.message, 'The model response was cut off.');
  assert.deepEqual(cut.usage, { inputTokens: 30, outputTokens: 64_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  mode = 'overloaded';
  assert.equal((await run()).error?.code, 'unavailable');
  mode = 'ratelimit';
  assert.equal((await run()).stop, 'limit');
  mode = '429';
  const limited = await run();
  assert.deepEqual([limited.stop, limited.error?.retryAfterMs], ['limit', 30_000]);
  mode = '529';
  const overloaded = await run();
  assert.deepEqual([overloaded.stop, overloaded.error?.code], ['error', 'unavailable']);
});

test('anthropic: per-model profiles – no adaptive thinking before 4.6, no xhigh on 4.6, effort none → low', async (t) => {
  const { server, engine, acc } = await setup((_req, res) => sendSse(res, textMessage('{"ok":true}')));
  t.after(() => server.close());
  const body = async (model: string, effort: string, extra: Record<string, unknown> = {}) => {
    await engine.run(turnInput({ account: acc, model, effort, ...extra }).input);
    return server.requests[server.requests.length - 1].body;
  };
  const legacy = await body('claude-opus-4-5-20251101', 'high');
  assert.equal(legacy.thinking, undefined); // regression: adaptive thinking was sent to Opus 4.5
  assert.equal(legacy.output_config, undefined);
  const sonnet46 = await body('claude-sonnet-4-6', 'xhigh');
  assert.deepEqual([sonnet46.thinking?.type, sonnet46.output_config?.effort], ['adaptive', 'high']);
  assert.equal((await body('claude-opus-4-8', 'xhigh')).output_config.effort, 'xhigh');
  assert.equal((await body('claude-opus-5-5', 'none')).output_config.effort, 'low');
  const haiku45 = await body('claude-haiku-4-5', 'medium');
  assert.equal(haiku45.thinking, undefined);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const structured = await body('claude-haiku-4-5', 'none', { outputSchema: schema });
  assert.deepEqual(structured.output_config, { format: { type: 'json_schema', schema } });
  assert.deepEqual(anthropicProfile('claude-fable-5-1').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(anthropicProfile('claude-opus-4-6').efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(anthropicProfile('claude-3-5-haiku').efforts, ['none']);
});

test('anthropic: listModels asks for one big page (default page is 20) and uses display names', async (t) => {
  const { server, engine, acc } = await setup((req, res) => sendJson(res, 200, {
    data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' }, { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model' }],
    has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5',
  }));
  t.after(() => server.close());
  const models = await engine.listModels(acc);
  assert.equal(server.requests[0].path, '/v1/models?limit=1000');
  assert.equal(server.requests[0].headers['x-api-key'], KEY);
  assert.deepEqual(models, [
    { model: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: ['none'] },
    { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
});
