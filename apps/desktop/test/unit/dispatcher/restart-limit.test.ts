// AF-001 – automatic restarts are limited: an agent whose task turns keep "doing something" is continued by the ownership
// loop 1 s after each turn (tasks/ownership.ts); past RESTART_LIMIT such restarts in the window its next automatic turn
// waits out the cooldown (its wake stays queued, due at the cooldown's end – nothing is dropped), one warning goes to the
// log and one quiet line into the chat. A person's message is no automatic restart: it still runs at once. After the
// cooldown the task continues. model.set now counts as a restart too and is refused while the agent cools down.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, openWakes, setup } from './fakes.ts';
import { RestartGuard, automaticGroup, RESTART_COOLDOWN_MS, RESTART_LIMIT, RESTART_WINDOW_MS } from '../../../src/runtime/agents/restart-guard.ts';
import { CONTINUE_MS } from '../../../src/runtime/tasks/ownership.ts';
import type { Wake } from '../../../src/runtime/contracts.ts';

const LIMIT = { limit: 3, windowMs: 60_000, cooldownMs: 300_000 };

function capture() {
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return { warnings, log: { debug() {}, info() {}, error() {}, warn(message: string, data?: Record<string, unknown>) { warnings.push({ message, data }); } } };
}

test('RestartGuard: at most `limit` automatic restarts per window, then a cooldown; spaced restarts never trip it', () => {
  const guard = new RestartGuard(LIMIT);
  const t0 = 1_000_000;
  assert.equal(guard.record('ag_tom', t0), undefined);
  assert.equal(guard.record('ag_tom', t0 + 1_000), undefined);
  assert.equal(guard.holdUntil('ag_tom', t0 + 1_000), undefined, 'below the limit nothing waits');
  const until = guard.record('ag_tom', t0 + 2_000);
  assert.equal(until, t0 + 2_000 + LIMIT.cooldownMs, 'the restart that reaches the limit starts the cooldown');
  assert.equal(guard.holdUntil('ag_tom', t0 + 3_000), until);
  assert.equal(guard.holdUntil('ag_ava', t0 + 3_000), undefined, 'per agent');
  assert.equal(guard.holdUntil('ag_tom', until), undefined, 'over once the cooldown has passed');
  assert.equal(guard.count('ag_tom', until), 0, 'a fresh budget after the cooldown');

  const spaced = new RestartGuard(LIMIT);
  for (let i = 0; i < 20; i++) assert.equal(spaced.record('ag_tom', t0 + i * (LIMIT.windowMs / 2 + 1)), undefined, `spaced restart ${i}`);

  const defaults = new RestartGuard();
  assert.deepEqual(defaults.limits, { limit: RESTART_LIMIT, windowMs: RESTART_WINDOW_MS, cooldownMs: RESTART_COOLDOWN_MS });
});

test('automaticGroup: only groups of retries and re-checks are automatic restarts', () => {
  const wake = (reason: Wake['reason']) => ({ id: `wk_${reason}`, agentId: 'ag_tom', reason, dueAt: 0, createdAt: 0, attempts: 0 }) as Wake;
  assert.equal(automaticGroup({ wakes: [wake('retry')] }), true);
  assert.equal(automaticGroup({ wakes: [wake('retry'), wake('review')] }), true);
  assert.equal(automaticGroup({ wakes: [wake('retry'), wake('message')] }), false, 'a message with it: someone asked');
  for (const reason of ['message', 'answer', 'task', 'schedule', 'event', 'child', 'handoff'] as const) assert.equal(automaticGroup({ wakes: [wake(reason)] }), false, reason);
  assert.equal(automaticGroup({ wakes: [] }), false);
});

test('an agent continuing its own task endlessly is held after the limit; a message still runs at once; the task goes on after the cooldown', async () => {
  const h = setup({ restartLimit: LIMIT });
  const { warnings, log } = capture();
  h.services.log = log as never;
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  const task = h.tasks.create({ conversationId: chat.id, title: 'Keep polishing the report', assigneeId: 'ag_tom', createdBy: 'human' });
  await flush();

  /** The running turn "did something" and ends; the ownership loop plans the next one in CONTINUE_MS. */
  const endTurn = async () => {
    const call = h.executor.last();
    h.ownership.afterTurn({ agentId: 'ag_tom', taskId: task.id, runId: call.request.runId, outcome: 'done', progressed: true });
    call.finish();
    await flush();
  };
  /** Time passes until the follow-up is due and the scheduler's one timer fires. */
  const later = async (ms: number) => {
    h.clock.advance(ms);
    if (h.timers.pending.length) h.timers.fire();
    await flush();
  };

  assert.equal(h.executor.calls.length, 1, 'the task turn (task news – no automatic restart)');
  for (let restart = 1; restart <= LIMIT.limit; restart++) {
    await endTurn();
    await later(CONTINUE_MS);
    assert.equal(h.executor.calls.length, 1 + restart, `automatic restart ${restart} runs`);
    assert.equal(h.executor.last().request.reason, 'retry');
  }
  assert.equal(warnings.filter((entry) => entry.message === 'agent restart limit reached').length, 1, 'one log entry when the limit takes effect');
  const line = h.chats.messages(chat.id).find((message) => message.kind === 'status' && /restarted its own work 3 times/.test(message.body));
  assert.ok(line, 'one quiet line in the chat says why the agent pauses');
  assert.equal(line!.authorId, 'ag_tom');

  await endTurn();
  await later(CONTINUE_MS);
  assert.equal(h.executor.calls.length, 1 + LIMIT.limit, 'the next automatic restart waits');
  const held = openWakes(h.db).filter((row) => row.reason === 'retry');
  assert.equal(held.length, 1, 'its wake is kept, not dropped');
  assert.equal(held[0].claimed_at, null);
  assert.ok(held[0].due_at > h.clock.now() + LIMIT.cooldownMs / 2, 'due when the cooldown ends');

  h.chats.send({ conversationId: chat.id, body: 'Tom, please also add the summary.', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 2 + LIMIT.limit, 'a person\'s message still runs at once');
  assert.equal(h.executor.last().request.reason, 'message');
  h.executor.last().finish();
  await flush();

  await later(LIMIT.cooldownMs);
  assert.equal(h.executor.calls.length, 3 + LIMIT.limit, 'after the cooldown the task continues');
  assert.equal(h.executor.last().request.taskId, task.id);
  assert.equal(warnings.filter((entry) => entry.message === 'agent restart limit reached').length, 1, 'still one log entry');
  h.executor.last().finish();
  await flush();
});

test('model.set now counts as a restart and is refused while the agent cools down', async () => {
  const h = setup({ restartLimit: { limit: 1, windowMs: 60_000, cooldownMs: 300_000 } });
  h.services.log = capture().log as never;
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'Refactor the parser, please.', authorId: 'human' });
  await flush();
  const first = h.executor.last();
  assert.equal(h.dispatcher.continueNow('ag_tom', first.request.runId, 'I switched models.'), true, 'the first restart is within the limit');
  await flush();
  const second = h.executor.last();
  assert.notEqual(second, first, 'it ran again at once');
  assert.equal(h.dispatcher.continueNow('ag_tom', second.request.runId, 'I switched models again.'), false, 'cooling down: the new model takes the next turn instead');
  await flush();
  assert.equal(h.executor.last(), second, 'no restart');
  second.finish();
  await flush();
});
