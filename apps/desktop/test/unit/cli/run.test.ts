// C7: the whole wf terminal client in-process (runCli with Node's real WebSocket client) against a
// small fake runtime on 127.0.0.1 that speaks the /ws protocol (fake-runtime.ts): every command,
// --json, stdin, exit codes 0/1/2/3/4/5/130, subscribe-before-send, stream ends, and that the
// owner token never shows up in stdout or stderr.
// Owns: these assertions only. Never: starts the real runtime or reads the person's app data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { runCli } from '../../../src/runtime/wf-cli/run.ts';
import { AT, message, task } from './fixtures.ts';
import { TOKEN, fakeRuntime, fault, launch, manager, notes, wf } from './fake-runtime.ts';

test('chats: the Hello carries the owner token as client "cli"; human and --json output', async (t) => {
  const runtime = await fakeRuntime();
  t.after(() => runtime.stop());
  const human = await wf(['chats'], { runtime });
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /^Launch\n  ch_launch0001 · no messages yet\nNotes\n/);
  assert.deepEqual(runtime.hellos[0], { protocol: 1, token: TOKEN, client: 'cli' });
  const json = await wf(['chats', '--json', '--all'], { runtime });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.out).map((item: { id: string }) => item.id), [launch.id, notes.id]);
  assert.deepEqual(runtime.calls.filter((call) => call.method === 'chats.list').map((call) => call.params), [undefined, { includeHidden: true }]);
});

test('call: any method with JSON params (inline or stdin); unknown method 2, not found 4, forbidden 3, bad JSON 2', async (t) => {
  const runtime = await fakeRuntime({
    'chats.get': (params) => {
      if ((params as { id: string }).id !== launch.id) throw fault('not_found', 'Chat not found.');
      return launch;
    },
    'permissions.setMode': () => { throw fault('forbidden', 'Not allowed.'); },
    'system.echoToken': () => ({ text: `the token is ${TOKEN}` }),
  });
  t.after(() => runtime.stop());
  const compact = await wf(['call', 'chats.list', '--json'], { runtime });
  assert.equal(compact.code, 0);
  assert.equal(compact.out.trim().split('\n').length, 1, '--json prints one line');
  assert.equal(JSON.parse(compact.out).length, 2);
  const pretty = await wf(['call', 'chats.get', `{"id":"${launch.id}"}`], { runtime });
  assert.equal(pretty.code, 0);
  assert.equal(JSON.parse(pretty.out).id, launch.id);
  assert.ok(pretty.out.split('\n').length > 3, 'human mode indents the JSON');
  const piped = await wf(['call', 'chats.get', '-'], { runtime, stdin: `{"id":"${launch.id}"}` });
  assert.equal(JSON.parse(piped.out).id, launch.id);

  const unknown = await wf(['call', 'no.such'], { runtime });
  assert.deepEqual([unknown.code, unknown.err], [2, 'wf: Unknown method: no.such.\n']);
  const missing = await wf(['call', 'chats.get', '{"id":"ch_nope000001"}'], { runtime });
  assert.deepEqual([missing.code, missing.err], [4, 'wf: Chat not found.\n']);
  const refused = await wf(['call', 'permissions.setMode', '{"mode":"autonomous"}', '--json'], { runtime });
  assert.equal(refused.code, 3);
  assert.deepEqual(JSON.parse(refused.err), { error: { code: 'forbidden', message: 'Not allowed.' } });
  const badJson = await wf(['call', 'chats.get', '{id:'], { runtime });
  assert.equal(badJson.code, 2);
  assert.match(badJson.err, /not valid JSON/);
  const badName = await wf(['call', 'Not a method'], { runtime });
  assert.equal(badName.code, 2);
  const redacted = await wf(['call', 'system.echoToken'], { runtime });
  assert.match(redacted.out, /the token is \[token\]/, 'output is redacted even when a result contains the token');
});

test('read: a chat by name with --limit; a chat nobody has is not found (4)', async (t) => {
  const runtime = await fakeRuntime({
    'messages.list': () => [
      message({ id: 'msg_1', seq: 1, conversationId: launch.id, body: 'Hello team' }),
      message({ id: 'msg_2', seq: 2, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'Echo: Hello team' }),
    ],
  });
  t.after(() => runtime.stop());
  const read = await wf(['read', 'launch', '--limit', '5'], { runtime });
  assert.equal(read.code, 0, read.err);
  assert.equal(read.out, '# Launch (ch_launch0001)\n14:02  You: Hello team\n14:02  Manager: Echo: Hello team\n');
  assert.deepEqual(runtime.calls.find((call) => call.method === 'messages.list')?.params, { conversationId: launch.id, limit: 5 });
  assert.ok(!runtime.calls.some((call) => call.method === 'chats.markRead'), 'reading in a terminal does not clear unread markers');
  const missing = await wf(['read', 'Budget'], { runtime });
  assert.equal(missing.code, 4);
  assert.match(missing.err, /No chat matches "Budget"/);
});

