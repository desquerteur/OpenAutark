// Codex engine over a scripted app-server: thread start/resume, the volatile context block on
// reused threads, streaming, tools, approvals, limits, interrupt/steer, the reported context
// window, ended sessions (details.rebase – also a loaded thread whose turn runs in another folder,
// marked details.folder), models and account checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import type { EngineEvent } from '../../../src/runtime/engines/types.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput, account, tick, type FakeChild } from './fakes.ts';

/** B-049 F7: a session also names the native turn id; these tests check the thread and its generation. */
const bare = (session: { ref: string; generation: number } | undefined) => session && { ref: session.ref, generation: session.generation };

/** A scripted app-server. `onTurn` drives what happens after turn/start. */
function appServer(options: { onTurn?: (child: FakeChild, msg: any, state: any) => void; turnStatus?: string } = {}) {
  const state: any = { requests: [] as any[], replies: new Map<number, any>(), threads: 0 };
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.method) state.requests.push(msg);
      if (msg.id !== undefined && !msg.method) { state.replies.set(msg.id, msg); state.onReply?.(msg); return; }
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++state.threads}` } } }); break;
        case 'thread/resume':
          if (state.refuseResume) child.send({ id: msg.id, error: { code: -32600, message: 'thread not found' } });
          else child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
          break;
        case 'thread/inject_items': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start':
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          options.onTurn?.(child, msg, state);
          break;
        case 'turn/interrupt':
          child.send({ id: msg.id, result: {} });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'interrupted' } } });
          break;
        case 'turn/steer': child.send({ id: msg.id, result: { turnId: 'turn_1' } }); break;
        case 'model/list': child.send({ id: msg.id, result: { data: [
          { model: 'gpt-x', displayName: 'GPT X', hidden: false, inputModalities: ['text', 'image'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'xhigh', description: '' }] },
          { model: 'hidden-1', displayName: 'H', hidden: true, supportedReasoningEfforts: [] },
        ], nextCursor: null } }); break;
        case 'account/read': child.send({ id: msg.id, result: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true } }); break;
        case 'account/rateLimits/read': child.send({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 3000 } } } }); break;
        default: if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, calls, state };
}

function engine(spawn: any, extra: Record<string, unknown> = {}) {
  return new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0', ...extra });
}

test('codex: thread/start carries instructions, sandbox and dynamic tools; streams text; answers item/tool/call', async () => {
  const fake = appServer({
    onTurn: (child, msg) => {
      const threadId = msg.params.threadId;
      child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn_1', itemId: 'm1', delta: 'Hel' } });
      child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn_1', itemId: 'm1', delta: 'lo' } });
      child.send({ id: 900, method: 'item/tool/call', params: { threadId, turnId: 'turn_1', callId: 'c1', tool: 'tasks__create', namespace: null, arguments: { title: 'X' } } });
    },
  });
  fake.state.onReply = (reply: any) => {
    if (reply.id !== 900) return;
    const child = fake.calls[0].child;
    child.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { last: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, reasoningOutputTokens: 0 }, total: {} } } });
    child.send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'Hello done' } } });
    child.send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
  };
  const e = engine(fake.spawn);
  const { input, events, toolCalls } = turnInput();
  const result = await e.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Hello done');
  assert.deepEqual(bare(result.session), { ref: 'thr_1', generation: 1 }); // B-049 F7 adds the native turn id
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 });
  const args = fake.calls[0].args;
  assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  const start = fake.state.requests.find((r: any) => r.method === 'thread/start');
  assert.equal(start.params.baseInstructions, 'STABLE');
  assert.equal(start.params.developerInstructions, 'VOLATILE');
  assert.equal(start.params.sandbox, 'read-only', 'the workspace-write sandbox comes with each turn (codex-isolation.test.ts)');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.deepEqual(start.params.dynamicTools[0], { type: 'function', name: 'tasks__create', description: 'Create a task', inputSchema: input.tools[0].inputSchema });
  const init = fake.state.requests.find((r: any) => r.method === 'initialize');
  assert.equal(init.params.capabilities.experimentalApi, true);
  assert.deepEqual(toolCalls, [{ name: 'tasks.create', args: { title: 'X' }, callId: 'c1' }]);
  const reply = fake.state.replies.get(900);
  assert.equal(reply.result.success, true);
  assert.deepEqual(reply.result.contentItems[0], { type: 'inputText', text: 'created {"title":"X"}' });
  assert.deepEqual(events.filter((ev: any) => ev.type === 'text').map((ev: any) => ev.delta), ['Hel', 'lo']);
  assert.ok(events.some((ev: any) => ev.type === 'tool_start' && ev.name === 'tasks.create' && ev.own === false));
  await e.dispose();
});

test('codex: commentary becomes work updates, separate from the final answer', async () => {
  const fake = appServer({ onTurn: (child, msg) => {
    const params = { threadId: msg.params.threadId, turnId: 'turn_1' };
    child.send({ method: 'item/started', params: { ...params, item: { id: 'c1', type: 'agentMessage', phase: 'commentary' } } });
    child.send({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'c1', delta: 'Checking the files.' } });
    child.send({ method: 'item/completed', params: { ...params, item: { id: 'c1', type: 'agentMessage', phase: 'commentary', text: 'Checking the files.' } } });
    child.send({ method: 'item/completed', params: { ...params, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    child.send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
  } });
  const e = engine(fake.spawn);
  const { input, events } = turnInput();
  const result = await e.run(input);
  assert.equal(result.text, 'Done.');
  assert.deepEqual(events.filter((event: EngineEvent) => event.type === 'commentary'), [{ type: 'commentary', text: 'Checking the files.' }]);
  assert.equal(events.filter((event: EngineEvent) => event.type === 'text').length, 0);
  await e.dispose();
});

test('codex: a provider outage (codexErrorInfo serverOverloaded / lost stream) ends the turn unavailable, not as a model failure (B-059 #184)', async () => {
  for (const info of ['serverOverloaded', { responseStreamDisconnected: { httpStatusCode: 502 } }]) {
    const fake = appServer({
      onTurn: (child, msg) => child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'failed', error: { message: 'down', codexErrorInfo: info } } } }),
    });
    const e = engine(fake.spawn);
    const result = await e.run(turnInput().input);
    assert.equal(result.stop, 'error');
    assert.equal(result.error?.code, 'unavailable', JSON.stringify(info));
    assert.equal(result.error?.message, 'OpenAI is overloaded or unreachable right now.');
    await e.dispose();
  }
  const bad = appServer({ onTurn: (child, msg) => child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'failed', error: { message: 'bad', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } } } } }) });
  const e = engine(bad.spawn);
  assert.equal((await e.run(turnInput().input)).error?.code, 'internal', 'a 4xx stays a failure');
  await e.dispose();
});

test('codex: usage limit → stop limit with retryAfterMs from pushed limits; limits event forwarded', async () => {
  const now = 1_000_000;
  const fake = appServer({
    onTurn: (child, msg) => {
      child.send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: (now + 60_000) / 1000 }, rateLimitReachedType: 'rate_limit_reached' } } });
      child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } } });
    },
  });
  const pushed: any[] = [];
  const e = engine(fake.spawn, { now: () => now, onLimits: (id: string, limits: unknown) => pushed.push({ id, limits }) });
  const { input, events } = turnInput();
  const result = await e.run(input);
  assert.equal(result.stop, 'limit');
  assert.equal(result.error?.code, 'rate_limited');
  assert.equal(result.error?.retryAfterMs, 60_000);
  assert.equal(pushed[0].id, 'acc_test');
  assert.equal(pushed[0].limits.windows[0].name, '5h');
  assert.ok(events.some((ev: any) => ev.type === 'limits'));
  await e.dispose();
});

test('codex: abort sends turn/interrupt; steer sends turn/steer', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fake = appServer({ onTurn: () => started() });
  const e = engine(fake.spawn);
  const controller = new AbortController();
  const { input } = turnInput({ signal: controller.signal });
  const running = e.run(input);
  await ready;
  await tick();
  assert.equal(await e.steer('run_1', 'important'), true);
  const steer = fake.state.requests.find((r: any) => r.method === 'turn/steer');
  assert.equal(steer.params.expectedTurnId, 'turn_1');
  controller.abort();
  const result = await running;
  assert.equal(result.stop, 'interrupted');
  assert.ok(fake.state.requests.some((r: any) => r.method === 'turn/interrupt'));
  await e.dispose();
});

const complete = (child: FakeChild, msg: any) => child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
const turnStarts = (fake: { state: any }) => fake.state.requests.filter((r: any) => r.method === 'turn/start');

test('codex: a reused or resumed thread gets the current volatile context in front of the turn input; a new thread does not', async () => {
  const fake = appServer({ onTurn: complete });
  const e = engine(fake.spawn);
  const first = await e.run(turnInput({ system: { stable: 'STABLE', volatile: 'VOLATILE1' } }).input);
  assert.deepEqual(bare(first.session), { ref: 'thr_1', generation: 1 }); // B-049 F7 adds the native turn id
  assert.equal(fake.state.requests.find((r: any) => r.method === 'thread/start').params.developerInstructions, 'VOLATILE1');
  const firstInput = turnStarts(fake)[0].params.input; // H1: the app note (codex-app-note.test.ts) goes in front of it
  assert.ok(!firstInput.some((item: any) => String(item.text).includes('<workforce-context>')), 'thread/start already carries it');
  assert.deepEqual(firstInput.at(-1), { type: 'text', text: 'hello', text_elements: [] });

  const second = await e.run(turnInput({ session: { ref: 'thr_1', generation: 1 }, system: { stable: 'STABLE', volatile: 'VOLATILE2' }, input: [{ type: 'text', text: 'next' }] }).input);
  assert.equal(second.stop, 'done');
  assert.equal(fake.state.requests.filter((r: any) => r.method === 'thread/start' || r.method === 'thread/resume').length, 1, 'the loaded thread is reused as is');
  const input = turnStarts(fake)[1].params.input;
  assert.equal(input[0].type, 'text');
  assert.ok(input[0].text.startsWith('<workforce-context>\n') && input[0].text.includes('VOLATILE2') && input[0].text.endsWith('\n</workforce-context>'), input[0].text);
  assert.ok(!input[0].text.includes('VOLATILE1'));
  assert.deepEqual(input[1], { type: 'text', text: 'next', text_elements: [] });

  // An empty volatile part adds nothing.
  await e.run(turnInput({ session: { ref: 'thr_1', generation: 1 }, system: { stable: 'STABLE', volatile: '  ' } }).input);
  assert.deepEqual(turnStarts(fake)[2].params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  await e.dispose();

  // After a restart the thread is resumed (not started), and the block still travels with the turn.
  const fake2 = appServer({ onTurn: complete });
  const e2 = engine(fake2.spawn);
  const resumed = await e2.run(turnInput({ session: { ref: 'thr_1', generation: 3 }, system: { stable: 'STABLE', volatile: 'VOLATILE3' } }).input);
  assert.deepEqual(bare(resumed.session), { ref: 'thr_1', generation: 3 }); // B-049 F7 adds the native turn id
  assert.ok(fake2.state.requests.some((r: any) => r.method === 'thread/resume' && r.params.threadId === 'thr_1'));
  assert.ok(!fake2.state.requests.some((r: any) => r.method === 'thread/start' || r.method === 'thread/inject_items'));
  assert.match(turnStarts(fake2)[0].params.input[0].text, /^<workforce-context>\nVOLATILE3\n<\/workforce-context>$/);
  await e2.dispose();
});

test('codex: reports the model context window; a full context or a refused resume ends the session (details.rebase)', async () => {
  const fake = appServer({
    onTurn: (child, msg) => {
      const threadId = msg.params.threadId;
      child.send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn_1', tokenUsage: { last: { inputTokens: 900, outputTokens: 10, totalTokens: 910 }, total: {}, modelContextWindow: 258_400 } } });
      const full = msg.params.input.some((item: any) => item.text === 'overflow');
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: full ? 'failed' : 'completed', error: full ? { message: 'too long', codexErrorInfo: 'contextWindowExceeded' } : null } } });
    },
  });
  const e = engine(fake.spawn);
  const ok = await e.run(turnInput().input);
  assert.equal(ok.contextWindow, 258_400);
  assert.equal(ok.contextTokens, 910);
  const full = await e.run(turnInput({ session: { ref: 'thr_1', generation: 1 }, input: [{ type: 'text', text: 'overflow' }] }).input);
  assert.equal(full.stop, 'error');
  assert.equal(full.error?.code, 'conflict');
  assert.equal(full.error?.details?.rebase, true);
  await e.dispose();

  // A thread the new server refuses to resume (e.g. gone from the account home) cannot continue.
  const refusing = appServer({ onTurn: complete });
  refusing.state.refuseResume = true;
  const e2 = engine(refusing.spawn);
  const gone = await e2.run(turnInput({ session: { ref: 'thr_gone', generation: 2 } }).input);
  assert.equal(gone.stop, 'error');
  assert.equal(gone.error?.details?.rebase, true);
  assert.ok(!refusing.state.requests.some((r: any) => r.method === 'turn/start'));
  await e2.dispose();
});

test('codex: a loaded thread opened in a task worktree is not reused in another folder (details.rebase)', async () => {
  const fake = appServer({ onTurn: complete });
  const e = engine(fake.spawn);
  const worktree = '/work/.worktrees/tsk_1';
  const first = await e.run(turnInput({ cwd: worktree }).input);
  assert.deepEqual(bare(first.session), { ref: 'thr_1', generation: 1 }); // B-049 F7 adds the native turn id
  const same = await e.run(turnInput({ cwd: `${worktree}/`, session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(same.stop, 'done', 'the same folder (another spelling) keeps the thread');

  const moved = await e.run(turnInput({ cwd: '/work', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(moved.stop, 'error');
  assert.equal(moved.error?.code, 'conflict');
  assert.equal(moved.error?.details?.rebase, true, 'the executor renews the session');
  assert.equal(moved.error?.details?.folder, true, 'quietly: a folder change, not a lost session');
  assert.equal(turnStarts(fake).length, 2, 'no turn ran on the old thread in the new folder');
  const renewed = await e.run(turnInput({ cwd: '/work' }).input);
  assert.deepEqual(bare(renewed.session), { ref: 'thr_2', generation: 1 }); // B-049 F7 adds the native turn id
  assert.equal(fake.state.requests.filter((r: any) => r.method === 'thread/start').at(-1).params.cwd, '/work');
  await e.dispose();
});

test('codex: listModels filters hidden and normalizes efforts; checkAccount reads account + limits', async () => {
  const fake = appServer();
  const e = engine(fake.spawn, { now: () => 5 });
  const models = await e.listModels(account());
  assert.deepEqual(models.map((m) => m.model), ['gpt-x']);
  assert.deepEqual(models[0].efforts, ['low', 'medium', 'xhigh']);
  const check = await e.checkAccount(account());
  assert.equal(check.state, 'ok');
  assert.equal(check.plan, 'plus');
  assert.equal(check.email, 'a@b.c');
  assert.deepEqual(check.limits?.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [['5h', 10, 2_000_000], ['weekly', 40, 3_000_000]]);
  // one process for both calls
  assert.equal(fake.calls.length, 1);
  await e.dispose();
});

test('codex: CODEX_HOME set for isolated accounts; API keys stripped from env', async () => {
  const fake = appServer();
  const e = engine(fake.spawn, { env: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' } });
  await e.listModels(account({ id: 'acc_2', home: '/data/accounts/codex/acc_2' }));
  const env = fake.calls[0].options.env!;
  assert.equal(env.CODEX_HOME, '/data/accounts/codex/acc_2');
  assert.equal(env.OPENAI_API_KEY, undefined);
  await e.dispose();
});

test('codex: a web search is journaled with its query on completion (Codex fills it only then); no status counts as done', async () => {
  const fake = appServer({ onTurn: (child, msg) => {
    const params = { threadId: msg.params.threadId, turnId: 'turn_1' };
    child.send({ method: 'item/started', params: { ...params, item: { id: 'w1', type: 'webSearch', query: '' } } });
    child.send({ method: 'item/completed', params: { ...params, item: { id: 'w1', type: 'webSearch', query: '', action: { type: 'search', query: 'Teydra Lab opening hours' } } } });
    child.send({ method: 'item/started', params: { ...params, item: { id: 'w2', type: 'webSearch', query: 'teydra.com' } } });
    child.send({ method: 'item/completed', params: { ...params, item: { id: 'w2', type: 'webSearch', query: 'teydra.com' } } });
    child.send({ method: 'item/completed', params: { ...params, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    child.send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn_1', status: 'completed' } } });
  } });
  const e = engine(fake.spawn);
  const { input, events } = turnInput();
  await e.run(input);
  const starts = events.filter((event: any) => event.type === 'tool_start' && event.name === 'web_search');
  assert.deepEqual(starts.map((event: any) => [event.callId, event.args.query]), [['w1', 'Teydra Lab opening hours'], ['w2', 'teydra.com'], ['w2', 'teydra.com']], 'w1 waits for its query; a repeated start is ignored by the journal');
  assert.ok(events.some((event: any) => event.type === 'status' && event.note === 'Searching the web'));
  assert.deepEqual(events.filter((event: any) => event.type === 'tool_end').map((event: any) => [event.callId, event.ok]), [['w1', true], ['w2', true]]);
  await e.dispose();
});
