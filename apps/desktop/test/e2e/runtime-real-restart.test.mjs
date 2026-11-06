// End-to-end with a REAL provider login across a runtime restart (opt-in, uses the person's plan for
// two tiny turns):
//   WORKFORCE_E2E_REAL=codex  node --test test/e2e/runtime-real-restart.test.mjs   (or =claude)
// Audit 23.10. (runtime systems): the native session survives a restart of the runtime – the second
// turn resumes the SAME Codex thread / Claude Code session (engine_sessions.session_ref unchanged, no
// renewal note), gets only the new message, and a workforce tool still works in the resumed session
// (Codex: dynamic tools registered at thread/start must persist with the thread; Claude Code: the MCP
// hub config is written per turn). Login detection uses the official status commands only.
// Skipped unless WORKFORCE_E2E_REAL is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRuntime } from './lib/runtime-client.mjs';

const provider = process.env.WORKFORCE_E2E_REAL;
const RENEWED = ['sessionRenewed', 'fresh', 'sessionDropped'];

/** The stored session binding (read while no runtime runs; read-write so a left WAL is recovered). */
function binding(dataDir, agentId, conversationId) {
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'));
  try { return db.prepare('SELECT engine, session_ref, cursor_seq FROM engine_sessions WHERE agent_id = ? AND conversation_id = ?').get(agentId, conversationId); }
  finally { db.close(); }
}

/** Signs in through detection, keeps only `provider` enabled and pins its cheapest model in the chat. */
async function prepare(client) {
  await client.call('accounts.detect', { force: true });
  const accounts = await client.call('accounts.list');
  const account = accounts.find((item) => item.provider === provider && item.state === 'ok');
  assert.ok(account, `a logged-in ${provider} CLI is detected`);
  for (const other of accounts) if (other.id !== account.id) await client.call('accounts.update', { id: other.id, enabled: false });
  const models = (await client.call('models.list', { refresh: true })).filter((model) => model.provider === provider && model.available);
  assert.ok(models.length, `${provider} lists models`);
  const order = { cheap: 0, strong: 1, frontier: 2 };
  return [...models].sort((a, b) => (order[a.tier] ?? 1) - (order[b.tier] ?? 1) || (a.relCost ?? 1) - (b.relCost ?? 1))[0];
}

test(`real ${provider ?? 'provider'} session resumes after a runtime restart, tools included`, { skip: !provider, timeout: 420_000 }, async (t) => {
  let live = await startRuntime({ fake: false, keepData: true });
  const dataDir = live.dataDir;
  t.after(async () => {
    if (live) await live.stop();
    if (process.env.WORKFORCE_E2E_KEEP !== '1') await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  let { client } = live;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'providers'] });
  const model = await prepare(client);
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Restart check', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await client.call('models.setPolicy', { agentId: manager.id, conversationId: chat.id, policy: { pin: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort } });
  await client.call('messages.send', { conversationId: chat.id, body: 'Reply with exactly the word: pong' });
  const first = await client.waitFor('message.updated', (m) => m.conversationId === chat.id && m.authorId === manager.id && m.state === 'final', 240_000);
  t.diagnostic(`model ${model.id}, before the restart: ${first.body.slice(0, 120)}`);
  await live.stop();
  live = undefined;
  const before = binding(dataDir, manager.id, chat.id);
  assert.ok(before?.session_ref, 'the native session is stored');

  live = await startRuntime({ fake: false, dataDir, keepData: true });
  client = live.client;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`] });
  await client.call('accounts.detect', { force: false });
  await client.call('messages.send', { conversationId: chat.id, body: 'Use your task tool to create a task titled "Restart tool check" in this chat, then reply with: created' });
  const task = await client.waitFor('task.upserted', (item) => item.conversationId === chat.id && /restart tool check/i.test(item.title), 240_000);
  const reply = await client.waitFor('message.updated', (m) => m.conversationId === chat.id && m.authorId === manager.id && m.state === 'final' && m.id !== first.id, 240_000);
  t.diagnostic(`after the restart: task ${task.id}; reply ${reply.body.slice(0, 120)}`);
  const runs = (await client.call('agents.runs', { id: manager.id })).filter((run) => run.conversationId === chat.id);
  const latest = runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const items = await client.call('runs.items', { runId: latest.id });
  const notes = items.filter((item) => item.kind === 'note').map((item) => Object.keys(item.data)).flat();
  t.diagnostic(`run notes after the restart: ${JSON.stringify(notes)}`);
  assert.ok(!notes.some((key) => RENEWED.includes(key)), 'the session was resumed, not renewed');
  await live.stop();
  live = undefined;
  const after = binding(dataDir, manager.id, chat.id);
  assert.equal(after.session_ref, before.session_ref, 'the same native session continued after the restart');
  assert.ok(Number(after.cursor_seq) > Number(before.cursor_seq), 'its cursor followed the chat');
});