test('send: body from words or stdin, @mentions stay in the text, --important, a fresh clientId; empty text is refused', async (t) => {
  const runtime = await fakeRuntime({
    'messages.send': (params) => message({ id: 'msg_sent', seq: 5, conversationId: launch.id, body: (params as { body: string }).body }),
  });
  t.after(() => runtime.stop());
  const sent = await wf(['send', 'Launch', 'Hello', '@Manager', 'please'], { runtime });
  assert.equal(sent.code, 0, sent.err);
  assert.equal(sent.out, 'Sent to Launch (msg_sent).\n');
  const params = runtime.calls.filter((call) => call.method === 'messages.send').map((call) => call.params as Record<string, unknown>);
  assert.equal(params[0].body, 'Hello @Manager please');
  assert.equal(params[0].conversationId, launch.id);
  assert.ok(!('priority' in params[0]));
  assert.match(String(params[0].clientId), /^wf-[0-9a-f-]{36}$/);
  const piped = await wf(['send', 'ch_launch0001', '-', '--important', '--json'], { runtime, stdin: 'line one\nline two' });
  assert.equal(piped.code, 0);
  const second = runtime.calls.filter((call) => call.method === 'messages.send')[1].params as Record<string, unknown>;
  assert.deepEqual([second.body, second.priority], ['line one\nline two', 'important']);
  assert.notEqual(second.clientId, params[0].clientId);
  assert.equal(JSON.parse(piped.out).id, 'msg_sent');
  const empty = await wf(['send', 'Launch', '   '], { runtime });
  assert.deepEqual([empty.code, empty.err], [2, 'wf: Nothing to send.\n']);
});

