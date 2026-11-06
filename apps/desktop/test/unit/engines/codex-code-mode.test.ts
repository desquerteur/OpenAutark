// B-049 F9 – Codex code mode over a scripted app-server: an agent thread/start asks for raw Responses items
// (experimentalRawEvents; never on thread/resume or a helper thread; a refusal is remembered per server process); the
// turn's raw exec call becomes a native tool_start/tool_end (the printed text with its header as output), a wait call
// too; calls made inside a script ("exec-" ids – ours and Codex's own) are marked nested with the open script as parent;
// raw items of an injection or of another tool are ignored (no duplicates); a script still open at the end ends with
// what it printed.
// Owns: these assertions only. Never starts a real binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { CodeCalls, codeOutputText, hostMissingText } from '../../../src/runtime/engines/code-mode.ts';
import { openAgentThread } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { RpcError } from '../../../src/runtime/engines/codex/rpc.ts';
import type { EngineEvent } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from './fakes.ts';

const SOURCE = 'const r = await tools.tasks__create({title:"A"});\ntext(r);\n';
const HEADER = 'Script completed\nWall time 0.1 seconds\nOutput:\n';

interface Options { refuseRaw?: boolean; onTurn?: (child: FakeChild, threadId: string) => void; onAnswer?: (child: FakeChild, msg: any) => void; refuseCustom?: boolean }

function appServer(options: Options = {}) {
  const requests: any[] = [];
  let threads = 0;
  let thread = '';
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) { if (msg.id !== undefined) options.onAnswer?.(child, msg); return; }
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0-alpha.1.2 (x)' } }); break;
        case 'thread/start':
          if (options.refuseRaw && msg.params.experimentalRawEvents) { child.send({ id: msg.id, error: { code: -32602, message: 'unknown field `experimentalRawEvents`' } }); break; }
          child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } });
          break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/inject_items':
          if (options.refuseCustom && msg.params.items.some((item: any) => item.type === 'custom_tool_call')) child.send({ id: msg.id, error: { code: -32600, message: 'unknown variant `custom_tool_call`' } });
          else child.send({ id: msg.id, result: {} });
          break;
        case 'thread/items/list': child.send({ id: msg.id, result: { data: [], nextCursor: null } }); break;
        case 'thread/delete': case 'thread/unsubscribe': child.send({ id: msg.id, result: {} }); break;
        case 'turn/start':
          thread = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          // A real model answers long after turn/start: the client knows its turn id by then.
          if (options.onTurn) { const onTurn = options.onTurn; setTimeout(() => onTurn(child, thread), 5); } else done(child, thread);
          break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const raw = (child: FakeChild, threadId: string, item: Record<string, unknown>, turnId = 'turn_1') =>
  child.send({ method: 'rawResponseItem/completed', params: { threadId, turnId, item } });
const done = (child: FakeChild, threadId: string) => {
  child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'ok' } } });
  child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
};
const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });

test('an agent thread/start asks for raw items; resume and helper threads do not', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_1' }).input);
  assert.equal(fake.sent('thread/start')[0].params.experimentalRawEvents, true);
  await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_old', generation: 2 } }).input);
  assert.equal('experimentalRawEvents' in fake.sent('thread/resume')[0].params, false, 'thread/resume has no such field');
  await e.run(turnInput({ runId: 'run_3', tools: [] }).input);
  assert.equal('experimentalRawEvents' in fake.sent('thread/start')[1].params, false, 'a helper thread needs none');
  await e.dispose();
});

