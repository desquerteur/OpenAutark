// Steering the HTTP tool loop (21.10. 17:09, engines/http/base.ts): text steered into a running turn
// joins the conversation as a user message before the next request – after the round's tool
// results (Anthropic: inside that same user message, roles keep alternating), never inside a tool
// call – an answer that ended while text waited gets one more request, a structured helper turn is
// never steered, and nothing is accepted for a run that is not running. A call of the round that has
// not started when text waits is not run (the model decides again); a cut-off tool call (max_tokens)
// is never continued for steering (it has no result).
// Owns: these assertions only. Never: the network beyond loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEngine } from '../../../src/runtime/engines/http/anthropic.ts';
import { CompatibleEngine } from '../../../src/runtime/engines/http/compatible.ts';
import { OpenAiEngine } from '../../../src/runtime/engines/http/openai.ts';
import { NOT_RUN_STEERED } from '../../../src/runtime/engines/http/base.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve } from './http-fixture.ts';

const STEER = 'New messages in this chat while you are working:\n[10:02] Lena: (important) Use the blue logo!';

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'cc_1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });

test('compatible: text steered during a tool call reaches the model after that tool result, in the next request', async (t) => {
  const server = await serve((_req, res, index) => {
    if (index === 0) sendSse(res, [chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"X"}' } }] }), chunk({}, 'tool_calls'), '[DONE]']);
    else sendSse(res, [chunk({ content: 'Blue it is.' }, 'stop'), '[DONE]']);
  });
  t.after(() => server.close());
  const engine = new CompatibleEngine({ apiKey: async () => 'sk-test' });
  const acc = account({ provider: 'compatible', auth: 'api', baseUrl: `${server.url}/v1` });
  const accepted: boolean[] = [];
  const { input } = turnInput({
    account: acc, model: 'm',
    callTool: async () => { accepted.push(await engine.steer('run_1', STEER)); return { content: [{ type: 'text', text: 'created' }] }; },
  });
  assert.equal(await engine.steer('run_1', STEER), false, 'not running yet');
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(accepted, [true]);
  const [, second] = server.hits('/v1/chat/completions');
  const roles = second.body.messages.map((m: any) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'user'], 'after the tool result, never inside the call');
  assert.equal(second.body.messages[4].content, STEER);
  assert.equal(await engine.steer('run_1', STEER), false, 'the turn ended: nothing is accepted');
});

test('compatible: text steered during the first of two calls – the second is not started, the model decides it again with the message', async (t) => {
  const server = await serve((_req, res, index) => {
    if (index === 0) sendSse(res, [chunk({ tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"X"}' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"Y"}' } },
    ] }), chunk({}, 'tool_calls'), '[DONE]']);
    else sendSse(res, [chunk({ content: 'Stopped before Y.' }, 'stop'), '[DONE]']);
  });
  t.after(() => server.close());
  const engine = new CompatibleEngine({ apiKey: async () => 'sk-test' });
  const ran: string[] = [];
  const { input, events } = turnInput({
    account: account({ provider: 'compatible', auth: 'api', baseUrl: `${server.url}/v1` }), model: 'm',
    callTool: async (_name: string, _args: unknown, callId: string) => { ran.push(callId); await engine.steer('run_1', STEER); return { content: [{ type: 'text', text: 'created' }] }; },
  });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(ran, ['call_a'], 'the call in flight finishes; the one not started yet is not run');
  assert.deepEqual(events.filter((event: any) => event.type === 'tool_start').map((event: any) => event.callId), ['call_a']);
  const [, second] = server.hits('/v1/chat/completions');
  const tools = second.body.messages.filter((m: any) => m.role === 'tool');
  assert.deepEqual(tools.map((m: any) => m.tool_call_id), ['call_a', 'call_b'], 'every call has its result');
  assert.match(JSON.stringify(tools[1].content), new RegExp(NOT_RUN_STEERED.slice(0, 30)));
  assert.equal(second.body.messages.at(-1).content, STEER);
});

const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } };
const end = (reason: string) => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];

test('anthropic: steered text joins the tool results\' user message (roles keep alternating)', async (t) => {
  const server = await serve((_req, res, index) => {
    if (index === 0) sendSse(res, [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'tasks__create', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"X"}' } },
      { type: 'content_block_stop', index: 0 },
      ...end('tool_use'),
    ]);
    else sendSse(res, [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
  });
  t.after(() => server.close());
  const engine = new AnthropicEngine({ apiKey: async () => 'sk-ant' });
  const { input } = turnInput({
    account: account({ provider: 'anthropic', auth: 'api', baseUrl: `${server.url}/v1` }), model: 'claude-opus-5-5', effort: 'high',
    callTool: async () => { await engine.steer('run_1', STEER); return { content: [{ type: 'text', text: 'created' }] }; },
  });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  const [, second] = server.hits('/v1/messages');
  assert.deepEqual(second.body.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  const last = second.body.messages[2].content;
  assert.equal(last[0].type, 'tool_result');
  assert.deepEqual(last[1], { type: 'text', text: STEER });
});

test('anthropic: a cut-off tool call (max_tokens) ends the turn even while text waits – no request with a tool_use lacking its result', async (t) => {
  let engine: AnthropicEngine;
  const server = await serve(async (_req, res) => {
    assert.equal(await engine.steer('run_1', STEER), true);
    sendSse(res, [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'tasks__create', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"X"}' } },
      { type: 'content_block_stop', index: 0 },
      ...end('max_tokens'),
    ]);
  });
  t.after(() => server.close());
  engine = new AnthropicEngine({ apiKey: async () => 'sk-ant' });
  const { input } = turnInput({ account: account({ provider: 'anthropic', auth: 'api', baseUrl: `${server.url}/v1` }), model: 'claude-opus-5-5', effort: 'high' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(server.hits('/v1/messages').length, 1);
});

const message = (text: string) => ({ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { id: 'resp', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } } });

test('openai: an answer that ended while steered text waited gets one more request; a structured helper turn is never steered', async (t) => {
  let engine: OpenAiEngine;
  const server = await serve(async (_req, res, index) => {
    if (index === 0) {
      assert.equal(await engine.steer('run_1', STEER), true, 'accepted while the answer streams');
      sendSse(res, [{ type: 'response.output_text.delta', delta: 'Working on it.' }, completed([message('Working on it.')])]);
    } else if (index === 1) sendSse(res, [{ type: 'response.output_text.delta', delta: 'Switched to blue.' }, completed([message('Switched to blue.')])]);
    else {
      assert.equal(await engine.steer('run_2', STEER), false, 'a structured helper turn takes no steering');
      sendSse(res, [{ type: 'response.output_text.delta', delta: '{"ok":true}' }, completed([message('{"ok":true}')])]);
    }
  });
  t.after(() => server.close());
  engine = new OpenAiEngine({ apiKey: async () => 'sk-proj' });
  const acc = account({ provider: 'openai', auth: 'api', baseUrl: `${server.url}/v1` });
  const { input } = turnInput({ account: acc, model: 'gpt-6' });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Working on it.\n\nSwitched to blue.');
  const [, second] = server.hits('/v1/responses');
  const items = second.body.input;
  assert.deepEqual(items[items.length - 1], { role: 'user', content: [{ type: 'input_text', text: STEER }] });
  const helper = turnInput({ account: acc, model: 'gpt-6', runId: 'run_2', tools: [], outputSchema: { type: 'object' } });
  assert.equal((await engine.run(helper.input)).stop, 'done');
  assert.equal(server.hits('/v1/responses').length, 3, 'the helper turn made exactly one request');
});