test('send --wait: subscribed before sending, so a reply pushed even before the answer is caught; failed replies exit 1', async (t) => {
  let replyState: 'final' | 'failed' = 'final';
  const runtime = await fakeRuntime({
    'messages.send': (_params, fake) => {
      const topic = `chat:${launch.id}`;
      fake.push('message.created', message({ id: 'msg_old', seq: 4, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'earlier' }), topic);
      fake.push('message.created', message({ id: 'msg_reply', seq: 6, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', state: 'streaming', body: 'Ec' }), topic);
      fake.push('message.updated', message({ id: 'msg_reply', seq: 6, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', state: replyState, body: 'Echo: hi', meta: replyState === 'failed' ? { error: 'No model could take this.' } : {} }), topic);
      return message({ id: 'msg_sent', seq: 5, conversationId: launch.id, body: 'hi' });
    },
  });
  t.after(() => runtime.stop());
  const human = await wf(['send', 'Launch', 'hi', '--wait'], { runtime });
  assert.equal(human.code, 0, human.err);
  assert.equal(human.out, '14:02  Manager: Echo: hi\n');
  assert.match(human.err, /Sent to Launch \(msg_sent\)\. Waiting for a reply/);
  const order = runtime.calls.map((call) => call.method);
  assert.ok(order.indexOf('events.subscribe') < order.indexOf('messages.send'), 'subscribe first');
  const json = await wf(['send', 'Launch', 'hi', '--wait', '--json'], { runtime });
  assert.deepEqual([JSON.parse(json.out).message.id, JSON.parse(json.out).reply.id, json.err], ['msg_sent', 'msg_reply', '']);
  replyState = 'failed';
  const failed = await wf(['send', 'Launch', 'hi', '--wait'], { runtime });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /Manager \(failed\): Echo: hi/);
  assert.match(failed.err, /The reply failed\./);
});

test('send --wait --timeout: no reply in time exits 1', async (t) => {
  const runtime = await fakeRuntime({ 'messages.send': () => message({ id: 'msg_sent', seq: 5, conversationId: launch.id, body: 'hi' }) });
  t.after(() => runtime.stop());
  const result = await wf(['send', 'Launch', 'hi', '--wait', '--timeout', '0.2'], { runtime });
  assert.equal(result.code, 1);
  assert.match(result.err, /No reply arrived before the timeout/);
});

test('watch: prints new final messages and status lines once, skips streaming and already-ended ones; --count, Ctrl+C', async (t) => {
  const topic = `chat:${launch.id}`;
  const old = message({ id: 'msg_old', seq: 3, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'Old answer' });
  const runtime = await fakeRuntime({
    'messages.list': () => [old],
    'events.subscribe': (_params, fake) => {
      setTimeout(() => {
        fake.push('message.updated', old, topic); // e.g. a widget state change on an old message
        fake.push('message.created', message({ id: 'msg_a', seq: 7, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', state: 'streaming', body: 'Wor' }), topic);
        fake.push('message.updated', message({ id: 'msg_a', seq: 7, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'Working on it' }), topic);
        fake.push('message.updated', message({ id: 'msg_a', seq: 7, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'Working on it' }), topic);
        fake.push('message.created', message({ id: 'msg_b', seq: 8, conversationId: launch.id, kind: 'status', authorId: 'system', authorKind: 'system', body: 'Task created', meta: { status: { type: 'task_created', text: 'Task created: Draft plan' } } }), topic);
      }, 20);
      return { ok: true };
    },
  });
  t.after(() => runtime.stop());
  const counted = await wf(['watch', 'Launch', '--count', '2'], { runtime });
  assert.equal(counted.code, 0, counted.err);
  assert.equal(counted.out, '14:02  Manager: Working on it\n14:02  · Task created: Draft plan\n');
  assert.match(counted.err, /Watching Launch \(ch_launch0001\)/);

  const interrupt = new AbortController();
  // "Ctrl+C" once both messages are on stdout (event-driven, no timing guess).
  const stopped = await wf(['watch', 'Launch', '--json'], { runtime, interrupt: interrupt.signal, onOut: (out) => { if (out.split('\n').length > 2) interrupt.abort(); } });
  assert.equal(stopped.code, 0, 'Ctrl+C ends a watch normally');
  assert.deepEqual(stopped.out.trim().split('\n').map((line) => JSON.parse(line).id), ['msg_a', 'msg_b'], 'one JSON line per message');
  assert.equal(stopped.err, '', 'no hints on stderr with --json');

  const timed = await wf(['watch', 'Launch', '--timeout', '0.1'], { runtime });
  assert.equal(timed.code, 0, 'a watch without --count simply ends at the timeout');
});

test('watch: the runtime stopping ends it with 5', async (t) => {
  const runtime = await fakeRuntime({
    'events.subscribe': (_params, fake) => { setTimeout(() => fake.closeAll(1001), 20); return { ok: true }; },
  });
  t.after(() => runtime.stop());
  const result = await wf(['watch', 'Launch'], { runtime });
  assert.deepEqual([result.code, result.err.trim().split('\n').at(-1)], [5, 'wf: The runtime stopped.']);
});

test('events: topics by name, NDJSON with --json, --count not reached before --timeout exits 1, unknown topics 2', async (t) => {
  const runtime = await fakeRuntime({
    'events.subscribe': (params, fake) => {
      setTimeout(() => {
        for (const topic of (params as { topics: string[] }).topics) {
          if (topic === 'tasks') fake.push('task.upserted', task({ id: 'task_1', title: 'Draft plan', status: 'working' }), 'tasks');
          if (topic === `chat:${launch.id}`) fake.push('message.updated', { id: 'msg_x', conversationId: launch.id, authorId: 'ag_x', body: '', attachments: [], state: 'streaming' }, topic); // B-075: a run's live row
        }
      }, 20);
      return { ok: true };
    },
  });
  t.after(() => runtime.stop());
  const json = await wf(['events', 'tasks', 'chat:launch', '--json', '--count', '2'], { runtime });
  assert.equal(json.code, 0, json.err);
  const lines = json.out.trim().split('\n').map((line) => JSON.parse(line) as { event: string });
  assert.deepEqual(lines.map((line) => line.event).sort(), ['message.updated', 'task.upserted']);
  assert.deepEqual(runtime.calls.find((call) => call.method === 'events.subscribe')?.params, { topics: ['tasks', `chat:${launch.id}`] });

  const short = await wf(['events', 'tasks', 'chat:launch', '--count', '2', '--timeout', '1.5'], { runtime });
  assert.equal(short.code, 1, 'the live row is not printed in human mode, so only 1 of 2 arrived');
  assert.match(short.out, /task\.upserted  Draft plan · working/);
  assert.match(short.err, /1 of 2 arrived before the timeout/);

  const unknown = await wf(['events', 'everything'], { runtime });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Unknown topic "everything"/);
  const agentTopic = await wf(['events', 'runs:manager', '--timeout', '0.05'], { runtime });
  assert.equal(agentTopic.code, 0);
  assert.deepEqual(runtime.calls.filter((call) => call.method === 'events.subscribe').at(-1)?.params, { topics: [`runs:${manager.id}`] });
});

test('todos, tasks and agents: default filters, --status, --all', async (t) => {
  const runtime = await fakeRuntime({
    'todos.list': () => [task({ id: 'task_t', title: 'Record a voice line', assigneeKind: 'human', status: 'needs_you', widget: { type: 'record' } })],
    'tasks.list': () => [task({ id: 'task_w', title: 'Draft plan', status: 'working', assigneeKind: 'agent', assigneeId: manager.id })],
  });
  t.after(() => runtime.stop());
  const todos = await wf(['todos'], { runtime });
  assert.equal(todos.out, '• Record a voice line · record · in Launch · task_t\n');
  await wf(['tasks'], { runtime });
  await wf(['tasks', '--status', 'open, done'], { runtime });
  await wf(['tasks', '--all', '--limit', '10'], { runtime });
  assert.deepEqual(runtime.calls.filter((call) => call.method === 'tasks.list').map((call) => call.params), [
    { status: ['open', 'working', 'waiting', 'needs_you', 'blocked'] }, { status: ['open', 'done'] }, { limit: 10 },
  ]);
  const both = await wf(['tasks', '--all', '--status', 'open'], { runtime });
  assert.equal(both.code, 2);
  const agents = await wf(['agents'], { runtime });
  assert.equal(agents.out, 'Manager · idle · reports to You · ag_manager0001\n');
});

test('no runtime: missing runtime.json, a stopped app, a refused token, a closed port – all exit 5 or 3', async (t) => {
  const missing = await wf(['chats'], { info: null });
  assert.equal(missing.code, 5);
  assert.match(missing.err, /runtime\.json does not exist/);
  const stopped = await wf(['chats'], { dead: true, info: { port: 1, token: TOKEN, pid: 4242 } });
  assert.equal(stopped.code, 5);
  assert.match(stopped.err, /no longer running/);

  const runtime = await fakeRuntime();
  t.after(() => runtime.stop());
  const refused = await wf(['chats'], { runtime, info: { port: runtime.port, token: 'some-older-token-from-another-start', pid: 4242 } });
  assert.equal(refused.code, 3);
  assert.match(refused.err, /did not accept the owner token/);

  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const closed = await wf(['agents', '--json'], { info: { port, token: TOKEN } });
  assert.equal(closed.code, 5);
  assert.equal(JSON.parse(closed.err).error.code, 'unreachable');
});

test('usage: help, version and argument errors are answered before anything is read or connected', async () => {
  const help = await wf(['help']);
  assert.equal(help.code, 0);
  for (const command of ['call', 'chats', 'read', 'send', 'watch', 'todos', 'tasks', 'agents', 'events']) assert.match(help.out, new RegExp(`\\n  ${command}\\b`));
  assert.match(help.out, /Exit codes: 0 ok, 1 failed, 2 bad request, 3 forbidden, 4 not found, 5 runtime unreachable/);
  assert.equal((await wf(['help', 'read'])).out, 'Usage: wf read <chat> [--limit n]\n  Print the last messages of a chat (default 20, at most 200). <chat> is an id or a name.\n');
  assert.equal((await wf(['send', '--help'])).code, 0);
  assert.equal((await wf(['--version'])).out, 'wf 9.9.9\n');
  assert.match((await wf(['help', 'toString'])).out, /^wf – control/, 'object prototype names are no commands');
  for (const argv of [['nope'], ['toString'], ['send', 'Launch', ' '], ['events', 'tasks', '--count', '0'], ['call', 'Not a method'], ['read'],['read', 'a', 'b'], ['chats', '--limit', '3'], ['read', 'x', '--limit', '0'], ['watch', 'x', '--timeout', 'never'], ['chats', '--bogus']]) {
    const result = await wf(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.deepEqual(result.reads, [], `nothing read for: ${argv.join(' ')}`);
  }
  const none = await runCli([], {
    stdout: () => {}, stderr: () => {}, stdin: async () => '', interrupt: new AbortController().signal, now: () => AT, version: 'x',
    env: { platform: process.platform, env: {}, home: '', cwd: '', readFile: () => { throw new Error('read'); }, alive: () => true },
  });
  assert.equal(none, 2, 'no command: usage on stderr, exit 2');
  const usageJson = await wf(['read', '--json']);
  assert.deepEqual(JSON.parse(usageJson.err), { error: { code: 'bad_request', message: 'Usage: wf read <chat> [--limit n]' } });
});