test('a Codex that refuses experimentalRawEvents opens the lean thread without it, remembered per server process', async () => {
  const fake = appServer({ refuseRaw: true });
  const e = engineOf(fake.spawn);
  assert.equal((await e.run(turnInput({ runId: 'run_1' }).input)).stop, 'done');
  const starts = fake.sent('thread/start');
  assert.deepEqual(starts.map((s) => [Boolean(s.params.experimentalRawEvents), s.params.config?.include_environment_context === false]), [[true, true], [true, false], [false, true]],
    'lean+raw, today\'s+raw (both refused), then lean without the field');
  await e.run(turnInput({ runId: 'run_2', input: [{ type: 'text', text: 'again' }] }).input);
  assert.equal(fake.sent('thread/start').length, 4, 'the next thread goes straight to the lean thread without the field');
  assert.equal('experimentalRawEvents' in fake.sent('thread/start')[3].params, false);
  assert.equal(fake.sent('thread/start')[3].params.config.include_environment_context, false, 'still lean');
  await e.dispose();
});

test('openAgentThread: a lean refusal alone keeps the field; a timeout never falls back', async () => {
  const sent: any[] = [];
  const leanRefused = { request: async (_m: string, params: any) => { sent.push(params); if (params.config?.include_environment_context === false) throw new RpcError(-32602, 'unknown variant'); return { thread: { id: 't' } }; } };
  const lean = new Set<string>();
  const rawSet = new Set<string>();
  await openAgentThread(leanRefused as any, 'thread/start', { cwd: '/w' }, lean, 'acc', rawSet);
  assert.deepEqual(sent.map((p) => Boolean(p.experimentalRawEvents)), [true, true]);
  assert.ok(lean.has('acc'), 'the lean settings are remembered as refused');
  assert.equal(rawSet.size, 0, 'the field was not the problem');
  const timeout = { request: async () => { throw new RpcError(-32000, 'codex did not answer'); } };
  await assert.rejects(openAgentThread(timeout as any, 'thread/start', { cwd: '/w' }, new Set(), 'acc', rawSet), /did not answer/);
  assert.equal(rawSet.size, 0);
});

test('a raw exec call becomes a native tool call; calls inside it are nested under it; injections and other raw items are ignored', async () => {
  const fake = appServer({
    onTurn: (child, threadId) => {
      raw(child, threadId, { type: 'custom_tool_call', name: 'exec', call_id: 'call_inj', input: 'old' }, 'auto-compact-0'); // an injection's item
      raw(child, threadId, { type: 'reasoning', summary: [] });
      raw(child, threadId, { type: 'custom_tool_call', name: 'exec', call_id: 'call_x1', input: SOURCE });
      child.send({ id: 900, method: 'item/tool/call', params: { threadId, turnId: 'turn_1', callId: 'exec-aaa', tool: 'tasks__create', arguments: { title: 'A' } } });
    },
    onAnswer: (child, msg) => {
      if (msg.id !== 900) return;
      const threadId = 'thr_1';
      child.send({ method: 'item/started', params: { threadId, turnId: 'turn_1', item: { id: 'exec-bbb', type: 'commandExecution', command: 'git status', cwd: '/work' } } });
      child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'exec-bbb', type: 'commandExecution', command: 'git status', status: 'completed', exitCode: 0, aggregatedOutput: 'clean' } } });
      raw(child, threadId, { type: 'function_call', name: 'tasks__create', call_id: 'call_top', arguments: '{}' }); // covered by item/tool/call: no event
      raw(child, threadId, { type: 'custom_tool_call_output', call_id: 'call_x1', output: [{ type: 'input_text', text: HEADER }, { type: 'input_text', text: 'created' }, { type: 'input_text', text: 'second line' }] });
      done(child, threadId);
    },
  });
  const { input, events, toolCalls } = turnInput();
  assert.equal((await engineOf(fake.spawn).run(input)).stop, 'done');
  const tools = events.filter((event: EngineEvent) => event.type === 'tool_start' || event.type === 'tool_end');
  assert.deepEqual(tools[0], { type: 'tool_start', callId: 'call_x1', name: 'exec', args: { source: SOURCE }, own: true });
  assert.deepEqual(tools[1], { type: 'tool_start', callId: 'exec-aaa', name: 'tasks.create', args: { title: 'A' }, own: false, nested: true, parent: 'call_x1' });
  assert.equal(toolCalls[0].callId, 'exec-aaa', 'our tool still runs');
  const command = tools.find((event: any) => event.type === 'tool_start' && event.callId === 'exec-bbb');
  assert.equal(command.nested, true);
  assert.equal(command.parent, 'call_x1');
  const end = tools.find((event: any) => event.type === 'tool_end' && event.callId === 'call_x1');
  assert.deepEqual(end, { type: 'tool_end', callId: 'call_x1', ok: true, summary: 'Script completed', output: `${HEADER}created\nsecond line` });
  assert.equal(tools.filter((event: any) => event.callId === 'call_inj' || event.callId === 'call_top').length, 0, 'no duplicates, no injected items');
});

