// Claude Code steering (21.10. 17:09, engines/claude/engine.ts): a line steered into a running turn
// is never left unanswered – when the CLI answers it as its own (a second result) the turn waits for
// that answer; when the CLI took it into the running turn (one result) the turn ends with the CLI;
// either way the input ends at the first result; after the turn no line is accepted. The usage of
// several results adds up (tokens; the cost as the CLI's running total).
// Owns: these assertions only. Never: a real Claude Code binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup, until } from './claude-fixture.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (session: string, text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session });
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), ...patch });

test('claude: a steered line answered as its own turn – the run waits for that answer', async () => {
  const h = claudeSetup({ exit: false, turn: () => [delta('Working')] });
  const t = input();
  let ended = false;
  const running = h.engine.run(t.input).then((value) => { ended = true; return value; });
  await until(() => t.events.some((event: any) => event.type === 'text'));
  assert.equal(await h.engine.steer('run_1', 'Use the blue logo'), true);
  const child = h.cli.of('turn')[0].child;
  const session = h.cli.of('turn')[0].args[h.cli.of('turn')[0].args.indexOf('--session-id') + 1];
  child.send(assistant('Working on it.'));
  child.send(result(session, 'Working on it.'));
  await until(() => child.stdin.writableEnded, 50);
  assert.equal(child.stdin.writableEnded, true, 'no more input after the first answer');
  assert.equal(ended, false, 'still waiting for the steered line\'s answer');
  assert.equal(await h.engine.steer('run_1', 'too late for this turn'), false, 'input ended: the next turn reads it');
  child.send(delta('Blue it is.'));
  child.send(assistant('Blue it is.'));
  child.send(result(session, 'Blue it is.'));
  const done = await running;
  assert.equal(done.stop, 'done');
  assert.match(done.text, /Blue it is\./);
  child.exit(0);
});

test('claude: a steered line taken into the running turn (one result) – the run ends with the CLI', async () => {
  const h = claudeSetup({ exit: false, turn: () => [delta('Working')] });
  const t = input();
  const running = h.engine.run(t.input);
  await until(() => t.events.some((event: any) => event.type === 'text'));
  assert.equal(await h.engine.steer('run_1', 'Also the docs'), true);
  const child = h.cli.of('turn')[0].child;
  const session = h.cli.of('turn')[0].args[h.cli.of('turn')[0].args.indexOf('--session-id') + 1];
  child.send(assistant('Done, docs included.'));
  child.send(result(session, 'Done, docs included.'));
  await until(() => child.stdin.writableEnded, 50);
  child.exit(0); // the CLI read its input to the end and quits
  const done = await running;
  assert.equal(done.stop, 'done');
  assert.equal(await h.engine.steer('run_1', 'after'), false);
});

test('claude: a steered line answered as its own result – tokens add up, the cost is the running total (summed when it went down)', () => {
  const usage = (input: number, output: number, cost: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: input, cache_read_input_tokens: 1, output_tokens: output }, total_cost_usd: cost });
  const running = new ClaudeStreamParser(() => {}, () => 0);
  running.push(usage(100, 10, 0.02));
  running.push(usage(50, 5, 0.03));
  assert.deepEqual(running.state.usage, { inputTokens: 152, outputTokens: 15, costUsd: 0.03, cacheReadTokens: 2 }, 'the CLI reports its running total');
  const perResult = new ClaudeStreamParser(() => {}, () => 0);
  perResult.push(usage(100, 10, 0.02));
  perResult.push(usage(50, 5, 0.01));
  assert.equal(perResult.state.usage?.costUsd, 0.03, 'a total that went down was per result: summed');
  const single = new ClaudeStreamParser(() => {}, () => 0);
  single.push(usage(100, 10, 0.02));
  assert.deepEqual(single.state.usage, { inputTokens: 101, outputTokens: 10, costUsd: 0.02, cacheReadTokens: 1 }, 'one result: unchanged');
});
