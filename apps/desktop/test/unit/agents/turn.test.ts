// Turn phases: the agent's own model request reaches the router as explicit, attachments are
// extracted before the delta, workforce tools called through the MCP hub block failover,
// a failover after tool calls books both attempts, a failed or refused call of ours is no
// progress, and the subconscious gets the turn's mode before and after it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../store/helpers.ts';
import { setNextRoute } from '../../../src/runtime/agents/next-route.ts';
import { mergeAttempts, TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { buildTurn, planTurn, routeRequest } from '../../../src/runtime/agents/turn-prepare.ts';
import { canFailover, runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { setup } from './fixture.ts';

const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };

test('spoken answers carry the call id, typed messages during a call remain normal answers', async () => {
  const h = setup();
  h.services.router = { route: async () => h.route } as typeof h.services.router;
  h.state.script = async input => {
    input.onEvent({ type: 'commentary', text: 'Checking the plan.' });
    return { text: 'Ready.', stop: 'done' };
  };
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Spoken question', meta: { call: { id: 'call_one', participant: 'device:pc', name: 'You' } } });
  const spoken = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(spoken.status, 'done');
  assert.equal(h.chats.message(spoken.messageId!)?.meta.call?.id, 'call_one');
  assert.ok(h.items.some(item => {
    const data = item.data as Record<string, unknown> | undefined;
    return item.kind === 'note' && data?.commentary === true && data.text === 'Checking the plan.';
  }));
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Typed question' });
  const typed = await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_2' }));
  assert.equal(h.chats.message(typed.messageId!)?.meta.call, undefined);
});

test('the subconscious gets the mode the turn runs in, before and after it', async () => {
  const h = setup();
  const seen: Array<[string, string | undefined]> = [];
  Object.assign(h.services, {
    router: { route: async () => h.route },
    modes: { get: (key: string) => (key === 'video' ? { ...GENERAL_MODE, key: 'video' } : GENERAL_MODE) },
    subconscious: {
      beforeTurn: async (input: { mode?: string }) => { seen.push(['before', input.mode]); return undefined; },
      afterTurn: (input: { mode?: string }) => { seen.push(['after', input.mode]); },
    },
  });
  h.chats.update(h.chat.id, { settings: { mode: 'video' } }, 'human');
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Cut the intro' });
  const outcome = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(outcome.status, 'done');
  assert.deepEqual(seen, [['before', 'video'], ['after', 'video']], 'the chat\'s mode (plan.mode.key), not the agent\'s general');
});

test('a model.set request reaches the router as an explicit previous choice, once', async () => {
  const h = setup();
  h.runs.push({ id: 'run_0', agentId: h.tom.id, conversationId: h.chat.id, model: 'codex:gpt-6.1-sol', effort: 'low', status: 'done' });

  setNextRoute(h.db, h.tom.id, h.chat.id, { modelId: 'claude:claude-opus-5-5', effort: 'high', at: h.clock.now() });
  const asked = (await planTurn(h.services, h.request()))!;
  assert.deepEqual(asked.previous, { modelId: 'claude:claude-opus-5-5', effort: 'high', explicit: true });
  assert.equal(routeRequest(asked).previous?.explicit, true);

  // Effort only: the new effort, still the agent's own choice; the model follows the usual rules (RT2).
  setNextRoute(h.db, h.tom.id, h.chat.id, { effort: 'xhigh', at: h.clock.now() });
  assert.deepEqual((await planTurn(h.services, h.request()))!.previous, { modelId: 'codex:gpt-6.1-sol', effort: 'xhigh', explicit: true, asked: 'effort' });

  // The request was consumed: the plain return rule is not explicit.
  const plain = (await planTurn(h.services, h.request()))!;
  assert.deepEqual(plain.previous, { modelId: 'codex:gpt-6.1-sol', effort: 'low' });
  assert.equal(routeRequest(plain).previous?.explicit, undefined);
});

test('intermediate text before tools never becomes a final answer when no final text arrives', async () => {
  const h = setup();
  h.services.router = { route: async () => h.route } as typeof h.services.router;
  h.state.script = async input => {
    input.onEvent({ type: 'text', delta: 'Checking the files.' });
    input.onEvent({ type: 'commentary', text: 'Checking the files.' });
    return { text: '', stop: 'done' };
  };
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Check it' });
  const result = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(result.status, 'done');
  assert.equal(result.messageId, undefined);
  assert.ok(!h.chats.messages(h.chat.id, { limit: 50 }).some(message => message.authorId === h.tom.id && message.body === 'Checking the files.'));
});

test('no model can read images: the turn runs without them and the agent is told; other routing errors still fail', async () => {
  const h = setup({ images: true });
  h.chats.send({ conversationId: h.chat.id, body: 'Our logo', authorId: 'human', attachments: [{ fileId: 'a'.repeat(64), name: 'logo.png', mime: 'image/png', size: 10 }] });
  h.context.delta = (input) => ({ text: 'Sam: Our logo\n[Image: logo.png]', images: [{ path: 'blobs/aa', mime: 'image/png' }], lastSeq: input.sinceSeq });
  const asked: Array<boolean | undefined> = [];
  let fail = (needs: RouteRequest['needs']): WorkforceError | undefined =>
    (needs?.vision ? new WorkforceError('unavailable', 'No connected model can read images.', { details: { need: 'vision' } }) : undefined);
  Object.assign(h.services, {
    router: { route: async (request: RouteRequest) => { asked.push(request.needs?.vision); const error = fail(request.needs); if (error) throw error; return h.route; } },
  });
  let seen: EngineTurnInput | undefined;
  h.state.script = async (input) => { seen = input; return { text: 'I cannot see the logo yet.', stop: 'done' }; };

  const outcome = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(outcome.status, 'done', 'the chat is not blocked');
  assert.deepEqual(asked, [true, undefined], 'asked with vision first, then without');
  assert.ok(seen && !seen.input.some((part) => part.type === 'image'), 'no image input');
  assert.match((seen!.input[0] as { text: string }).text, /cannot see the images in this chat right now/);
  assert.ok(h.items.some((item) => item.kind === 'note' && (item.data as { imagesHidden?: boolean }).imagesHidden), 'the run records it');

  // A model that can see them gets the images as before.
  asked.length = 0;
  fail = () => undefined;
  h.chats.send({ conversationId: h.chat.id, body: 'And the banner', authorId: 'human', attachments: [{ fileId: 'b'.repeat(64), name: 'banner.png', mime: 'image/png', size: 10 }] });
  await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_2' }));
  assert.deepEqual(asked, [true]);
  assert.ok(seen!.input.some((part) => part.type === 'image'));

  // Any other routing failure still ends the turn before the engine.
  fail = () => new WorkforceError('unavailable', 'No connected model fits the model policy of Tom.');
  h.chats.send({ conversationId: h.chat.id, body: 'One more', authorId: 'human', attachments: [{ fileId: 'c'.repeat(64), name: 'c.png', mime: 'image/png', size: 10 }] });
  const blocked = await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_3' }));
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error, 'No connected model fits the model policy of Tom.');
});

