// Native timeout integration with scripted engines and a manual clock.
// Owns: actual continuation and cancellation assertions. Never: starts a provider or waits in real time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Engine, EngineEvent, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ToolTimeoutDecision, ToolTimeoutInput } from '../../../src/runtime/tools/timeout.ts';
import { runWithNativeTimeouts, type NativeTimeoutOptions } from '../../../src/runtime/agents/native-timeout.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function setup() {
  let time = 0;
  const pending = new Set<{ fn: () => void; at: number }>();
  const events: EngineEvent[] = [];
  const stop = new AbortController();
  const input = { runId: 'r1', input: [{ type: 'text', text: 'Original request' }], signal: stop.signal, onEvent: (event: EngineEvent) => events.push(event) } as unknown as EngineTurnInput;
  const ctx = { signal: stop.signal, services: { secrets: { redact: (text: string) => text } } } as unknown as ToolContext;
  const options: NativeTimeoutOptions = {
    now: () => time, initial: () => 1,
    timers: {
      set: (fn, ms) => { const entry = { fn, at: time + ms }; pending.add(entry); return entry; },
      clear: (handle) => { pending.delete(handle as { fn: () => void; at: number }); },
    },
  };
  const tick = (ms: number) => {
    const until = time + ms;
    for (;;) {
      const due = [...pending].filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      time = due.at; pending.delete(due); due.fn();
    }
    time = until;
  };
  return { input, ctx, options, tick, stop, events, pending };
}

const start: EngineEvent = { type: 'tool_start', callId: 'c1', name: 'shell', args: { command: 'npm install' }, own: true };
const end: EngineEvent = { type: 'tool_end', callId: 'c1', ok: true, summary: 'installed', output: 'added 42 packages' };

test('absolute native deadline: wait once, then interrupt and resume the same session with decisions, never the original request', async () => {
  const h = setup();
  const inputs: EngineTurnInput[] = [];
  const reviews: ToolTimeoutInput[] = [];
  let active!: EngineTurnInput;
  h.options.review = async (_ctx, timeout) => {
    reviews.push(timeout);
    return reviews.length === 1 ? { action: 'wait', seconds: 3, reason: 'Install is progressing' } : { action: 'abort', reason: 'No progress' };
  };
  const engine = { run: (input: EngineTurnInput) => {
    inputs.push(input);
    if (inputs.length === 2) return Promise.resolve({ text: 'Recovered', stop: 'done', session: input.session, usage: { inputTokens: 20, outputTokens: 3 } });
    active = input;
    input.onEvent(start);
    return new Promise<EngineTurnResult>((resolve) => input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted', session: { ref: 'session1', generation: 2 }, usage: { inputTokens: 10, outputTokens: 2 } }), { once: true }));
  } } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(800);
  active.onEvent({ type: 'status', note: 'still running' });
  active.onEvent(start);
  h.tick(200); await flush();
  assert.equal(reviews.length, 1, 'neither a status nor a duplicate start resets the deadline');
  assert.equal(active.signal.aborted, false);
  h.tick(3000); await flush();
  const result = await running;
  assert.equal(result.stop, 'done');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].session?.ref, 'session1');
  assert.equal(inputs[1].session?.generation, 2);
  const notice = inputs[1].trace!.calls[0].output;
  assert.equal(inputs[1].trace!.calls[0].tool, 'subconscious');
  const words = (inputs[1].input[0] as { text: string }).text;
  assert.doesNotMatch(words, /subconscious/i, 'nothing of it in the words of the turn');
  // B-072 (live 03.11.2026: the engine called the interrupt "User rejected tool use" and the team made it a rule): the
  // continuation says who stopped the call, and that I go on – other ways work too.
  assert.equal(words, 'The app stopped the running call for its time limit – nobody declined it. I continue from these tool results, check any unknown effects and go on – other ways work too.');
  assert.match(notice, /wait another 3 seconds/);
  assert.match(notice, /abort the running call\. The app stopped the running call for its time limit – nobody declined it\. I check its effects and go on – other ways work too\. No progress/);
  assert.doesNotMatch(notice.split('abort the running call')[0], /nobody declined/, 'a wait decision says nothing about a stop');
  assert.match(notice, /No final tool output was received/);
  assert.doesNotMatch(notice, /Original request/);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 5 });
  assert.equal(h.pending.size, 0);
});