test('a script still open when the turn ends gets its tool_end there, with what it printed', async () => {
  const fake = appServer({
    onTurn: (child, threadId) => {
      raw(child, threadId, { type: 'custom_tool_call', name: 'exec', call_id: 'call_open', input: 'notify("half"); yield_control()' });
      raw(child, threadId, { type: 'custom_tool_call_output', call_id: 'call_open', output: 'half' }); // a notify() output: not the end
      done(child, threadId);
    },
  });
  const { input, events } = turnInput();
  assert.equal((await engineOf(fake.spawn).run(input)).stop, 'done');
  assert.deepEqual(events.filter((event: any) => event.type === 'tool_end' && event.callId === 'call_open'), [{ type: 'tool_end', callId: 'call_open', ok: true, summary: 'half', output: 'half' }]);
});

test('CodeCalls: a notify output keeps the call open, a failed script is not ok, a wait call is its own step, an open call ends at flush', () => {
  const events: EngineEvent[] = [];
  const calls = new CodeCalls((event) => events.push(event), () => false);
  calls.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'notify("half"); text(1)' });
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c1', output: 'half' });
  assert.equal(events.filter((e) => e.type === 'tool_end').length, 0, 'a notify output is not the end');
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c1', output: 'Script error\nOutput:\nTypeError: x' });
  assert.deepEqual(events.at(-1), { type: 'tool_end', callId: 'c1', ok: false, summary: 'Script error', output: 'half\nScript error\nOutput:\nTypeError: x' });
  calls.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'yield_control()' });
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c2', output: 'Script running with cell ID 3\nOutput:\n' });
  assert.deepEqual(calls.nested('exec-n1'), { nested: true, parent: 'c2' }, 'a yielded cell still runs: the newest script is the parent');
  calls.raw({ type: 'function_call', name: 'wait', call_id: 'c3', arguments: '{"cell_id":"3"}' });
  assert.deepEqual(events.at(-1), { type: 'tool_start', callId: 'c3', name: 'wait', args: { cell_id: '3' }, own: true });
  assert.deepEqual(calls.nested('exec-n2'), { nested: true, parent: 'c3' });
  assert.deepEqual(calls.nested('call_top'), {}, 'not nested');
  calls.raw({ type: 'function_call_output', call_id: 'c3', output: 'partial' });
  calls.flush();
  assert.deepEqual(events.at(-1), { type: 'tool_end', callId: 'c3', ok: true, summary: 'partial', output: 'partial' });
  const ours = new CodeCalls((event) => events.push(event), (wire) => wire === 'wait');
  const before = events.length;
  ours.raw({ type: 'function_call', name: 'wait', call_id: 'c4', arguments: '{}' });
  assert.equal(events.length, before, 'a dynamic tool of ours named wait is reported by item/tool/call');
  assert.equal(codeOutputText([{ type: 'input_text', text: 'a' }, { type: 'input_image', image_url: 'data:' }]), 'a\n[image]');
});

const HOST = 'C:\\Users\\p\\AppData\\Local\\OpenAI\\Codex\\bin\\0ab0e7a8f3779036\\codex-code-mode-host.exe';

