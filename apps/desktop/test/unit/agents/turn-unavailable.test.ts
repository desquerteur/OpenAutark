// Outages of task turns (T04): a turn that cannot start because no model or account is there
// (failBeforeEngine with "No model is connected.") and an engine 'unavailable' error (signed
// out, connection lost) reach ownership as 'unavailable' – no stall, no escalation, no block,
// retried after at least 1 min – and an account that becomes usable re-wakes the task, whose
// next turn then runs. Such an outage posts one quiet "Paused: …" line, no failed bubble per
// retry (T06). Other errors before the engine still count as failed attempts with a bubble.
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { errorOutcome, taskOutcome } from '../../../src/runtime/agents/turn-finish.ts';
import { NO_MODEL_MESSAGE } from '../../../src/runtime/routing/router.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { account } from '../models/harness.ts';
import { setup } from './fixture.ts';

const MINUTE = 60_000;

function taskSetup() {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.tasks.claim(task.id, h.tom.id);
  const routing: { fail?: () => Error } = { fail: () => new WorkforceError('unavailable', NO_MODEL_MESSAGE) };
  Object.assign(h.services, {
    router: { route: async () => { const error = routing.fail?.(); if (error) throw error; return h.route; } },
  });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  let runs = 0;
  /** One task turn the way the dispatcher runs it: the due follow-ups are claimed first. */
  const run = () => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++runs}`, taskId: task.id, reason: 'retry' }));
  };
  const current = () => h.tasks.get(task.id)!;
  const followUp = () => h.wakes.list(h.tom.id).find((wake) => wake.claimedAt === undefined && wake.taskId === task.id);
  return { ...h, task, routing, run, current, followUp };
}

test('error outcomes: limits, outages (unavailable, cancelled) and real failures', () => {
  assert.equal(errorOutcome({ code: 'rate_limited' }), 'limit');
  assert.equal(errorOutcome({ code: 'unavailable' }), 'unavailable');
  assert.equal(errorOutcome({ code: 'cancelled' }), 'unavailable');
  assert.equal(errorOutcome({ code: 'internal' }), 'failed');
  // A setup only the person can change (tier, capability, model policy) escalates instead of retrying quietly.
  assert.equal(errorOutcome({ code: 'unavailable', details: { setup: true } }), 'failed');
  assert.equal(errorOutcome({ code: 'unavailable', details: { need: 'computerUse', setup: true } }), 'failed');
  assert.equal(errorOutcome({ code: 'budget_exceeded' }), 'failed', 'the budget check blocks it with its own reason');
  assert.equal(errorOutcome(undefined), 'failed');
  const signedOut: EngineTurnResult = { text: '', stop: 'error', error: { code: 'unavailable', message: 'Claude Code is not signed in.' } };
  assert.equal(taskOutcome(signedOut, 'working', undefined), 'unavailable');
  assert.equal(taskOutcome({ stop: 'error', error: { code: 'internal', message: 'x' } }, 'working', undefined), 'failed');
});

test('no model connected: the turn fails before the engine, the task neither stalls nor escalates nor blocks', async () => {
  const h = taskSetup();
  const unread = h.chats.summary(h.chat.id).unread;
  for (let i = 0; i < 14; i++) {
    const outcome = await h.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, NO_MODEL_MESSAGE);
    assert.equal(outcome.messageId, undefined, 'no failed agent bubble per retry');
  }
  // T06: one quiet line for the whole outage – no red bubbles, nothing unread.
  const messages = h.chats.messages(h.chat.id);
  assert.deepEqual(messages.filter((message) => message.authorKind === 'agent' && message.state === 'failed'), []);
  assert.deepEqual(messages.filter((message) => message.kind === 'status' && message.body.startsWith('Paused:')).map((message) => message.body),
    ['Paused: No model is connected. Add an account in Settings → Models. – continues by itself']);
  assert.equal(h.chats.summary(h.chat.id).unread, unread);
  const task = h.current();
  assert.equal(task.status, 'working', 'more outages than the attempt cap (12)');
  assert.equal(task.ledger.tried!.at(-1)!.outcome, 'unavailable');
  assert.equal(task.ledger.tried!.at(-1)!.approach, NO_MODEL_MESSAGE);
  assert.equal(task.ledger.stalls ?? 0, 0);
  assert.deepEqual(h.notified.filter((item) => item.kind === 'blocker'), [], 'nobody is told the task is blocked');
  const wake = h.followUp()!;
  assert.ok(wake.dueAt - h.clock.now() >= MINUTE, 'retried after at least 1 min');
  assert.match(wake.note!, /could not reach a model/);
});

test('other errors before the engine stay failed attempts (a stall)', async () => {
  const h = taskSetup();
  h.routing.fail = () => new Error('prompt assembly broke');
  const failed = await h.run();
  const task = h.current();
  assert.equal(task.ledger.tried!.at(-1)!.outcome, 'failed');
  assert.equal(task.ledger.stalls, 1);
  assert.ok(failed.messageId, 'a real failure keeps its visible failed bubble');
  // A chat turn without a task that finds no model keeps its bubble too.
  h.routing.fail = () => new WorkforceError('unavailable', NO_MODEL_MESSAGE);
  const chat = await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_chat' }));
  assert.ok(chat.messageId);
});

test('an engine outage (signed out) is unavailable too, and a usable account re-wakes the task, whose next turn runs', async () => {
  const h = taskSetup();
  h.ownership.watchOutages();
  h.routing.fail = undefined;
  h.state.script = async () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Claude Code is not signed in.' } });
  const failed = await h.run();
  assert.equal(failed.status, 'failed');
  assert.equal(h.current().ledger.tried!.at(-1)!.outcome, 'unavailable');
  assert.equal(h.current().ledger.stalls ?? 0, 0);
  const planned = h.followUp()!;
  assert.ok(planned.dueAt - h.clock.now() >= MINUTE);

  // The person signs in again (or adds an account): the follow-up is due now.
  h.bus.emit('account.upserted', account('acc_claude', 'claude'));
  assert.equal(h.followUp()!.dueAt, h.clock.now());

  h.state.script = async () => ({ text: 'Cut the intro to 12 seconds.', stop: 'done' });
  const next = await h.run();
  assert.equal(next.status, 'done');
  const task = h.current();
  assert.equal(task.ledger.tried!.at(-1)!.outcome, 'done');
  assert.equal(task.status, 'working');
});
