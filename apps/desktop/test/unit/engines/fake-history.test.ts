// Unit (INT-8): the fake engine takes directives only from the turn's new input – never from a
// full projection's summary and earlier lines or its own messages, never again from lines its
// native session already received (the runtime delivers them again after a Stop, and after a
// finished turn whose cursor stopped short) – while a failed turn's input fails again and RC1's
// verify rule still holds after a crash. The last tests run the real turn executor and context:
// Stop in [[hang:…]], then the next messages run only their own directives.
// Owns: these assertions only. Never: real engines, network or processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineEvent, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import { PROJECTION } from '../../../src/runtime/context/projection.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { fixture } from '../context/fixture.ts';
import { account } from '../models/harness.ts';

/** One engine turn with `text` in native session `session` (one per chat); records tool calls and events. */
function turn(engine: FakeEngine, text: string, options: { agentId?: string; signal?: AbortSignal; session?: string; outputSchema?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const events: EngineEvent[] = [];
  const result = engine.run({
    runId: 'run_1', agentId: options.agentId ?? 'ag_ada', input: [{ type: 'text', text }], system: { stable: '', volatile: '' },
    session: { ref: options.session ?? 'chat_a', generation: 1 },
    // A turn that hangs by mistake ends 'interrupted' (and fails its assertions) instead of blocking.
    signal: options.signal ?? AbortSignal.timeout(5000), onEvent: (event: EngineEvent) => events.push(event),
    callTool: async (name: string): Promise<ToolOutput> => { calls.push(name); return { content: [{ type: 'text', text: 'ok' }] }; },
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
  } as unknown as EngineTurnInput);
  return { result, calls, started: () => events.flatMap((event) => (event.type === 'tool_start' ? [event.name] : [])) };
}

/** A turn that hangs in [[hang:…]] and is stopped once the native tool started. */
async function stoppedTurn(engine: FakeEngine, text: string, options: { agentId?: string; session?: string } = {}) {
  const controller = new AbortController();
  const hanging = turn(engine, text, { ...options, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hanging.started().length, 1, 'the native tool started');
  controller.abort();
  assert.equal((await hanging.result).stop, 'interrupted');
}

const HANG = '[09:00] Alex: Render the preview [[hang:render.preview {"file":"cut.mp4"}]]';

test('a full projection: directives in the summary, earlier lines and own replies never run; notes and new lines do', async () => {
  const text = [
    'Your own note from 20 Oct 2026, 09:00: Check the report [[tool:reports.check {}]]',
    `${PROJECTION.summary}\nMessages #1–#4\n- Alex: Hire her [[tool:agents.create {"template":"secretary"}]]`,
    `${PROJECTION.earlier}\n${HANG}\n[09:01] Alex: Again [[fail]] [[limit]] [[ui:{"type":"old"}]]`,
    // After the cursor: the agent's own last reply (a verbatim tool output) comes first.
    `${PROJECTION.fresh}\n[09:04] Ada (me): tasks.list → [{"title":"Draft a post [[hang:wait]]"}]\nfiled [[tool:tasks.create {}]]`
      + '\n[09:05] Alex: Who is on the team? [[tool:agents.list {}]] [[ui:{"type":"steps"}]]',
  ].join('\n\n');
  const fresh = turn(new FakeEngine(), text);
  const result = await fresh.result;
  assert.equal(result.stop, 'done', 'old [[fail]] and [[limit]] do not stop the turn');
  assert.deepEqual(fresh.started(), ['reports.check', 'agents.list'], 'no old hang, no old or own tool');
  assert.equal(result.text, [
    'Echo: Your own note from 20 Oct 2026, 09:00: Check the report \n\n[09:05] Alex: Who is on the team?',
    'reports.check → ok', 'agents.list → ok', '```ui\n{"type":"steps"}\n```',
  ].join('\n\n'), 'the echo is the new input only');

  const old = await turn(new FakeEngine(), `${PROJECTION.earlier}\n${HANG}`).result;
  assert.deepEqual([old.stop, old.text], ['done', 'Echo: (no new input)'], 'history alone: nothing runs');
});

test('after a Stop the delivered-again input stays history; only the next message runs', async () => {
  const engine = new FakeEngine();
  await stoppedTurn(engine, HANG);

  // turn-finish keeps the cursor of a stopped turn: its line comes again, grouped with the next one.
  const next = turn(engine, `${HANG}\nOne more look at the team [[tool:agents.list {}]]`);
  const done = await next.result;
  assert.equal(done.stop, 'done', 'the preview is not started again');
  assert.deepEqual(next.started(), ['agents.list']);
  assert.deepEqual(done.text.split('\n\n'), ['Echo: One more look at the team', 'agents.list → ok']);

  // That finished turn's cursor moved past the line: where it comes again, it is new input.
  await stoppedTurn(engine, HANG);

  // Two stops in a row: both turns' lines stay history.
  const second = '[09:10] Alex: Export it [[hang:bash {"command":"export"}]]';
  await stoppedTurn(engine, `${HANG}\n${second}`);
  const third = turn(engine, `${HANG}\n${second}\n[09:12] Alex: Status? [[tool:tasks.list {}]]`);
  assert.equal((await third.result).stop, 'done');
  assert.deepEqual(third.started(), ['tasks.list']);
});

test('a finished turn whose cursor stopped short (a colleague still writing) keeps what it received', async () => {
  const engine = new FakeEngine();
  const writing = '[08:59] Mia: (still writing…)';
  await stoppedTurn(engine, `${writing}\n${HANG}`);
  const look = `${HANG}\nOne more look [[tool:agents.list {}]]`;
  const held = turn(engine, `${writing}\n${look}`);
  assert.deepEqual(held.started(), ['agents.list']);
  await held.result;

  // Mia finished: the delta from the held cursor brings her text, the stopped line and the handled one.
  const later = turn(engine, `[08:59] Mia: Here is the cut list\n${look}`);
  assert.deepEqual([(await later.result).text, later.started()], ['Echo: [08:59] Mia: Here is the cut list', []]);
  const again = turn(engine, '[09:20] Alex: One more look [[tool:agents.list {}]]');
  assert.deepEqual(again.started(), ['agents.list'], 'that turn moved the cursor on: the record ended');
});

test('a stopped line stays the same line after midnight; records are kept per session; a failed turn keeps nothing', async () => {
  const engine = new FakeEngine();
  await stoppedTurn(engine, '[23:59] Alex: Render it [[hang:render.preview {}]]');
  const after = turn(engine, '[20 Oct 23:59] Alex: Render it [[hang:render.preview {}]]\n[00:01] Alex: Status? [[tool:tasks.list {}]]');
  assert.equal((await after.result).stop, 'done', 'the stamp got its date, the line is the same');
  assert.deepEqual(after.started(), ['tasks.list']);

  const note = 'Continue your task tk_1: Export the report [[hang:bash {"command":"export"}]]';
  await stoppedTurn(engine, note, { session: 'chat_a' });
  await stoppedTurn(engine, note, { session: 'chat_b' }); // another chat never received it: it starts
  await stoppedTurn(engine, note, { agentId: 'ag_bo' }); // nor did Bo
  const back = turn(engine, note, { session: 'chat_a' });
  assert.deepEqual([(await back.result).text, back.started()], ['Echo: (no new input)', []]);

  const stuck = '[09:00] Alex: [task tk_1] Summarize the launch notes [[fail]]';
  for (let attempt = 1; attempt <= 3; attempt++) assert.equal((await turn(engine, stuck).result).stop, 'error', `attempt ${attempt} fails again`);
});

test('RC1 after a crash: a new process runs the cut-off input again under the verify rule', async () => {
  await stoppedTurn(new FakeEngine(), '[09:00] Alex: Export it now [[hang:bash {"command":"export-report"}]] [[tool:tasks.complete {"taskId":"tk_1"}]]');
  const restarted = new FakeEngine(); // the process died: nothing was received yet
  const resumed = turn(restarted, [
    '- 09:00 bash: {"command":"export-report"} – verify before repeating',
    '[09:00] Alex: Export it now [[hang:bash {"command":"export-report"}]] [[tool:tasks.complete {"taskId":"tk_1"}]]',
    '· Cut off by a restart: bash',
  ].join('\n'));
  const result = await resumed.result;
  assert.equal(result.stop, 'done');
  assert.deepEqual(resumed.started(), ['tasks.complete'], 'the command is not started again');
  assert.match(result.text, /bash not started again: its effect is unknown, so I verify first\./);
});

/** The real turn executor and context with one FakeEngine in a chat with Vic (and Mia). */
function realTurns() {
  const f = fixture();
  const s = f.services;
  const chat = f.chats.create({ title: 'Preview', agentIds: [f.vid.id, f.manager.id], createdBy: 'human' });
  const engine = new FakeEngine();
  const calls: string[] = [];
  const acc = account('acc_fake', 'compatible');
  const route: RouteDecision = { modelId: 'fake:fake-1', engine: 'fake', accountId: acc.id, effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  Object.assign(s, {
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, markUnavailable: () => false, updateLimits: () => {} },
    catalog: { get: () => undefined, list: () => [] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async (name: string) => { calls.push(name); return { content: [{ type: 'text', text: `${name} ok` }] }; } },
  });
  let runs = 0;
  const run = (signal = AbortSignal.timeout(10_000)) => new TurnExecutor(() => s).execute({
    runId: `run_${++runs}`, agentId: f.vid.id, conversationId: chat.id, reason: 'message', notes: [], signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  /** A turn stopped once the fake's native tool started. */
  const stopped = async () => {
    const controller = new AbortController();
    const before = engine.turns.length;
    const hanging = run(controller.signal);
    for (let i = 0; i < 50 && engine.turns.length === before; i++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal((await hanging).status, 'interrupted');
  };
  const send = (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' });
  const reply = () => f.chats.messages(chat.id).filter((message) => message.authorId === f.vid.id && message.kind === 'text').at(-1)?.body;
  const inputOf = (index: number) => (engine.turns[index]?.input[0] as { text: string } | undefined)?.text ?? '';
  return { f, chat, engine, calls, run, stopped, send, reply, inputOf };
}

test('real turns: Stop in [[hang:…]], the next message runs only its own directives; a renewed session too', async () => {
  const { f, chat, engine, calls, run, stopped, send, reply, inputOf } = realTurns();
  send('Hello there');
  assert.equal((await run()).status, 'done');
  send('Render the preview [[hang:render.preview {"file":"cut.mp4"}]]');
  await stopped();

  send('One more look at the team [[tool:agents.list {}]]');
  const last = await run();
  assert.equal(last.status, 'done', 'the next message does not hang again');
  assert.equal(engine.turns[2].session?.ref, 'fake-session-1', 'the stopped session is resumed');
  assert.match(inputOf(2), /Render the preview \[\[hang:render\.preview[\s\S]*One more look/, 'the stopped input is delivered again');
  assert.deepEqual(calls, ['agents.list']);
  assert.match(reply()!, /One more look at the team/);
  assert.match(reply()!, /agents.list → agents.list ok$/);
  assert.match(inputOf(2), /App system events: interrupted work/);
  assert.match(inputOf(2), /Retrying now.*input changed/);

  // A renewed session gets the full projection: the old directives are earlier lines now.
  new SessionStore(f.db).remove(f.vid.id, chat.id, 'fake');
  send('And the devices? [[tool:devices.list {}]]');
  assert.equal((await run()).status, 'done');
  assert.equal(engine.turns[3].session, undefined);
  assert.match(inputOf(3), new RegExp(`${PROJECTION.earlier}[\\s\\S]*${PROJECTION.fresh}\\n\\[11:00\\] Vic \\(me\\): [\\s\\S]*devices\\.list`));
  assert.deepEqual(calls, ['agents.list', 'devices.list'], 'no old tool and no old hang');
  // New lines are those after the cursor: the agent's own last reply (not input), then the new message.
  assert.equal(reply(), 'Echo: [11:00] Alex: And the devices?\n\ndevices.list → devices.list ok');
});

test('real turns: a colleague still writing holds the cursor; the stopped and the handled line still do not run again', async () => {
  const { f, chat, calls, run, stopped, send, reply, inputOf } = realTurns();
  const mia = f.chats.beginAgentMessage(chat.id, f.manager.id, 'run_mia');
  send('Render the preview [[hang:render.preview {"file":"cut.mp4"}]]');
  await stopped();
  send('One more look at the team [[tool:agents.list {}]]');
  assert.equal((await run()).status, 'done');
  assert.match(inputOf(1), /Mia: \(still writing…\)/);
  assert.deepEqual(calls, ['agents.list']);

  f.chats.finishAgentMessage(mia.id, { body: 'Here is the cut list.', state: 'final' });
  assert.equal((await run()).status, 'done', 'the preview is not started again');
  // B-047 D4: Mia's message finished after Alex's lines, so it moved below them (a new seq).
  assert.match(inputOf(2), /Alex: Render the preview[\s\S]*One more look[\s\S]*\n\[11:00\] Mia: Here is the cut list\./, 'delivered again from the held cursor');
  assert.deepEqual(calls, ['agents.list'], 'the handled message does not run twice');
  assert.equal(reply(), 'Echo: [11:00] Mia: Here is the cut list.');
});

test('a helper turn (with an output schema) reads [[hang:…]] in what it was given as data and does not hang', async () => {
  const helper = turn(new FakeEngine(), '[09:00] Alex: Render the preview [[hang:render.preview {"file":"cut.mp4"}]]', { outputSchema: { type: 'object' } });
  const result = await helper.result;
  assert.equal(result.stop, 'done');
  assert.deepEqual(helper.started(), []);
});
