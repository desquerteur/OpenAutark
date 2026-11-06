// End-to-end (B-057 "Ultra mode"): the real headless runtime with the deterministic fake engine over WebSocket RPC.
// An agent splits itself with agents.split (a scripted [[tool:…]] directive) into 3 parts with context 'brief' (fresh
// sessions: each part's fake turn echoes its own part notes); the parts run as split runs under the parent agent
// (trigger 'split', runs.split_id), post nothing in the chat, and when the last one ends the parent is woken ONCE
// ('child', in its chat) – that turn's input carries the "Split results" block (the fake echoes it into the run's
// internal answer) and, ended 'done', gathers the group. splits.list and splits.get show the group and its parts.
// Run: npm run build && node --test test/e2e/runtime-splits.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const PARTS = [
  { title: 'Alpha check', brief: 'Report the marker alpha-check-ok.', context: 'brief' },
  { title: 'Beta check', brief: 'Report the marker beta-check-ok.', context: 'brief', returns: 'The marker only' },
  { title: 'Gamma check', brief: 'Report the marker gamma-check-ok.', context: 'brief', model: 'same' },
];
const GOAL = 'Check alpha, beta and gamma in parallel';

const answerOf = (items) => items.filter((item) => item.kind === 'note' && item.name === 'Answer').map((item) => String(item.data.text ?? '')).join('');

test('an agent splits itself: 3 parts run, the parent is woken once with their results', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await client.call('chats.create', { title: 'Splits', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', 'org', `chat:${chat.id}`, `runs:${manager.id}`] });

  const args = JSON.stringify({ goal: GOAL, parts: PARTS });
  await client.call('messages.send', { conversationId: chat.id, body: `Split this work [[tool:agents.split ${args}]]` });

  const created = await client.waitFor('split.upserted', (group) => group.agentId === manager.id && group.goal === GOAL, 90_000);
  assert.equal(created.parts, 3);
  assert.equal(created.conversationId, chat.id);
  assert.equal(created.thread, chat.id);
  assert.deepEqual(created.splits.map((split) => [split.idx, split.title, split.context]), PARTS.map((given, index) => [index + 1, given.title, 'brief']));

  const settled = await client.waitFor('split.upserted', (group) => group.id === created.id && (group.status === 'settled' || group.status === 'gathered'), 180_000);
  assert.deepEqual(settled.splits.map((split) => split.status), ['done', 'done', 'done']);
  assert.ok(settled.splits.every((split) => split.runs >= 1 && split.run?.status === 'done'), 'each part ran as its own run');

  // Each split run is a run of the parent agent with trigger 'split' and its split id; its answer stays in the journal.
  const splitRuns = new Map();
  for (const frame of client.events) {
    if (frame.event === 'run.upserted' && frame.data.agentId === manager.id && frame.data.splitId) splitRuns.set(frame.data.id, frame.data);
  }
  assert.equal(new Set([...splitRuns.values()].map((run) => run.splitId)).size, 3);
  assert.ok([...splitRuns.values()].every((run) => run.trigger === 'split' && !run.conversationId), 'split runs carry no chat');
  const alpha = settled.splits.find((split) => split.idx === 1);
  const alphaAnswer = answerOf(await client.call('runs.items', { runId: alpha.run.id }));
  assert.match(alphaAnswer, /alpha-check-ok/, 'the part worked on its own brief');
  assert.doesNotMatch(alphaAnswer, /beta-check-ok/, 'and only on its own part');

  // The parent: woken once ('child', its chat); that turn's input holds the results block; ended 'done', it gathers the group.
  const gathered = await client.waitFor('split.upserted', (group) => group.id === created.id && group.status === 'gathered', 180_000);
  assert.ok(gathered.gatheredAt >= gathered.endedAt);
  const childRuns = new Set(client.events
    .filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === manager.id && frame.data.trigger === 'child' && frame.data.conversationId === chat.id)
    .map((frame) => frame.data.id));
  assert.equal(childRuns.size, 1, 'exactly one fan-in turn');
  const [childRun] = childRuns;
  await client.waitFor('run.upserted', (run) => run.id === childRun && run.endedAt !== undefined, 90_000);
  const merged = answerOf(await client.call('runs.items', { runId: childRun }));
  assert.match(merged, /Split results/);
  for (const marker of ['alpha-check-ok', 'beta-check-ok', 'gamma-check-ok']) assert.match(merged, new RegExp(marker), `the results block holds ${marker}`);

  // Nothing of the parts reached the chat (a message of the parent may quote them – that is its own, not a split's).
  const messages = await client.call('messages.list', { conversationId: chat.id, limit: 100 });
  assert.ok(!messages.some((message) => message.runId && splitRuns.has(message.runId)), 'splits post nothing in chats');

  // The views.
  const listed = await client.call('splits.list', { agentId: manager.id });
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].status, 'gathered');
  assert.equal((await client.call('splits.list', { agentId: manager.id, active: true })).length, 0);
  const one = await client.call('splits.get', { id: alpha.id });
  assert.equal(one.group.id, created.id);
  assert.equal(one.split.title, 'Alpha check');
  assert.deepEqual(await client.call('splits.stop', { groupId: created.id }), { stopped: 0 }, 'an ended group has nothing to stop');
});
