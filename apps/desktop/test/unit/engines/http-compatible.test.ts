// CompatibleEngine against a local server speaking OpenAI chat-completions SSE (OpenAI, Ollama,
// LM Studio flavours): streamed text, tool_call delta assembly, the multi-step tool loop, usage,
// limits, auth errors without key leaks, abort, lost connections, timeouts and model listing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { CompatibleEngine } from '../../../src/runtime/engines/http/compatible.ts';
import { HttpEngineError } from '../../../src/runtime/engines/http/common.ts';
import { account, turnInput } from './fakes.ts';
import { sendJson, sendSse, serve, sseEvent, sseHead, type Recorded } from './http-fixture.ts';

const KEY = 'sk-test-0123456789abcdef';

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'cc_1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (prompt: number, completion: number) => ({ id: 'cc_1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

async function setup(route: (req: Recorded, res: ServerResponse, index: number) => void, patch: Record<string, unknown> = {}, key: string | null = KEY) {
  const server = await serve(route);
  const engine = new CompatibleEngine({ apiKey: async () => key ?? undefined });
  const acc = account({ provider: 'compatible', auth: 'api', baseUrl: `${server.url}/v1`, ...patch });
  return { server, engine, acc };
}

test('compatible: streams text, assembles split tool_call deltas, runs a multi-step tool loop and sums usage', async (t) => {
  const { server, engine, acc } = await setup((req, res, index) => {
    if (index === 0) {
      sendSse(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Let me ' }),
        chunk({ content: 'check.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'tasks__create', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"title":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"X"}' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"Y"}' } }] }),
        chunk({}, 'tool_calls'),
        usage(50, 12),
        '[DONE]',
      ]);
    } else sendSse(res, [chunk({ content: 'Done.' }, 'stop'), usage(80, 3), '[DONE]']);
  });
  t.after(() => server.close());
  const { input, events, toolCalls } = turnInput({ account: acc, model: 'gpt-x', effort: 'high' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Let me check.\n\nDone.');
  assert.deepEqual(result.usage, { inputTokens: 130, outputTokens: 15 });
  assert.deepEqual(toolCalls, [
    { name: 'tasks.create', args: { title: 'X' }, callId: 'call_a' },
    { name: 'tasks.create', args: { title: 'Y' }, callId: 'call_b' },
  ]);
  const [first, second] = server.hits('/v1/chat/completions');
  assert.equal(first.method, 'POST');
  assert.equal(first.headers.authorization, `Bearer ${KEY}`);
  assert.equal(first.headers.accept, 'text/event-stream');
  assert.equal(first.body.model, 'gpt-x');
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.stream_options, { include_usage: true });
  assert.equal(first.body.reasoning_effort, undefined); // unknown server: no reasoning params
  assert.deepEqual(first.body.messages, [{ role: 'system', content: 'STABLE\n\nVOLATILE' }, { role: 'user', content: 'hello' }]);
  assert.deepEqual(first.body.tools[0], { type: 'function', function: { name: 'tasks__create', description: 'Create a task', parameters: input.tools[0].inputSchema } });
  const history = second.body.messages;
  assert.equal(history.length, 5);
  assert.deepEqual(history[2], { role: 'assistant', content: 'Let me check.', tool_calls: [
    { id: 'call_a', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"X"}' } },
    { id: 'call_b', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"Y"}' } },
  ] });
  assert.deepEqual(history[3], { role: 'tool', tool_call_id: 'call_a', content: 'created {"title":"X"}' });
  assert.deepEqual(history[4], { role: 'tool', tool_call_id: 'call_b', content: 'created {"title":"Y"}' });
  assert.deepEqual(events.filter((e: any) => e.type === 'text').map((e: any) => e.delta), ['Let me ', 'check.', 'Done.']);
  assert.deepEqual(events.filter((e: any) => e.type === 'tool_start').map((e: any) => [e.name, e.callId, e.own]), [['tasks.create', 'call_a', false], ['tasks.create', 'call_b', false]]);
  assert.equal(events.filter((e: any) => e.type === 'tool_end' && e.ok).length, 2);
});

test('compatible: Ollama flavour – no key, whole tool calls without index, reasoning field, reasoning_effort, unknown tool', async (t) => {
  const { server, engine, acc } = await setup((req, res, index) => {
    if (index === 0) {
      sendSse(res, [
        chunk({ role: 'assistant', content: '', reasoning: 'thinking about it' }),
        chunk({ tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"A"}' } },
          { id: 'call_2', type: 'function', function: { name: 'shell__run', arguments: '{}' } },
        ] }, 'tool_calls'),
        '[DONE]',
      ]);
    } else sendSse(res, [chunk({ content: 'ok' }, 'stop'), '[DONE]']);
  }, { provider: 'ollama' }, null);
  t.after(() => server.close());
  const { input, events, toolCalls } = turnInput({ account: acc, model: 'qwen3:8b', effort: 'xhigh' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(toolCalls, [{ name: 'tasks.create', args: { title: 'A' }, callId: 'call_1' }]);
  const [first, second] = server.hits('/v1/chat/completions');
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.body.reasoning_effort, 'high');
  assert.deepEqual(second.body.messages.slice(3), [
    { role: 'tool', tool_call_id: 'call_1', content: 'created {"title":"A"}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'ERROR: Unknown tool: shell__run' },
  ]);
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning').map((e: any) => e.delta), ['thinking about it']);
});

test('compatible: LM Studio flavour – reasoning_content, image input as parts, finish "length" without calls is a cut-off error', async (t) => {
  const { server, acc } = await setup((_req, res) => {
    sendSse(res, [chunk({ reasoning_content: 'hmm' }), chunk({ content: 'Half an ans' }, 'length'), usage(9, 4), '[DONE]']);
  }, { provider: 'lmstudio' }, null);
  t.after(() => server.close());
  const engine = new CompatibleEngine({ apiKey: async () => undefined, readFile: async () => new Uint8Array([1, 2, 3]) });
  const { input } = turnInput({ account: acc, model: 'local-model', effort: 'none', input: [{ type: 'text', text: 'see' }, { type: 'image', path: '/x.png', mime: 'image/png' }] });
  const result = await engine.run(input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.message, 'The model response was cut off.');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4 });
  const body = server.requests[0].body;
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }]);
  assert.equal(body.reasoning_effort, undefined);
});

