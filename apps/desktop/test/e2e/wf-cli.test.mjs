// End-to-end (C7): the wf terminal client (built app/wf.mjs) against the real headless runtime with
// the deterministic fake engine, as separate processes like a shell would run them.
// Covers: discovery through --data and through the default per-OS app data dir (APPDATA /
// XDG_CONFIG_HOME / HOME pointed at a temp dir), chats, send then read seeing the fake answer,
// send --wait, call chats.list --json (parseable), call no.such (exit 2, short message), a missing
// chat (4), todos/tasks/agents, watch and events streams ending by --count, an empty data dir
// (exit 5) – and that the owner token never appears in stdout or stderr.
// Run: npm run build && node --test test/e2e/wf-cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(root, 'app', 'wf.mjs');
const PRODUCT = 'Autark';

/** Where Electron keeps userData for a home/app-data base on this OS, and the env that points there. */
function defaultLayout(base) {
  if (process.platform === 'win32') return { dataDir: path.join(base, PRODUCT), env: { APPDATA: base } };
  if (process.platform === 'darwin') return { dataDir: path.join(base, 'Library', 'Application Support', PRODUCT), env: { HOME: base } };
  return { dataDir: path.join(base, PRODUCT), env: { XDG_CONFIG_HOME: base } };
}

const outputs = [];