test('the engine result keeps its cached tokens: Codex cached input and Claude cache reads and writes reach the turn usage', async () => {
  const h = setup();
  const usages = [
    { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024 },
    { inputTokens: 900, outputTokens: 30, cacheReadTokens: 600, cacheWriteTokens: 200, costUsd: 0.01 },
  ];
  for (const usage of usages) {
    const engine = { run: () => Promise.resolve({ text: 'Done', stop: 'done', usage }) } as unknown as Engine;
    const result = await runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
    assert.deepEqual(result.usage, usage);
  }
});

test('a native tool completing during review cancels that review and never interrupts or resumes it', async () => {
  const h = setup();
  let active!: EngineTurnInput;
  let finish!: (result: EngineTurnResult) => void;
  let answer!: (decision: ToolTimeoutDecision) => void;
  let reviewSignal!: AbortSignal;
  let turns = 0;
  h.options.review = (_ctx, _timeout, signal) => { reviewSignal = signal!; return new Promise((resolve) => { answer = resolve; }); };
  const engine = { run: (input: EngineTurnInput) => {
    turns++; active = input; input.onEvent(start);
    return new Promise<EngineTurnResult>((resolve) => { finish = resolve; });
  } } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(1000); await flush();
  active.onEvent(end);
  assert.equal(reviewSignal.aborted, true);
  finish({ text: 'Finished', stop: 'done', session: { ref: 's', generation: 1 } });
  answer({ action: 'abort', reason: 'late answer' });
  assert.equal((await running).stop, 'done');
  assert.equal(active.signal.aborted, false);
  assert.equal(turns, 1);
  assert.equal(h.pending.size, 0);
});

test('a completed native result shows the wait decision and real output as a real call in the running turn, never as steered words', async () => {
  const h = setup();
  const notices: string[] = [];
  let active!: EngineTurnInput;
  let finish!: (result: EngineTurnResult) => void;
  let turns = 0;
  h.options.review = async () => ({ action: 'wait', seconds: 10, reason: 'Still installing' });
  const engine = {
    steer: async () => { throw new Error('steered'); },
    tell: async (_runId: string, call: { output: string }) => { notices.push(call.output); return true; },
    run: (input: EngineTurnInput) => {
      turns++; active = input; input.onEvent(start);
      return new Promise<EngineTurnResult>((resolve) => { finish = resolve; });
    },
  } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(1000); await flush();
  active.onEvent(end);
  finish({ text: 'Finished', stop: 'done', session: { ref: 's', generation: 1 } });
  await running;
  assert.equal(turns, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /wait another 10 seconds/);
  assert.match(notices[0], /added 42 packages/);
  assert.equal(h.pending.size, 0);
});

test('without tell a turn that ended well is not started again: the decisions wait for its next turn, without the output it has read', async () => {
  const h = setup();
  const inputs: EngineTurnInput[] = [];
  let active!: EngineTurnInput;
  let finish!: (result: EngineTurnResult) => void;
  h.options.review = async () => ({ action: 'wait', seconds: 10, reason: 'Still installing' });
  const engine = { run: (input: EngineTurnInput) => {
    inputs.push(input);
    if (inputs.length > 1) return Promise.resolve({ text: 'Done', stop: 'done', session: input.session });
    active = input; input.onEvent(start);
    return new Promise<EngineTurnResult>((resolve) => { finish = resolve; });
  } } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, { ...h.options, thread: 'th' });
  h.tick(1000); await flush();
  active.onEvent(end);
  finish({ text: 'Finished', stop: 'done', session: { ref: 's', generation: 1 } });
  const kept: Array<{ agentId: string; thread: string; output: string }> = [];
  Object.assign(h.ctx.services, { subconscious: { putBack: (agentId: string, thread: string, trace: { calls: Array<{ output: string }> }) => { kept.push({ agentId, thread, output: trace.calls[0].output }); } } });
  assert.equal((await running).text, 'Finished', 'the answer the person gets stays the one that read the output');
  assert.equal(inputs.length, 1);
  assert.equal(kept[0].thread, 'th');
  assert.match(kept[0].output, /Still installing/);
  assert.doesNotMatch(kept[0].output, /added 42 packages/);
});