test('compatible: 429 with Retry-After → stop limit with retryAfterMs; 401 → unavailable without leaking the key', async (t) => {
  let status = 429;
  const { server, engine, acc } = await setup((_req, res) => sendJson(res, status, { error: { message: `Incorrect API key provided: ${KEY}` } }, status === 429 ? { 'Retry-After': '2' } : {}));
  t.after(() => server.close());
  const limited = await engine.run(turnInput({ account: acc }).input);
  assert.equal(limited.stop, 'limit');
  assert.equal(limited.error?.code, 'rate_limited');
  assert.equal(limited.error?.retryAfterMs, 2000);
  status = 401;
  const { input, events } = turnInput({ account: acc });
  const denied = await engine.run(input);
  assert.equal(denied.stop, 'error');
  assert.equal(denied.error?.code, 'unavailable');
  assert.equal(denied.error?.message, 'The provider rejected this connection. Reconnect in Settings.');
  assert.ok(!JSON.stringify({ denied, events }).includes(KEY));
});

test('compatible: an echoed key is redacted from streamed and final text', async (t) => {
  const { server, engine, acc } = await setup((_req, res) => sendSse(res, [chunk({ content: `your key is ${KEY}` }, 'stop'), '[DONE]']));
  t.after(() => server.close());
  const { input, events } = turnInput({ account: acc });
  const result = await engine.run(input);
  assert.equal(result.text, 'your key is [redacted]');
  assert.ok(!JSON.stringify(events).includes(KEY));
});