/** Runs `node app/wf.mjs …`; `onStderr` sees stderr as it arrives (stream commands). */
function wf(args, { data, env = {}, stdin, onStderr, timeoutMs = 60_000 } = {}) {
  const argv = data === null ? args : ['--data', data, ...args];
  const child = spawn(process.execPath, [WF, ...argv], { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; onStderr?.(stderr); });
  child.stdin.end(stdin ?? '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`wf ${args.join(' ')} did not finish\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

const waitForText = (predicate) => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return { ready, onStderr: (text) => { if (predicate(text)) release(); } };
};

test('wf terminal client against the headless runtime (fake engine)', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'workforce-wf-'));
  const layout = defaultLayout(base);
  const runtime = await startRuntime({ dataDir: layout.dataDir });
  t.after(async () => {
    await runtime.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  const { client, dataDir, token } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks'] });
  const [manager] = (await client.call('agents.list')).filter((agent) => agent.template === 'manager' || agent.name === 'Manager');
  assert.ok(manager, 'the first run seeds the manager');
  const managerChat = (await client.call('chats.list')).find((chat) => chat.members.some((member) => member.memberId === manager.id));
  assert.ok(managerChat, 'and its first chat');
  await client.call('events.subscribe', { topics: [`chat:${managerChat.id}`] });

  await t.test('chats via --data and via the default app data dir', async () => {
    const viaData = await wf(['chats'], { data: dataDir });
    assert.equal(viaData.code, 0, viaData.stderr);
    assert.ok(viaData.stdout.includes(managerChat.id), viaData.stdout);
    const viaDefault = await wf(['chats', '--json'], { data: null, env: layout.env });
    assert.equal(viaDefault.code, 0, viaDefault.stderr);
    assert.ok(JSON.parse(viaDefault.stdout).some((chat) => chat.id === managerChat.id), 'the default dir is the Electron userData dir');
  });

  await t.test('send, then read sees the fake answer', async () => {
    const reply = client.waitFor('message.updated', (message) => message.conversationId === managerChat.id && message.authorId === manager.id && message.state === 'final' && /From the terminal/.test(message.body), 90_000);
    const sent = await wf(['send', managerChat.id, 'From the terminal', '@Manager'], { data: dataDir });
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /^Sent to .+ \(msg_[0-9a-z]+\)\.\n$/);
    await reply;
    const read = await wf(['read', managerChat.id, '--limit', '10'], { data: dataDir });
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /You: From the terminal @Manager/);
    assert.match(read.stdout, /Manager: Echo: [\s\S]*From the terminal/, 'the fake answer echoes the message');
    const json = await wf(['read', managerChat.id, '--json'], { data: dataDir });
    assert.ok(JSON.parse(json.stdout).some((message) => message.authorId === manager.id && /From the terminal/.test(message.body)));
  });

  await t.test('send --wait prints the agent reply', async () => {
    const waited = await wf(['send', managerChat.id, 'Wait for me', '--wait', '--json', '--timeout', '120'], { data: dataDir, timeoutMs: 150_000 });
    assert.equal(waited.code, 0, waited.stderr);
    const { message, reply } = JSON.parse(waited.stdout);
    assert.equal(message.body, 'Wait for me');
    assert.equal(reply.authorId, manager.id);
    assert.ok(reply.seq > message.seq);
    assert.match(reply.body, /Wait for me/);
  });

  await t.test('call: --json parses, an unknown method exits 2 with a short message, a missing chat exits 4', async () => {
    const listed = await wf(['call', 'chats.list', '--json'], { data: dataDir });
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(Array.isArray(JSON.parse(listed.stdout)));
    const unknown = await wf(['call', 'no.such'], { data: dataDir });
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stderr, 'wf: Unknown method: no.such.\n');
    assert.equal(unknown.stdout, '');
    const missing = await wf(['call', 'chats.get', '{"id":"ch_0000000000000000"}'], { data: dataDir });
    assert.equal(missing.code, 4, missing.stderr);
    const missingByName = await wf(['read', 'No chat is called like this'], { data: dataDir });
    assert.equal(missingByName.code, 4);
  });

  await t.test('todos, tasks and agents', async () => {
    const todos = await wf(['todos'], { data: dataDir });
    assert.equal(todos.code, 0, todos.stderr);
    const tasks = await wf(['tasks', '--all', '--json'], { data: dataDir });
    assert.equal(tasks.code, 0, tasks.stderr);
    assert.ok(Array.isArray(JSON.parse(tasks.stdout)));
    const agents = await wf(['agents', '--json'], { data: dataDir });
    assert.ok(JSON.parse(agents.stdout).some((agent) => agent.id === manager.id));
    const human = await wf(['agents'], { data: dataDir });
    assert.match(human.stdout, new RegExp(`^Manager · .+ · ${manager.id}$`, 'm'));
  });

  await t.test('watch prints the next final message; events prints the next task change', async () => {
    // Human mode says on stderr when the subscription is live.
    const watching = waitForText((text) => text.includes('Watching'));
    const watch = wf(['watch', managerChat.id, '--count', '2'], { data: dataDir, onStderr: watching.onStderr, timeoutMs: 120_000 });
    await watching.ready;
    await client.call('messages.send', { conversationId: managerChat.id, body: 'Watched message' });
    const watched = await watch;
    assert.equal(watched.code, 0, watched.stderr);
    assert.match(watched.stdout, /^\d\d:\d\d  You: Watched message$/m, 'the message sent after the watch started');

    // --json keeps stderr empty, so nudge with a message until the stream has printed one line.
    const jsonWatch = wf(['watch', managerChat.id, '--count', '1', '--json', '--timeout', '60'], { data: dataDir });
    let finished = false;
    void jsonWatch.then(() => { finished = true; });
    for (let attempt = 0; attempt < 10 && !finished; attempt++) {
      await client.call('messages.send', { conversationId: managerChat.id, body: `Watched as JSON ${attempt}` });
      await Promise.race([jsonWatch, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    const json = await jsonWatch;
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, '');
    assert.equal(JSON.parse(json.stdout.trim()).conversationId, managerChat.id, 'one JSON line per message');

    const listening = waitForText((text) => text.includes('Listening to tasks'));
    const events = wf(['events', 'tasks', '--count', '1'], { data: dataDir, onStderr: listening.onStderr });
    await listening.ready;
    await client.call('tasks.create', { conversationId: managerChat.id, title: 'Task from the e2e test' });
    const done = await events;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /task\.upserted  Task from the e2e test · /);
  });

  await t.test('an empty data dir: no runtime, exit 5', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'workforce-wf-empty-'));
    try {
      const result = await wf(['chats'], { data: empty });
      assert.equal(result.code, 5);
      assert.match(result.stderr, /runtime\.json does not exist/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  await t.test('the owner token never appears in any output', () => {
    assert.ok(token.length >= 32);
    for (const text of outputs) assert.ok(!text.includes(token), 'token leaked into wf output');
  });
});