test('attachments are extracted before the delta; a failed extraction does not stop the turn', async () => {
  const h = setup();
  const plan = (await planTurn(h.services, h.request()))!;
  const turn = await buildTurn(h.services, plan, h.request(), h.route, []);
  assert.deepEqual(h.contextCalls, [`prepare:${h.chat.id}:${plan.memberCursor}`, 'delta']);
  assert.match((turn.input[0] as { text: string }).text, /attached PDF/);

  h.contextCalls.length = 0;
  h.context.prepare = async () => { h.contextCalls.push('prepare'); throw new Error('broken PDF'); };
  const again = await buildTurn(h.services, plan, h.request(), h.route, []);
  assert.deepEqual(h.contextCalls, ['prepare', 'delta']);
  assert.match((again.input[0] as { text: string }).text, /attached PDF/);

  // Without a chat there is nothing to prepare.
  h.contextCalls.length = 0;
  const solo = (await planTurn(h.services, h.request({ conversationId: undefined })))!;
  await buildTurn(h.services, solo, h.request({ conversationId: undefined }), h.route, []);
  assert.deepEqual(h.contextCalls, []);
});

test('last-prompt.md holds what is sent: stable, volatile and the "My final text" line', async () => {
  const h = setup();
  const temp = tempDir('wf-last-turn-');
  try {
    mkdirSync(path.join(temp.dir, 'agents', h.tom.id), { recursive: true });
    Object.assign(h.services.paths, { data: temp.dir });
    const plan = (await planTurn(h.services, h.request()))!;
    const turn = await buildTurn(h.services, plan, h.request(), h.route, []);
    const written = readFileSync(path.join(temp.dir, 'agents', h.tom.id, 'last-prompt.md'), 'utf8');
    assert.match(turn.prompt.volatile ?? '', /My final text/);
    assert.ok(written.includes(turn.prompt.stable));
    assert.ok(written.includes(turn.prompt.volatile ?? ''), written);
  } finally { temp.cleanup(); }
});