test('compatible: abort while streaming → interrupted; lost connection → unavailable; stalled transport → error, not a hang', async (t) => {
  let mode = 'hold';
  const open: ServerResponse[] = [];
  const { server, engine, acc } = await setup((_req, res) => {
    sseHead(res);
    sseEvent(res, chunk({ content: 'Partial' }));
    if (mode === 'drop') setImmediate(() => res.destroy());
    else open.push(res); // hold (abort) and stall (timeout) never finish
  });
  t.after(() => server.close());
  const controller = new AbortController();
  let firstText!: () => void;
  const sawText = new Promise<void>((resolve) => { firstText = resolve; });
  const aborted = turnInput({ account: acc, signal: controller.signal, onEvent: (e: any) => { if (e.type === 'text') firstText(); } });
  const running = engine.run(aborted.input);
  await sawText;
  controller.abort();
  const interrupted = await running;
  assert.equal(interrupted.stop, 'interrupted');
  assert.equal(interrupted.error?.code, 'cancelled');

  mode = 'drop';
  const lost = await engine.run(turnInput({ account: acc }).input);
  assert.equal(lost.stop, 'error');
  assert.equal(lost.error?.code, 'unavailable');

  mode = 'stall';
  const timed = new CompatibleEngine({ apiKey: async () => KEY, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal!, AbortSignal.timeout(200)]) }) });
  const stalled = await timed.run(turnInput({ account: acc }).input);
  assert.equal(stalled.stop, 'error');
  assert.equal(stalled.error?.code, 'unavailable');
  for (const res of open) res.destroy();
});

test('compatible: the tool loop is bounded (40 rounds) and reports an error instead of looping forever', async (t) => {
  const { server, engine, acc } = await setup((_req, res, index) => sendSse(res, [
    chunk({ tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: { name: 'tasks__create', arguments: '{}' } }] }, 'tool_calls'), '[DONE]',
  ]));
  t.after(() => server.close());
  const { input, toolCalls } = turnInput({ account: acc });
  const result = await engine.run(input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.message, 'The model used too many tool calls in one turn.');
  assert.equal(server.requests.length, 40);
  assert.equal(toolCalls.length, 40);
});

test('compatible: listModels sorts ids, drops ids containing the key; checkAccount maps 401 to needs_login', async (t) => {
  let status = 200;
  const { server, engine, acc } = await setup((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/v1/models');
    if (status !== 200) return sendJson(res, status, { error: KEY });
    sendJson(res, 200, { object: 'list', data: [{ id: 'zeta', object: 'model' }, { id: 'alpha', object: 'model' }, { id: `leak-${KEY}` }, { nope: 1 }] });
  });
  t.after(() => server.close());
  const models = await engine.listModels(acc);
  assert.deepEqual(models, [{ model: 'alpha', name: 'alpha', efforts: ['none'] }, { model: 'zeta', name: 'zeta', efforts: ['none'] }]);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(await engine.checkAccount(acc), { state: 'ok', plan: 'api' });
  status = 401;
  await assert.rejects(engine.listModels(acc), (error: unknown) => error instanceof HttpEngineError && error.data.code === 'unavailable');
  const check = await engine.checkAccount(acc);
  assert.equal(check.state, 'needs_login');
  assert.ok(!JSON.stringify(check).includes(KEY));
  status = 429;
  assert.equal((await engine.checkAccount(acc)).state, 'cooling');
});

test('compatible: the temperature an agent asked for (model.set) goes as the standard field; without one none is sent (B-078)', async (t) => {
  const { server, engine, acc } = await setup((_req, res) => sendSse(res, [chunk({ content: 'ok' }, 'stop'), usage(5, 1), '[DONE]']));
  t.after(() => server.close());
  const warm = turnInput({ account: acc, model: 'gpt-x', effort: 'none' });
  await engine.run({ ...warm.input, temperature: 1.3 });
  const plain = turnInput({ account: acc, model: 'gpt-x', effort: 'none' });
  await engine.run(plain.input);
  const [first, second] = server.hits('/v1/chat/completions');
  assert.equal(first.body.temperature, 1.3);
  assert.equal(second.body.temperature, undefined);
});