test('a nested shell owns its deadline while the enclosing script waits', async () => {
  const h = setup();
  const reviews: string[] = [];
  let active!: EngineTurnInput;
  h.options.review = async (_ctx, timeout) => { reviews.push(timeout.tool); return { action: 'wait', seconds: 10, reason: 'Continue' }; };
  const engine = { run: (input: EngineTurnInput) => {
    active = input;
    input.onEvent({ type: 'tool_start', callId: 'script', name: 'exec', args: {}, own: true });
    return new Promise<EngineTurnResult>((resolve) => input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted', session: { ref: 's', generation: 1 } }), { once: true }));
  } } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(500);
  active.onEvent({ ...start, parent: 'script', nested: true });
  h.tick(1000); await flush();
  assert.deepEqual(reviews, ['shell']);
  active.onEvent(end);
  h.tick(1000); await flush();
  assert.deepEqual(reviews, ['shell', 'exec']);
  h.stop.abort();
  assert.equal((await running).stop, 'interrupted');
  assert.equal(h.pending.size, 0);
});

test('a nested hub tool suspends the script deadline until the hub result arrives', async () => {
  const h = setup();
  const reviews: string[] = [];
  let active!: EngineTurnInput;
  h.options.review = async (_ctx, timeout) => { reviews.push(timeout.tool); return { action: 'wait', seconds: 10, reason: 'Continue' }; };
  const engine = { run: (input: EngineTurnInput) => {
    active = input;
    input.onEvent({ type: 'tool_start', callId: 'script', name: 'exec', args: {}, own: true });
    return new Promise<EngineTurnResult>((resolve) => input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted', session: { ref: 's', generation: 1 } }), { once: true }));
  } } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(500);
  active.onEvent({ type: 'tool_start', callId: 'hub', name: 'secrets.run', args: {}, own: false, nested: true, parent: 'script' });
  h.tick(10_000); await flush();
  assert.deepEqual(reviews, [], 'the hub command owns its own timeout; neither it nor its script is reviewed here');
  assert.equal(active.signal.aborted, false);
  active.onEvent({ type: 'tool_end', callId: 'hub', ok: true, summary: 'finished' });
  h.tick(1000); await flush();
  assert.deepEqual(reviews, ['exec']);
  h.stop.abort();
  assert.equal((await running).stop, 'interrupted');
  assert.equal(h.pending.size, 0);
});

test('a hanging tell is bounded: the turn ends as it ended and the decision waits for the next turn', async () => {
  const h = setup();
  const inputs: EngineTurnInput[] = [];
  let active!: EngineTurnInput;
  let finish!: (result: EngineTurnResult) => void;
  h.options.deliveryMs = 1000;
  h.options.review = async () => ({ action: 'wait', seconds: 10, reason: 'Still installing' });
  const engine = {
    tell: () => new Promise<boolean>(() => {}),
    run: (input: EngineTurnInput) => {
      inputs.push(input);
      if (inputs.length > 1) return Promise.resolve({ text: 'Done', stop: 'done', session: input.session });
      active = input; input.onEvent(start);
      return new Promise<EngineTurnResult>((resolve) => { finish = resolve; });
    },
  } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(1000); await flush();
  active.onEvent(end);
  finish({ text: 'Finished', stop: 'done', session: { ref: 's', generation: 1 } });
  await flush();
  h.tick(999); await flush();
  assert.equal(inputs.length, 1);
  h.tick(1);
  assert.equal((await running).stop, 'done');
  assert.equal(inputs.length, 1);
  assert.equal(h.pending.size, 0);
});

test('the caller aborts a hanging tell immediately without continuing the session', async () => {
  const h = setup();
  let active!: EngineTurnInput;
  let finish!: (result: EngineTurnResult) => void;
  let turns = 0;
  h.options.review = async () => ({ action: 'wait', seconds: 10, reason: 'Still installing' });
  const engine = {
    tell: () => new Promise<boolean>(() => {}),
    run: (input: EngineTurnInput) => {
      turns++; active = input; input.onEvent(start);
      return new Promise<EngineTurnResult>((resolve) => { finish = resolve; });
    },
  } as unknown as Engine;
  const running = runWithNativeTimeouts(engine, h.input, h.ctx, h.options);
  h.tick(1000); await flush();
  active.onEvent(end);
  finish({ text: 'Finished', stop: 'done', session: { ref: 's', generation: 1 } });
  await flush();
  h.stop.abort();
  await running;
  assert.equal(turns, 1);
  assert.equal(h.pending.size, 0);
});