test('workforce tools called through the MCP hub count as tool calls, so no failover re-runs them', async () => {
  const h = setup();
  const plan = (await planTurn(h.services, h.request()))!;
  const signal = new AbortController().signal;

  // Claude/ACP agents: the hub executes the tool; the engine only reports tool_start own:false.
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'toolu_1', name: 'tasks.create', args: {}, own: false });
    input.onEvent({ type: 'tool_end', callId: 'toolu_1', ok: true, summary: 'created' });
    return LIMIT;
  };
  const viaHub = await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.equal(viaHub.toolCalls, 1);
  assert.equal(canFailover(viaHub, signal), false);

  // Dynamic tools: tool_start and callTool of the same call count once.
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_start', callId: 'call_1', name: 'tasks.create', args: {}, own: false });
    await input.callTool('tasks.create', {}, 'call_1');
    input.onEvent({ type: 'tool_end', callId: 'call_1', ok: true, summary: 'created' });
    await input.callTool('tasks.list', {}, 'call_2');
    return LIMIT;
  };
  const dynamic = await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.equal(dynamic.toolCalls, 2);
  assert.equal(canFailover(dynamic, signal), false);

  // Nothing ran yet: an account limit may move to another account.
  h.state.script = async () => LIMIT;
  const quiet = await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.equal(quiet.toolCalls, 0);
  assert.equal(canFailover(quiet, signal), true);
});

test('repeated starts of one engine tool are journaled once; a tool whose start was missed still blocks failover', async () => {
  const h = setup({ dynamicTools: false });
  const plan = (await planTurn(h.services, h.request()))!;
  const signal = new AbortController().signal;

  // An engine may send a 'running' update for every metadata change of a long command.
  h.state.script = async (input) => {
    for (let i = 0; i < 3; i++) input.onEvent({ type: 'tool_start', callId: 'prt_1', name: 'bash', args: { command: 'npm test' }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'prt_1', ok: true, summary: 'passed' });
    return { text: 'ok', stop: 'done' };
  };
  const repeated = await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.equal(repeated.toolCalls, 1);
  assert.deepEqual(h.items.map((item) => item.kind), ['tool_call', 'tool_result']);

  // Only the end of a hub call arrived (e.g. 'running' was never sent): a tool still ran.
  h.state.script = async (input) => {
    input.onEvent({ type: 'tool_end', callId: 'prt_2', ok: true, summary: 'created' });
    return LIMIT;
  };
  const endOnly = await runAttempt(h.services, plan, h.routed(), h.request(), undefined);
  assert.equal(endOnly.toolCalls, 1);
  assert.equal(canFailover(endOnly, signal), false);
});

test('an account limit reported as an error reaches ownership as a limit, not as a failed attempt', async () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  const outcomes: string[] = [];
  Object.assign(h.services, { ownership: { afterTurn: (input: { outcome: string }) => { outcomes.push(input.outcome); } } });
  const cases: EngineTurnResult[] = [
    { text: '', stop: 'error', error: { code: 'rate_limited', message: 'Too many requests.' } },
    LIMIT,
    { text: '', stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } },
  ];
  for (const [index, result] of cases.entries()) {
    const request = h.request({ runId: `run_${index + 1}`, taskId: task.id });
    const plan = (await planTurn(h.services, request))!;
    finishTurn(h.services, plan, h.routed(), request, h.attempt(result), undefined);
  }
  assert.deepEqual(outcomes, ['limit', 'limit', 'failed']);
});

test('engine output files reach the message; an answer that is only an image is kept, not removed', async () => {
  const h = setup();
  const request = h.request({ runId: 'run_files' });
  const plan = (await planTurn(h.services, request))!;
  const messageId = h.chats.beginAgentMessage(h.chat.id, h.tom.id, request.runId).id;
  const calls: Array<{ body: string; files?: unknown[] }> = [];
  const real = h.services.chats.finishAgentMessage.bind(h.services.chats);
  h.services.chats.finishAgentMessage = (id, final) => { calls.push({ body: final.body, files: final.files }); return real(id, { ...final, files: undefined }); };
  const image = { name: 'generated-image-1.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' };
  finishTurn(h.services, plan, h.routed(), request, h.attempt({ text: '', stop: 'done', files: [image] }), messageId);
  assert.deepEqual(calls, [{ body: '', files: [image] }], 'files are handed to the chat with the final message');
  assert.ok(h.chats.messages(h.chat.id).some((message) => message.id === messageId), 'the message stays');

  // Without text and without files an empty answer is still removed.
  const again = h.request({ runId: 'run_empty' });
  const second = h.chats.beginAgentMessage(h.chat.id, h.tom.id, again.runId).id;
  finishTurn(h.services, (await planTurn(h.services, again))!, h.routed(), again, h.attempt({ text: '', stop: 'done' }), second);
  assert.ok(!h.chats.messages(h.chat.id).some((message) => message.id === second));
});

