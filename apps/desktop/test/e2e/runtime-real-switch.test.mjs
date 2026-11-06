// End-to-end with TWO real provider logins (opt-in, uses the person's plans for a few tiny turns):
//   WORKFORCE_E2E_REAL=switch  node --test test/e2e/runtime-real-switch.test.mjs
// Audit 23.10. (runtime systems): an engine switch after tool use and a cancel on real CLIs.
// 1. Codex creates a task with a workforce tool (dynamic tools); 2. the chat is pinned to Claude Code,
// whose new session gets the chat as text (no provider tool-call ids cross engines) and names the task;
// 3. a long Claude Code answer is cancelled (runs.cancel → stream-json interrupt) and ends 'interrupted';
// 4. the next turn in the same chat still answers. Login detection uses the official status commands only.
// Skipped unless WORKFORCE_E2E_REAL=switch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const enabled = process.env.WORKFORCE_E2E_REAL === 'switch';
const order = { cheap: 0, strong: 1, frontier: 2 };
const cheapest = (models, provider) => [...models.filter((m) => m.provider === provider && m.available)]
  .sort((a, b) => (order[a.tier] ?? 1) - (order[b.tier] ?? 1) || (a.relCost ?? 1) - (b.relCost ?? 1))[0];
const pinOf = (model) => ({ pin: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort });

test('real engine switch after a tool call, then a cancel and a further turn', { skip: !enabled, timeout: 600_000 }, async (t) => {
  const runtime = await startRuntime({ fake: false });
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'providers'] });
  await client.call('accounts.detect', { force: true });
  const accounts = await client.call('accounts.list');
  const keep = ['codex', 'claude'].map((provider) => accounts.find((a) => a.provider === provider && a.state === 'ok'));
  assert.ok(keep.every(Boolean), 'logged-in Codex and Claude Code CLIs are detected');
  for (const other of accounts) if (!keep.some((a) => a.id === other.id)) await client.call('accounts.update', { id: other.id, enabled: false });
  const models = await client.call('models.list', { refresh: true });
  const codex = cheapest(models, 'codex');
  const claude = cheapest(models, 'claude');
  assert.ok(codex && claude, 'both list models');

  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Switch check', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`, `runs:${manager.id}`] });
  const finalAfter = (seq, pattern) => (m) => m.conversationId === chat.id && m.authorId === manager.id && m.state === 'final' && m.seq > seq && (!pattern || pattern.test(m.body));

  await client.call('models.setPolicy', { agentId: manager.id, conversationId: chat.id, policy: pinOf(codex) });
  const asked = await client.call('messages.send', { conversationId: chat.id, body: 'Use your task tool to create a task titled "Switch check alpha" in this chat, then reply with: created' });
  const task = await client.waitFor('task.upserted', (item) => item.conversationId === chat.id && /switch check alpha/i.test(item.title), 240_000);
  await client.waitFor('message.updated', finalAfter(asked.seq, /created/i), 240_000);
  t.diagnostic(`1 · ${codex.id} created ${task.id} with its tool`);

  await client.call('models.setPolicy', { agentId: manager.id, conversationId: chat.id, policy: pinOf(claude) });
  const question = await client.call('messages.send', { conversationId: chat.id, body: 'What is the exact title of the task that was created in this chat a moment ago? Reply with the title only.' });
  const named = await client.waitFor('message.updated', finalAfter(question.seq), 240_000);
  t.diagnostic(`2 · ${claude.id} after the switch: ${named.body.slice(0, 120)}`);
  assert.match(named.body, /switch check alpha/i, 'the new engine knows what the tool did before the switch');
  const switched = (await client.call('agents.runs', { id: manager.id })).find((run) => run.conversationId === chat.id && run.status === 'done' && run.engine === 'claude');
  assert.ok(switched, 'the second turn ran on Claude Code');
  const switchErrors = (await client.call('runs.items', { runId: switched.id })).filter((item) => item.kind === 'error');
  assert.deepEqual(switchErrors, [], 'no error items in the switched turn');

  const long = await client.call('messages.send', { conversationId: chat.id, body: 'Write the numbers from 1 to 600, each on its own line, and nothing else.' });
  const running = await client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.conversationId === chat.id && run.status === 'running' && (run.startedAt ?? 0) >= long.createdAt, 120_000);
  const answer = await client.waitFor('message.created', (m) => m.runId === running.id, 120_000);
  await client.waitFor('message.updated', (m) => m.id === answer.id && m.state === 'streaming' && m.body.length > 0, 120_000); // it is answering (B-075: its row's body)
  const cancelledAt = Date.now();
  await client.call('runs.cancel', { runId: running.id });
  const ended = await client.waitFor('run.upserted', (run) => run.id === running.id && run.status !== 'running' && run.status !== 'queued', 60_000);
  t.diagnostic(`3 · cancel: run ${ended.status} after ${Date.now() - cancelledAt} ms`);
  assert.equal(ended.status, 'interrupted', 'the cancelled turn ends interrupted');

  const after = await client.call('messages.send', { conversationId: chat.id, body: 'Reply with exactly the word: after' });
  const reply = await client.waitFor('message.updated', finalAfter(after.seq, /after/i), 240_000);
  t.diagnostic(`4 · after the cancel: ${reply.body.slice(0, 80)}`);
});
