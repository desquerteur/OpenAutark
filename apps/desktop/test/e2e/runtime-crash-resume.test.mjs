// End-to-end (RC1): a crash mid-turn is recovered without repeating an action blindly, over the
// real headless runtime (built app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC).
// The Manager works on a task; a message makes its turn start an engine-native command
// ([[hang:bash …]]) that never returns, and the runtime is killed (SIGKILL) mid-turn. After a
// restart on the same data: the run is 'interrupted' and the command's effect 'unknown' (the chat's quiet
// "Cut off by a restart" line went with the recovery notes); the agent is told to verify before
// repeating, so the command is not started again, and the task completes (its tasks.complete
// call). The start notice says "Restarted after an interruption · 1 task continued".
// Run: npm run build && node --test test/e2e/runtime-crash-resume.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

test('SIGKILL mid-turn: after the restart the unknown effect is named, not repeated, and the task completes', { timeout: 240_000 }, async (t) => {
  const first = await startRuntime({ keepData: true });
  const dataDir = first.dataDir;
  t.after(async () => {
    if (first.child.exitCode === null) first.child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const before = first.client;
  const manager = (await before.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await before.call('chats.create', { title: 'Report', agentIds: [manager.id] });
  await before.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, `runs:${manager.id}`] });
  const task = await before.call('tasks.create', { conversationId: chat.id, title: 'Export the monthly report', assigneeKind: 'agent', assigneeId: manager.id });
  // the first turn on the task: a background turn, so its answer stays in the run journal (B-047 D4, agents/publishing.ts)
  await before.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === task.id && run.endedAt !== undefined, 60_000);

  await before.call('messages.send', {
    conversationId: chat.id,
    body: `Export it now [[hang:bash {"command":"export-report --month 10"}]] [[tool:tasks.complete {"taskId":"${task.id}","summary":"Report exported once","evidence":[{"kind":"check","label":"Export log shows one run"}]}]]`,
  });
  const started = await before.waitFor('run.item', (item) => item.kind === 'tool_call' && item.name === 'bash', 60_000);
  const crashedRun = started.runId;
  await before.call('messages.send', { conversationId: chat.id, body: 'When you continue, preview the exported report first.' });
  await sleep(300); // the turn is waiting on the native command
  first.child.kill('SIGKILL');
  await new Promise((resolve) => { if (first.child.exitCode !== null || first.child.signalCode) resolve(); else first.child.once('exit', resolve); });

  const second = await startRuntime({ dataDir, keepData: true });
  t.after(() => second.stop());
  const after = second.client;
  await after.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, `runs:${manager.id}`] });

  // The task completes after the restart (its tasks.complete call), without starting the command again.
  let done;
  for (let i = 0; i < 120 && done?.status !== 'done'; i++) {
    done = await after.call('tasks.get', { id: task.id });
    if (done.status !== 'done') await sleep(500);
  }
  assert.equal(done.status, 'done', `the task completes (status ${done?.status})`);
  assert.match(done.result?.summary ?? '', /Report exported once/);

  const crashed = await after.call('runs.items', { runId: crashedRun });
  const command = crashed.find((item) => item.kind === 'tool_call' && item.name === 'bash');
  assert.equal(command?.effectStatus, 'unknown', 'the cut-off command is an unknown effect');

  const messages = await after.call('messages.list', { conversationId: chat.id });
  assert.ok(messages.some((message) => message.authorId === manager.id && /bash not started again: its effect is unknown/.test(message.body)), 'the agent verified instead of repeating');
  const continued = messages.find((message) => message.authorId === manager.id && /App system events: interrupted work/.test(message.body));
  assert.ok(continued, 'the resumed engine received app-authored interruption context');
  assert.match(continued.body, /app has restarted/);
  assert.match(continued.body, /When you continue, preview the exported report first/);
  assert.match(continued.body, /Retrying now.*input changed/);
  assert.ok(continued.body.indexOf('app has restarted') < continued.body.indexOf('When you continue, preview'));
  assert.ok(continued.body.indexOf('When you continue, preview') < continued.body.indexOf('Retrying now'));

  // The command was started exactly once over both lifetimes of the runtime.
  const runIds = new Set([crashedRun, ...after.events.filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === manager.id).map((frame) => frame.data.id)]);
  let starts = 0;
  for (const runId of runIds) starts += (await after.call('runs.items', { runId })).filter((item) => item.kind === 'tool_call' && item.name === 'bash').length;
  assert.equal(starts, 1, 'the command was not repeated');

  const info = await after.call('system.info');
  assert.match(info.notice?.text ?? '', /^Restarted after an interruption · \d+ tasks? continued$/);
});