test('a failover after tool calls books both attempts: tools, plan, tokens and cost (regression)', async () => {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const spends: number[] = [];
  const afterTurn: Array<{ progressed?: boolean; approach?: string; plan?: string[] }> = [];
  Object.assign(h.services, {
    runs,
    tools: { ...h.services.tools, get: (name: string) => (name === 'files.write' ? { category: 'write_local' } : undefined) },
    spend: { record: (input: { amount: number }) => { spends.push(input.amount); } },
    ownership: { afterTurn: (input: { progressed?: boolean; approach?: string; plan?: string[] }) => { afterTurn.push(input); } },
    // API-key accounts: both attempts are real charges (a plan login books nothing, PR9 pricing.test.ts).
    accounts: { get: (id: string) => ({ ...h.account, id, auth: 'api_key' }), updateLimits: () => {}, markLimited: () => {}, candidates: () => [] },
    router: { route: async (request: RouteRequest) => ({ ...h.route, accountId: request.exclude?.includes('acc_1') ? 'acc_2' : 'acc_1' }) },
  });
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Write the notes', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.state.script = async (input) => {
    if (input.account.id === 'acc_1') {
      input.onEvent({ type: 'plan', steps: [{ text: 'Write notes.md', status: 'active' }] });
      input.onEvent({ type: 'tool_start', callId: 'call_1', name: 'files.write', args: {}, own: false });
      runs.item(input.runId, { kind: 'tool_call', name: 'files.write', data: { callId: 'call_1', summary: 'Write notes.md' }, effectStatus: 'none' }); // what the registry journals
      runs.item(input.runId, { kind: 'tool_result', name: 'files.write', data: { callId: 'call_1', ok: true }, effectStatus: 'none' });
      return { ...LIMIT, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 } };
    }
    return { text: 'Notes are written.', stop: 'done', usage: { inputTokens: 400, outputTokens: 50, costUsd: 0.25 } };
  };

  const outcome = await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_merge', taskId: task.id, reason: 'retry' }));
  assert.equal(outcome.status, 'done');
  assert.equal(afterTurn.length, 1);
  assert.equal(afterTurn[0].progressed, true, 'the write of the first attempt counts as progress');
  assert.match(afterTurn[0].approach ?? '', /used files\.write/);
  assert.deepEqual(afterTurn[0].plan, ['Write notes.md'], "the first attempt's plan is kept");
  assert.deepEqual(spends, [0.75], 'both attempts are booked');
  const run = runs.get('run_merge')!;
  assert.deepEqual([run.inputTokens, run.outputTokens, run.costUsd, run.accountId], [1400, 150, 0.75, 'acc_2']);

  const merged = mergeAttempts(
    h.attempt(LIMIT, { toolCalls: 1, tools: [{ name: 'bash', native: true }], usage: { inputTokens: 5, outputTokens: 1, contextTokens: 90 }, ms: 7 }),
    h.attempt({ text: 'ok', stop: 'done' }, { usage: { inputTokens: 3, outputTokens: 2, contextTokens: 20 }, ms: 4 }),
  );
  assert.deepEqual([merged.toolCalls, merged.tools?.map((use) => use.name), merged.usage, merged.ms, merged.result.stop], [1, ['bash'], { inputTokens: 8, outputTokens: 3, contextTokens: 20 }, 4, 'done'],
    'the second attempt\'s context size and time (its session and model), no cost when none was reported');
  assert.deepEqual(merged.lastUsage, { inputTokens: 3, outputTokens: 2, contextTokens: 20 }, "the second attempt's own usage");
});