test('CodeCalls: a helper that cannot start ends the call at once as failed, and says what helps; printed text with these words does not', () => {
  const events: EngineEvent[] = [];
  const calls = new CodeCalls((event) => events.push(event), () => false);
  calls.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(1)' });
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c1', output: `failed to spawn code-mode host ${HOST}: ` });
  assert.equal(calls.hostMissing, HOST);
  const end = events.at(-1) as any;
  assert.equal(end.ok, false);
  assert.equal(end.summary, hostMissingText(HOST));
  assert.match(end.summary, /Update or reinstall Codex/);

  const reading = new CodeCalls(() => {}, () => false);
  reading.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'text(log)' });
  reading.raw({ type: 'custom_tool_call_output', call_id: 'c2', output: `${HEADER}failed to spawn code-mode host ${HOST}: ` });
  assert.equal(reading.hostMissing, undefined, 'a script that read a log with this line ran fine');
});

test('a Codex that cannot start its helper: the turn stops at once with a clear error, and the next process runs what this PC has now', async () => {
  let turns = 0;
  const fake = appServer({
    onTurn: (child, threadId) => {
      if (++turns > 1) { done(child, threadId); return; }
      raw(child, threadId, { type: 'custom_tool_call', name: 'exec', call_id: 'call_x1', input: SOURCE });
      raw(child, threadId, { type: 'custom_tool_call_output', call_id: 'call_x1', output: `failed to spawn code-mode host ${HOST}: ` });
      const stopped = setInterval(() => { // the model would go on; Codex answers the interrupt by ending the turn
        if (!fake.sent('turn/interrupt').length) return;
        clearInterval(stopped);
        child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'interrupted' } } });
      }, 1);
    },
  });
  const spawned: string[] = [];
  const spawn = ((command: string, args: string[], options: any) => { spawned.push(command); return fake.spawn(command, args, options); }) as typeof fake.spawn;
  const finder = { find: async (_id: string, options?: { force?: boolean }) => { const command = options?.force ? '/bin/new/codex' : '/bin/old/codex'; return { command, prefixArgs: [], path: command }; }, clear: () => {} };
  const e = new CodexEngine({ supervisor: testSupervisor(spawn), finder: finder as never, cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
  const { input, events } = turnInput({ runId: 'run_1' });
  const result = await e.run(input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'unavailable');
  assert.equal(result.error?.message, hostMissingText(HOST));
  assert.equal(events.find((event: any) => event.type === 'tool_end').ok, false);
  assert.deepEqual(spawned, ['/bin/old/codex']);

  assert.equal((await e.run(turnInput({ runId: 'run_2', session: { ref: result.session?.ref ?? 'thr_1', generation: 1 } }).input)).stop, 'done');
  assert.deepEqual(spawned, ['/bin/old/codex', '/bin/new/codex'], 'between turns the process is replaced');
  await e.dispose();
});

test('CodeCalls: a script the interrupt cut ("aborted by user after …", as in the rollouts) ends at once and is not ok', () => {
  const events: EngineEvent[] = [];
  const calls = new CodeCalls((event) => events.push(event), () => false);
  calls.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({cmd:"sleep 60"})' });
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c1', output: 'aborted by user after 1.6s' });
  assert.deepEqual(events.at(-1), { type: 'tool_end', callId: 'c1', ok: false, summary: 'aborted by user after 1.6s', output: 'aborted by user after 1.6s' });
  calls.raw({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'text(1)' });
  calls.raw({ type: 'custom_tool_call_output', call_id: 'c2', output: 'aborted before dispatch' });
  assert.equal((events.at(-1) as any).ok, false);
  calls.flush();
  assert.equal(events.filter((event) => event.type === 'tool_end').length, 2, 'each ended once');
});

const codexOrigin = { engine: 'codex', model: 'codex:gpt-5.6-sol' };
