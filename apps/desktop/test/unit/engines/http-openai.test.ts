// OpenAiEngine against a local server speaking the Responses API SSE: text and reasoning-summary
// deltas, function calls, encrypted reasoning carried statelessly between tool rounds, tool
// errors and images, structured output, usage, limits and cut-offs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiEngine } from '../../../src/runtime/engines/http/openai.ts';
import { account, turnInput } from './fakes.ts';
import { sendJson, sendSse, serve, type Route } from './http-fixture.ts';

const KEY = 'sk-proj-abcdefghijklmnop';

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Planning' }], encrypted_content: 'ENC1' };
const message = (id: string, text: string) => ({ type: 'message', id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const call = { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'tasks__create', arguments: '{"title":"X"}' };
const completed = (output: unknown[], input: number, out: number) => ({ type: 'response.completed', response: { id: 'resp', status: 'completed', output, usage: { input_tokens: input, output_tokens: out } } });

async function setup(route: Route) {
  const server = await serve(route);
  const engine = new OpenAiEngine({ apiKey: async () => KEY, readFile: async () => new Uint8Array([9]) });
  return { server, engine, acc: account({ provider: 'openai', auth: 'api', baseUrl: `${server.url}/v1` }) };
}

test('openai: reasoning summary + text deltas, function call round with encrypted reasoning, usage summed', async (t) => {
  const { server, engine, acc } = await setup((_req, res, index) => {
    if (index === 0) sendSse(res, [
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', delta: 'Planning' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_text.delta', delta: 'Creating ' },
      { type: 'response.output_text.delta', delta: 'it.' },
      { type: 'response.output_item.done', output_index: 1, item: message('msg_1', 'Creating it.') },
      { type: 'response.function_call_arguments.delta', delta: '{"title"' },
      { type: 'response.output_item.done', output_index: 2, item: call },
      completed([reasoning, message('msg_1', 'Creating it.'), call], 100, 20),
    ]);
    else sendSse(res, [{ type: 'response.output_text.delta', delta: 'Done.' }, completed([message('msg_2', 'Done.')], 150, 5)]);
  });
  t.after(() => server.close());
  const { input, events, toolCalls } = turnInput({ account: acc, model: 'gpt-6.1', effort: 'max' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Creating it.\n\nDone.');
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 25 });
  assert.deepEqual(toolCalls, [{ name: 'tasks.create', args: { title: 'X' }, callId: 'call_1' }]);
  const [first, second] = server.hits('/v1/responses');
  assert.equal(first.headers.authorization, `Bearer ${KEY}`);
  assert.equal(first.body.instructions, 'STABLE\n\nVOLATILE');
  assert.equal(first.body.store, false);
  assert.equal(first.body.stream, true);
  assert.equal(first.body.previous_response_id, undefined);
  assert.deepEqual(first.body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(first.body.reasoning, { effort: 'xhigh', summary: 'auto' });
  assert.deepEqual(first.body.tools, [{ type: 'function', name: 'tasks__create', description: 'Create a task', parameters: input.tools[0].inputSchema, strict: false }]);
  assert.deepEqual(first.body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  assert.deepEqual(second.body.input.slice(1), [
    reasoning, // reasoning keeps its id and encrypted content
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Creating it.', annotations: [] }] },
    { type: 'function_call', call_id: 'call_1', name: 'tasks__create', arguments: '{"title":"X"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'created {"title":"X"}' },
  ]);
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning').map((e: any) => e.delta), ['Planning']);
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning_end'), [{ type: 'reasoning_end', id: 'rs_1' }], 'D5: the reasoning item\'s end closes its block');
  assert.deepEqual(events.filter((e: any) => e.type === 'text').map((e: any) => e.delta), ['Creating ', 'it.', 'Done.']);
});

test('openai: failing tool and tool images go back as function_call_output + image message; images in input', async (t) => {
  const { server, engine, acc } = await setup((_req, res, index) => {
    const calls = [{ ...call, call_id: 'c_err' }, { ...call, id: 'fc_2', call_id: 'c_img' }];
    if (index === 0) sendSse(res, [completed(calls, 1, 1)]);
    else sendSse(res, [completed([message('m', 'ok')], 1, 1)]);
  });
  t.after(() => server.close());
  const callTool = async (_name: string, _args: unknown, callId: string) => {
    if (callId === 'c_err') throw new Error('disk full');
    return { content: [{ type: 'text' as const, text: 'see image' }, { type: 'image' as const, mime: 'image/png', dataBase64: 'AAAA' }] };
  };
  const { input, events } = turnInput({ account: acc, effort: 'none', callTool, input: [{ type: 'image', path: '/a.png', mime: 'image/png' }] });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  const [first, second] = server.hits('/v1/responses');
  assert.equal(first.body.reasoning, undefined);
  assert.deepEqual(first.body.input[0].content, [{ type: 'input_image', image_url: 'data:image/png;base64,CQ==' }]);
  const tail = second.body.input.slice(-3);
  assert.deepEqual(tail[0], { type: 'function_call_output', call_id: 'c_err', output: 'ERROR: disk full' });
  assert.deepEqual(tail[1], { type: 'function_call_output', call_id: 'c_img', output: 'see image\n[image image/png]' });
  assert.deepEqual(tail[2], { role: 'user', content: [{ type: 'input_text', text: 'Images returned by the tool calls above:' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
  assert.deepEqual(events.filter((e: any) => e.type === 'tool_end').map((e: any) => e.ok), [false, true]);
});

test('openai: structured output is requested as json_schema and parsed from the text', async (t) => {
  const { server, engine, acc } = await setup((_req, res) => sendSse(res, [{ type: 'response.output_text.delta', delta: '{"pick":2}' }, completed([message('m', '{"pick":2}')], 3, 4)]));
  t.after(() => server.close());
  const schema = { type: 'object', properties: { pick: { type: 'number' } } };
  const result = await engine.run(turnInput({ account: acc, outputSchema: schema }).input);
  assert.deepEqual(result.structured, { pick: 2 });
  assert.deepEqual(server.requests[0].body.text, { format: { type: 'json_schema', name: 'result', schema, strict: false } });
});

test('openai: rate-limit failure → limit; incomplete → cut off with its usage counted; missing completion → error', async (t) => {
  let mode = 'failed';
  const { server, engine, acc } = await setup((_req, res) => {
    if (mode === 'failed') sendSse(res, [{ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'slow down' } } }]);
    else if (mode === 'incomplete') sendSse(res, [{ type: 'response.output_text.delta', delta: 'Half' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 7, output_tokens: 900 } } }]);
    else sendSse(res, [{ type: 'response.output_text.delta', delta: 'Half' }]);
  });
  t.after(() => server.close());
  const limited = await engine.run(turnInput({ account: acc }).input);
  assert.equal(limited.stop, 'limit');
  assert.equal(limited.error?.code, 'rate_limited');
  mode = 'incomplete';
  const cut = await engine.run(turnInput({ account: acc }).input);
  assert.equal(cut.stop, 'error');
  assert.equal(cut.error?.message, 'The model response was cut off.');
  assert.deepEqual(cut.usage, { inputTokens: 7, outputTokens: 900 });
  mode = 'truncated';
  const open = await engine.run(turnInput({ account: acc }).input);
  assert.equal(open.stop, 'error');
  assert.equal(open.error?.message, 'The model response did not complete.');
});

test('openai: 401 is unavailable without the key; efforts per model family in listModels', async (t) => {
  let models = false;
  const { server, engine, acc } = await setup((req, res) => {
    if (models) return sendJson(res, 200, { data: [{ id: 'gpt-4.1' }, { id: 'gpt-6.1' }, { id: 'o4-mini' }] });
    sendJson(res, 401, { error: { message: `bad key ${KEY}` } });
  });
  t.after(() => server.close());
  const { input, events } = turnInput({ account: acc });
  const denied = await engine.run(input);
  assert.equal(denied.error?.code, 'unavailable');
  assert.ok(!JSON.stringify({ denied, events }).includes(KEY));
  models = true;
  const list = await engine.listModels(acc);
  assert.deepEqual(list.map((m) => [m.model, m.efforts.length]), [['gpt-4.1', 1], ['gpt-6.1', 5], ['o4-mini', 5]]);
});
