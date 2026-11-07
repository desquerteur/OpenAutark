// AF-012 end-to-end: the person's Stop of a running agent over the real WebSocket RPC – the headless runtime with the
// deterministic fake engine and a real child process. The agent's turn appends to the chat's notes, then runs a command
// (shell.exec) that starts a long-lived node process writing its pid, then wants to append once more – the fake ignores
// the Stop like a stubborn engine, so the runtime alone has to hold the line:
//   * messages.stop (the composer's Stop and Esc) ends the turn within 2 s;
//   * the command's process tree is killed (Windows: taskkill /T /F) – the node process is gone;
//   * the tool call after the Stop never runs (the notes keep only the first line; "this call did not run");
//   * the answer so far stays in the chat as 'stopped' (the UI shows "Stopped"), and nothing works any more;
//   * runs.cancel {runId} – the RPC the agent view's Stop per sub-agent uses – stops one run by its id the same way.
// Run: npm run build && node --test test/e2e/runtime-stop.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime, waitForNew } from './lib/runtime-client.mjs';

const STOP_WITHIN_MS = 2000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check, ms, what) {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

test('AF-012: Stop ends a running agent within 2 s – no more tool calls, its command tree killed, its answer so far kept as stopped', { timeout: 180_000 }, async (t) => {
  const runtime = await startRuntime();
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'workforce-stop-'));
  t.after(async () => { await runtime.stop(); await rm(scratch, { recursive: true, force: true }).catch(() => undefined); });
  const { client } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Stop', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, 'org'] });

  await t.test('messages.stop: within 2 s, the command tree killed, the late call refused, the answer kept as stopped', async () => {
    const pidFile = path.join(scratch, 'child.pid').replaceAll('\\', '/');
    const command = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(Date.now,1000)" ${pidFile}`;
    const body = `Deploy [[tool:chat.notes.append {"text":"Before stop"}]] [[tool:shell.exec ${JSON.stringify({ command })}]] [[tool:chat.notes.append {"text":"After stop"}]]`;
    const working = waitForNew(client, 'agent.activity', (event) => event.active.some((run) => run.agentId === manager.id && run.conversationId === chat.id), 60_000);
    await client.call('messages.send', { conversationId: chat.id, body });
    const runId = (await working).active.find((run) => run.agentId === manager.id).runId;
    const pid = Number(await until(() => readFile(pidFile, 'utf8').catch(() => ''), 60_000, 'the command started its child'));
    assert.ok(alive(pid), 'the child process runs');
    assert.match((await client.call('notes.get', { conversationId: chat.id })).text, /Before stop/, 'the call before the Stop ran');

    const ended = waitForNew(client, 'message.updated', (message) => message.conversationId === chat.id && message.runId === runId && message.state !== 'streaming', 30_000);
    const started = Date.now();
    await client.call('messages.stop', { conversationId: chat.id });
    const answer = await ended;
    const ms = Date.now() - started;
    t.diagnostic(`stopped in ${ms} ms`);
    assert.ok(ms < STOP_WITHIN_MS, `the turn ended within ${STOP_WITHIN_MS} ms (${ms} ms)`);
    assert.equal(answer.state, 'stopped', 'the answer so far stays, marked stopped');
    assert.match(answer.body, /this call did not run/, 'the call after the Stop was refused');
    await until(() => !alive(pid), STOP_WITHIN_MS, 'the child process was killed with its tree');

    await sleep(1500); // nothing may come after the Stop
    const notes = (await client.call('notes.get', { conversationId: chat.id })).text;
    assert.match(notes, /Before stop/);
    assert.doesNotMatch(notes, /After stop/, 'no tool call ran after the Stop');
    const activity = await client.call('agents.activity');
    assert.equal(activity.filter((run) => run.agentId === manager.id).length, 0, 'nothing works any more');
    const run = (await client.call('agents.runs', { id: manager.id })).find((item) => item.id === runId);
    assert.equal(run?.status, 'interrupted');
  });

  await t.test('runs.cancel {runId}: one run stops by its id within 2 s', async () => {
    const working = waitForNew(client, 'agent.activity', (event) => event.active.some((run) => run.agentId === manager.id && run.conversationId === chat.id), 60_000);
    await client.call('messages.send', { conversationId: chat.id, body: 'Ship it [[hang:bash {"command":"deploy --long"}]]' });
    const runId = (await working).active.find((run) => run.agentId === manager.id).runId;
    const ended = waitForNew(client, 'message.updated', (message) => message.conversationId === chat.id && message.runId === runId && message.state !== 'streaming', 30_000);
    const started = Date.now();
    await client.call('runs.cancel', { runId });
    const answer = await ended;
    const ms = Date.now() - started;
    t.diagnostic(`cancelled in ${ms} ms`);
    assert.ok(ms < STOP_WITHIN_MS, `the run ended within ${STOP_WITHIN_MS} ms (${ms} ms)`);
    assert.equal(answer.state, 'stopped');
    assert.equal((await client.call('agents.activity')).filter((run) => run.agentId === manager.id).length, 0, 'nothing works any more');
  });
});