test('a failed or refused call of ours is no progress: its output decides, else tool_end (regression)', async () => {
  const h = setup();
  const afterTurn: Array<{ progressed?: boolean }> = [];
  const outputs: Record<string, { content: Array<{ type: 'text'; text: string }>; isError?: boolean; effect?: { status: 'unknown' } }> = {
    'files.write': { content: [{ type: 'text', text: 'Not allowed by your permissions.' }], isError: true },
    'shell.exec': { content: [{ type: 'text', text: 'The command may have run.' }], isError: true, effect: { status: 'unknown' } },
  };
  Object.assign(h.services, {
    tools: { ...h.services.tools, get: (name: string) => ({ category: name.startsWith('tasks.') ? 'think' : 'write_local' }), call: async (name: string) => outputs[name] ?? { content: [{ type: 'text', text: 'ok' }] } },
    ownership: { afterTurn: (input: { progressed?: boolean }) => { afterTurn.push(input); } },
  });
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Write the notes', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  const turnWith = async (runId: string, script: (input: EngineTurnInput) => Promise<void>) => {
    const request = h.request({ runId, taskId: task.id, reason: 'retry' });
    const plan = (await planTurn(h.services, request))!;
    h.state.script = async (input) => { await script(input); return { text: 'Trying again later.', stop: 'done' }; };
    const attempt = await runAttempt(h.services, plan, h.routed(), request, undefined);
    finishTurn(h.services, plan, h.routed(), request, attempt, undefined);
    return { tools: attempt.tools?.map((use) => [use.name, use.ok]), progressed: afterTurn.at(-1)?.progressed };
  };

  // A refused dynamic call (its output) and a failed hub call (only tool_end) change nothing.
  const refused = await turnWith('run_refused', async (input) => {
    await input.callTool('files.write', {}, 'call_1');
    input.onEvent({ type: 'tool_start', callId: 'toolu_2', name: 'tasks.create', args: {}, own: false });
    input.onEvent({ type: 'tool_end', callId: 'toolu_2', ok: false, summary: 'Invalid arguments' });
  });
  assert.deepEqual(refused, { tools: [['files.write', false], ['tasks.create', false]], progressed: false });

  // Succeeded calls, and an unknown external effect (it may have happened), are activity (B-059: 'busy' – no outcome by itself).
  const ran = await turnWith('run_ran', async (input) => {
    await input.callTool('shell.exec', {}, 'call_3');
    input.onEvent({ type: 'tool_end', callId: 'call_3', ok: false, summary: 'unknown' }); // the output decided already
    input.onEvent({ type: 'tool_start', callId: 'toolu_4', name: 'tasks.create', args: {}, own: false });
    input.onEvent({ type: 'tool_end', callId: 'toolu_4', ok: true, summary: 'created' });
  });
  assert.deepEqual(ran, { tools: [['shell.exec', true], ['tasks.create', true]], progressed: true });
});

test('B-047: a bare task wake for work its owner set aside starts no turn; a note brings it back; an empty input is the app\'s note', async () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Compare STT models', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: h.tom.id });
  // The person said "stop": the owner set its own task to waiting while the creation's task wake was still queued.
  h.tasks.setStatus(task.id, 'waiting', h.tom.id, 'Stopped at the person\'s request.');
  assert.equal(await planTurn(h.services, h.request({ taskId: task.id, reason: 'task' })), undefined, 'the stale wake restarts nothing');
  for (const status of ['blocked', 'needs_you'] as const) {
    h.tasks.setStatus(task.id, status, h.tom.id, 'set aside');
    assert.equal(await planTurn(h.services, h.request({ taskId: task.id, reason: 'task' })), undefined, status);
  }
  h.tasks.setStatus(task.id, 'waiting', h.tom.id, 'Stopped.');
  const news = await planTurn(h.services, h.request({ taskId: task.id, reason: 'task', notes: [{ text: 'The human marked a step as done: Draft', at: h.clock.now() }] }));
  assert.ok(news, 'a wake with news still runs');
  h.tasks.setStatus(task.id, 'working', h.tom.id);
  const plan = (await planTurn(h.services, h.request({ taskId: task.id, reason: 'task' })))!;
  assert.ok(plan, 'work in progress still continues');
  h.context.delta = () => { h.contextCalls.push('delta'); return { text: '', images: [], lastSeq: 0 }; };
  const turn = await buildTurn(h.services, plan, h.request({ taskId: task.id, reason: 'task' }), h.route, []);
  const text = (turn.input[0] as { text: string }).text;
  assert.match(text, /^Note from the app – nobody wrote anything new: my task \S+ "Compare STT models" is working;/);
  assert.doesNotMatch(text, /^Continue your task/);
});
