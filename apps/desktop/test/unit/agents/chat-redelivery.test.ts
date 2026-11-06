// Chat retry assertions: repeated outages, transient errors, account recovery and runtime restart.
// Durable retries back off, do not expire, and share one due timer; no setup/cancelled retry or
// unknown effect. A queued retry stays unique until that attempt itself fails.
// Owns: these assertions only. Never: real engines, accounts or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { ChatRedelivery, REDELIVERY_LINE, REDELIVERY_NOTE, noteChatOutage, redeliverable } from '../../../src/runtime/agents/redelivery.ts';
import { COOLING_END_MARGIN_MS, ONLINE_SETTLE_MS, onlineDeliveryAt } from '../../../src/runtime/agents/outages.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { FakeTimers } from '../chat/harness.ts';
import { setup, type Script } from './fixture.ts';

const LOST: EngineTurnResult = { text: '', stop: 'error', error: { code: 'unavailable', message: 'The connection to Claude Code was lost.' } };

function rig(timers = new FakeTimers()) {
  const h = setup();
  h.services.router = { route: async () => h.route } as typeof h.services.router;
  let accounts: Account[] = [{ ...h.account, state: 'cooling', coolingUntil: h.clock.now() + 300_000 }];
  Object.assign(h.services.accounts, { list: () => accounts, markLimited: () => {}, markUnavailable: () => false });
  Object.assign(h.services.catalog, { list: () => [] });
  const journal = new Map<string, Run>();
  h.services.runs.start = (input) => { const run: Run = { ...input, status: 'running', startedAt: h.clock.now() }; journal.set(run.id, run); return run; };
  h.services.runs.finish = (id, patch) => {
    const run = { ...journal.get(id)!, ...patch };
    journal.set(id, run);
    h.bus.emit('run.upserted', run); // emitted before noteChatOutage, like the real journal
    return run;
  };
  let runs = 0;
  /** The person writes and the agent's turn runs (its message wake taken, as the dispatcher would). */
  const turn = async (script: EngineTurnResult | Script) => {
    h.state.script = typeof script === 'function' ? script : async () => script;
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++runs}` }));
  };
  const usable = () => { accounts = [{ ...h.account, state: 'ok' }]; h.bus.emit('account.upserted', accounts[0]); };
  const cooling = () => { accounts = [{ ...h.account, state: 'cooling', coolingUntil: h.clock.now() + 300_000 }]; h.bus.emit('account.upserted', accounts[0]); };
  /** B-059: the plan's window is used up for hours. */
  const limited = () => { accounts = [{ ...h.account, state: 'cooling', coolingUntil: h.clock.now() + 4 * 3600_000 }]; h.bus.emit('account.upserted', accounts[0]); };
  const retries = () => h.wakeRows().filter((row) => row.reason === 'retry' && row.conversation_id === h.chat.id);
  const lines = () => h.chats.messages(h.chat.id, { limit: 50 }).filter((message) => message.kind === 'status' && message.body === REDELIVERY_LINE);
  const redelivery = new ChatRedelivery({ services: () => h.services, timers });
  redelivery.watch();
  /** The host's power event 'online' (main forwards the app window's navigator 'online'). */
  const online = () => { for (const listener of h.powerListeners) listener('online'); };
  return { ...h, turn, usable, cooling, limited, retries, lines, redelivery, onlineTimers: timers, online };
}

test('redeliverable: outages and (B-059 C9) usage limits – never a setup the person must change or a Stop', () => {
  assert.equal(redeliverable({ code: 'unavailable' }), true);
  assert.equal(redeliverable({ code: 'unavailable', details: { setup: true } }), false);
  assert.equal(redeliverable({ code: 'rate_limited' }), true);
  assert.equal(redeliverable({ code: 'timeout' }), true);
  assert.equal(redeliverable({ code: 'internal' }), true);
  assert.equal(redeliverable({ code: 'internal', details: { setup: true } }), false);
  assert.equal(redeliverable({ code: 'cancelled' }), false);
  assert.equal(redeliverable(undefined), false);
});

test('a lost connection: the chat turn is delivered again once the account is usable, with one quiet line', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Summarize the report' });
  assert.equal((await h.turn(LOST)).status, 'failed');
  h.cooling();
  assert.equal(h.retries().length, 0, 'still cooling: nothing yet');
  h.usable();
  assert.equal(h.retries().length, 1);
  assert.equal(h.retries()[0].note, REDELIVERY_NOTE);
  assert.equal(h.lines().length, 1);
  assert.equal(h.lines()[0].silent, true, 'a quiet line');

  h.cooling();
  h.usable();
  assert.equal(h.retries().length, 1, 'one re-delivery per failure');
  assert.equal((await h.turn(LOST)).status, 'failed', 'the re-delivered turn fails again');
  h.cooling();
  h.usable();
  assert.equal(h.retries().length, 1, 'the recurring failure is retried once more');
  assert.equal(h.lines().length, 2);

  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'And the appendix, please' });
  assert.equal((await h.turn(LOST)).status, 'failed', 'a new message fails while still offline');
  h.cooling();
  h.usable();
  assert.equal(h.retries().length, 1, 'a new message is a new failure: delivered again once');
  assert.equal(h.lines().length, 3);
});

test('dropped when the chat moved on; not for unknown effects, setup errors or task turns', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Summarize the report' });
  await h.turn(LOST);
  await h.turn({ text: 'Here is the summary.', stop: 'done' }); // the person pressed Retry meanwhile
  h.chats.markRead(h.chat.id, h.tom.id, h.chats.messages(h.chat.id, { limit: 1 })[0].seq); // that turn read the chat (the fake context reports no new lines)
  h.cooling();
  h.usable();
  assert.equal(h.retries().length, 0);
  assert.equal(new KvRepo(h.db).list('redelivery').length, 0, 'the entry is gone');

  assert.equal(noteChatOutage(h.services, { agentId: h.tom.id, conversationId: h.chat.id, runId: 'run_x', cursor: 0, error: LOST.error, toolCalls: 2 }), false, 'effects of its tools unknown');
  assert.equal(noteChatOutage(h.services, { agentId: h.tom.id, conversationId: h.chat.id, runId: 'run_y', cursor: 0, error: { code: 'unavailable', message: 'x', details: { setup: true } }, toolCalls: 0 }), false);

  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.state.script = async () => LOST;
  await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_task', taskId: task.id, reason: 'task' }));
  assert.equal(new KvRepo(h.db).list('redelivery').length, 0, 'task turns are the ownership loop\'s');
});

test('onlineDeliveryAt: the settle time, or just past the end of the short coolings an outage leaves; limits and disabled accounts do not wait', () => {
  const now = 1_000_000;
  assert.equal(onlineDeliveryAt([], now), now + ONLINE_SETTLE_MS);
  assert.equal(onlineDeliveryAt([{ enabled: true, coolingUntil: now + 120_000 }, { enabled: true, coolingUntil: now + 200_000 }], now), now + 200_000 + COOLING_END_MARGIN_MS);
  assert.equal(onlineDeliveryAt([{ enabled: true, coolingUntil: now + 300_000 }], now), now + 300_000 + COOLING_END_MARGIN_MS, 'a fresh lost-connection cooling still counts');
  assert.equal(onlineDeliveryAt([{ enabled: true, coolingUntil: now + 2_000 }], now), now + ONLINE_SETTLE_MS, 'ends within the settle time');
  assert.equal(onlineDeliveryAt([{ enabled: true, coolingUntil: now - 1 }, { enabled: true }], now), now + ONLINE_SETTLE_MS, 'cooled down already');
  assert.equal(onlineDeliveryAt([{ enabled: true, coolingUntil: now + 15 * 60_000 }], now), now + ONLINE_SETTLE_MS, 'a limit waits for its reset elsewhere');
  assert.equal(onlineDeliveryAt([{ enabled: false, coolingUntil: now + 120_000 }], now), now + ONLINE_SETTLE_MS);
});

test('an API-key account (no monitor, no event when its cooling ends): after the host\'s online, delivered once that cooling is over', async () => {
  const h = rig();
  h.online();
  assert.equal(h.onlineTimers.pending.length, 0, 'nothing waits: nothing armed');
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Summarize the report' });
  assert.equal((await h.turn(LOST)).status, 'failed'); // the rig's account cools until start + 5 min, and no account event follows
  h.clock.advance(60_000);
  h.online();
  assert.equal(h.onlineTimers.only().ms, 300_000 + COOLING_END_MARGIN_MS, 'the timer armed at failure keeps its original cooling deadline');
  h.online();
  assert.equal(h.onlineTimers.pending.length, 1, 'one timer');
  assert.equal(h.retries().length, 0);
  h.clock.advance(240_000 + COOLING_END_MARGIN_MS);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
  assert.equal(h.retries()[0].note, REDELIVERY_NOTE);
  assert.equal(h.lines().length, 1);
  h.online();
  assert.equal(h.onlineTimers.pending.length, 0, 'used: not armed again');

  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'And the appendix, please' });
  assert.equal((await h.turn(LOST)).status, 'failed');
  h.online();
  assert.equal(h.onlineTimers.only().ms, ONLINE_SETTLE_MS, 'reconnection brings the backoff forward');
  h.redelivery.watch()();
  assert.equal(h.onlineTimers.pending.length, 0, 'the unsubscribe stops the timer');
});

test('the runtime start stands in for a lost "online": a chat that still waits is delivered again once', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Summarize the report' });
  assert.equal((await h.turn(LOST)).status, 'failed'); // the rig's account cools until start + 5 min
  h.clock.advance(400_000); // the runtime was down meanwhile: no 'online', no account event
  const timers = new FakeTimers();
  const restarted = new ChatRedelivery({ services: () => h.services, timers });
  const off = restarted.watch();
  assert.equal(timers.only().ms, ONLINE_SETTLE_MS, 'armed once at the start (cooled down already: only the settle time)');
  restarted.watch();
  assert.equal(timers.pending.length, 1, 'idempotent: one timer');
  h.clock.advance(ONLINE_SETTLE_MS);
  timers.fire();
  assert.equal(h.retries().length, 1);
  assert.equal(h.lines().length, 1);
  off();

  const again = new FakeTimers();
  new ChatRedelivery({ services: () => h.services, timers: again }).watch();
  assert.equal(again.pending.length, 0, 'used: a later start does not deliver it a second time');
});

const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };

test('B-059 C9: a chat turn cut by a usage limit is delivered again once, when the plan resets', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Draft the offer' });
  assert.equal((await h.turn(LIMIT)).status, 'failed');
  h.limited();
  assert.equal(h.retries().length, 0, 'still used up: nothing yet');
  h.usable(); // the monitor's reading after the reset (also an early one)
  assert.equal(h.retries().length, 1);
  assert.equal(h.retries()[0].note, REDELIVERY_NOTE);
  assert.equal(h.lines().length, 1);
  h.limited();
  h.usable();
  assert.equal(h.retries().length, 1, 'one re-delivery per failure');
});

test('B-059: a start or an "online" while every account is limited keeps the entry – the reset delivers it', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Draft the offer' });
  assert.equal((await h.turn(LIMIT)).status, 'failed');
  h.limited();
  h.online(); // a laptop waking at 01:00, hours before the reset
  assert.equal(h.onlineTimers.only().ms, 4 * 3600_000 + COOLING_END_MARGIN_MS, 'one timer waits for the known reset');
  h.clock.advance(ONLINE_SETTLE_MS);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 0, 'no turn that would fail on the used-up plan');
  assert.equal(new KvRepo(h.db).list<{ used?: boolean }>('redelivery')[0]?.value.used, undefined, 'its one re-delivery is not spent');
  const timers = new FakeTimers();
  new ChatRedelivery({ services: () => h.services, timers }).watch(); // a restart during the limit
  h.clock.advance(ONLINE_SETTLE_MS);
  timers.fire();
  assert.equal(h.retries().length, 0);
  h.usable();
  assert.equal(h.retries().length, 1, 'the reset delivers it');
  assert.equal(h.lines().length, 1);
});

test('a failed run schedules repeated retries without online events, doubling only after another failure', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  for (const minutes of [1, 2, 4, 8, 16, 30, 30]) {
    assert.equal((await h.turn(LOST)).status, 'failed');
    assert.equal(h.onlineTimers.only()?.ms, minutes * 60_000);
    assert.equal(h.retries().length, 0);
    h.clock.advance(minutes * 60_000);
    h.onlineTimers.fire();
    assert.equal(h.retries().length, 1);
    assert.equal(h.onlineTimers.pending.length, 0, 'a queued retry does not arm another timer');
  }
});

test('pending work survives a long absence and restarts with its original due time', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Prepare the report' });
  await h.turn(LOST);
  h.redelivery.watch()();
  h.clock.advance(4 * 86_400_000);
  const timers = new FakeTimers();
  const off = new ChatRedelivery({ services: () => h.services, timers }).watch();
  assert.equal(timers.only()?.ms, ONLINE_SETTLE_MS);
  h.clock.advance(ONLINE_SETTLE_MS);
  timers.fire();
  assert.equal(h.retries().length, 1, 'a pending chat has no age expiry');
  off();
});

test('the earliest eligible account cooling schedules recovery; signed-out and media accounts cannot wake it', async () => {
  const h = rig();
  const now = h.clock.now();
  Object.assign(h.services.accounts, { list: () => [
    { ...h.account, id: 'late', state: 'cooling', coolingUntil: now + 600_000 },
    { ...h.account, id: 'early', state: 'cooling', coolingUntil: now + 120_000 },
    { ...h.account, id: 'signed-out', state: 'needs_login', coolingUntil: now + 70_000 },
    { ...h.account, id: 'media', provider: 'elevenlabs', state: 'ok' },
  ] satisfies Account[] });
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Summarize the report' });
  await h.turn(LOST);
  assert.equal(h.onlineTimers.only()?.ms, 120_000 + COOLING_END_MARGIN_MS);
  h.clock.advance(120_000 + COOLING_END_MARGIN_MS);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
});

test('timeout and internal failures retry; a new input resets backoff and a provider hint is respected', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn({ text: '', stop: 'error', error: { code: 'timeout', message: 'Engine timed out.' } });
  assert.equal(h.onlineTimers.only()?.ms, 60_000);
  h.clock.advance(60_000);
  h.onlineTimers.fire();
  await h.turn({ text: '', stop: 'error', error: { code: 'internal', message: 'Engine exited.' } });
  assert.equal(h.onlineTimers.only()?.ms, 120_000);
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Use the updated report' });
  await h.turn({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Wait for provider.', retryAfterMs: 240_000 } });
  assert.equal(h.onlineTimers.only()?.ms, 240_000);
  assert.equal(new KvRepo(h.db).list<{ attempts: number }>('redelivery')[0]?.value.attempts, 1);
});

test('without a usable or cooling account, a pending retry waits for an event without a timer', async () => {
  const h = rig();
  Object.assign(h.services.accounts, { list: () => [{ ...h.account, state: 'needs_login' }] });
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn(LOST);
  assert.equal(h.onlineTimers.pending.length, 0);
  h.online();
  assert.equal(h.onlineTimers.pending.length, 0);
  assert.equal(new KvRepo(h.db).list('redelivery').length, 1);
  Object.assign(h.services.accounts, { list: () => [{ ...h.account, state: 'ok' }] });
  h.usable();
  assert.equal(h.retries().length, 1);
});

test('noting the same failed attempt twice keeps the queued retry and backoff unchanged', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  const result = await h.turn(LOST);
  h.clock.advance(60_000);
  h.onlineTimers.fire();
  const before = new KvRepo(h.db).list('redelivery')[0]?.value;
  assert.equal(noteChatOutage(h.services, { agentId: h.tom.id, conversationId: h.chat.id, runId: result.runId, cursor: 0, error: LOST.error, toolCalls: 0 }), true);
  assert.deepEqual(new KvRepo(h.db).list('redelivery')[0]?.value, before);
  assert.equal(noteChatOutage(h.services, { agentId: h.tom.id, conversationId: h.chat.id, runId: result.runId, cursor: 0, error: { code: 'bad_request', message: 'Duplicate report' }, toolCalls: 1 }), true);
  assert.deepEqual(new KvRepo(h.db).list('redelivery')[0]?.value, before, 'a duplicate report cannot change the queued attempt');
  h.redelivery.deliver();
  assert.equal(h.retries().length, 1);
  assert.equal(h.lines().length, 1);
});

test('pausing an agent preserves its pending retry until it resumes', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn(LOST);
  h.tom.status = 'paused';
  h.bus.emit('agent.upserted', h.tom);
  h.clock.advance(60_000);
  h.onlineTimers.fire();
  assert.equal(h.onlineTimers.pending.length, 0, 'the pending retry does not run while paused');
  h.redelivery.deliver();
  assert.equal(new KvRepo(h.db).list('redelivery').length, 1);
  h.clock.advance(120_000);
  h.tom.status = 'idle';
  h.bus.emit('agent.upserted', h.tom);
  assert.equal(h.onlineTimers.only()?.ms, 0);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
});

test('failed wake persistence leaves the retry pending and the quiet line is written once', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn(LOST);
  const wake = h.services.wakes.wake.bind(h.services.wakes);
  h.services.wakes.wake = () => { throw new Error('temporary write failure'); };
  h.clock.advance(60_000);
  h.onlineTimers.fire();
  assert.equal(new KvRepo(h.db).list<{ used?: boolean }>('redelivery')[0]?.value.used, undefined);
  assert.equal(h.lines().length, 0, 'the line and queued marker roll back together');
  assert.equal(h.onlineTimers.only()?.ms, 60_000, 'a persistence failure does not spin');
  h.services.wakes.wake = wake;
  h.clock.advance(60_000);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
  assert.equal(h.lines().length, 1);
});

test('online brings a long backoff forward, and streaming status events preserve the connection settle time', async () => {
  const h = rig();
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  for (const minutes of [1, 2, 4]) {
    await h.turn(LOST);
    h.clock.advance(minutes * 60_000);
    h.onlineTimers.fire();
  }
  await h.turn(LOST);
  assert.equal(h.onlineTimers.only()?.ms, 8 * 60_000);
  h.online();
  assert.equal(h.onlineTimers.only()?.ms, ONLINE_SETTLE_MS);
  const timer = h.onlineTimers.only();
  h.clock.advance(1000);
  for (let index = 0; index < 20; index++) h.bus.emit('agent.upserted', { ...h.tom, status: 'working', statusNote: `Step ${index}` });
  assert.equal(h.onlineTimers.only(), timer, 'status updates do not reschedule the retry');
  assert.equal(h.retries().length, 0);
  h.clock.advance(ONLINE_SETTLE_MS - 1000);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
});

test('online acceleration still waits for the earliest account cooling or usage reset', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn(LOST);
  h.limited();
  h.online();
  assert.equal(h.onlineTimers.only()?.ms, 4 * 3600_000 + COOLING_END_MARGIN_MS);
  h.cooling();
  h.online();
  assert.equal(h.onlineTimers.only()?.ms, 300_000 + COOLING_END_MARGIN_MS);
  h.clock.advance(300_000 + COOLING_END_MARGIN_MS);
  h.onlineTimers.fire();
  assert.equal(h.retries().length, 1);
});

test('a newer setup or bad-request failure ends the older pending retry', async () => {
  for (const error of [
    { code: 'unavailable', message: 'Setup must change.', details: { setup: true } },
    { code: 'bad_request', message: 'Invalid request.' },
  ] as const) {
    const h = rig();
    h.usable();
    h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
    await h.turn(LOST);
    assert.equal(new KvRepo(h.db).list('redelivery').length, 1);
    h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Use the corrected input' });
    await h.turn({ text: '', stop: 'error', error });
    assert.equal(new KvRepo(h.db).list('redelivery').length, 0);
    assert.equal(h.onlineTimers.pending.length, 0);
    h.clock.advance(300_000);
    h.online();
    h.cooling(); h.usable();
    assert.equal(h.retries().length, 0, `the old outage cannot retry the newer ${error.code}`);
  }
});

test('a newer attempt with an unknown tool outcome ends the older pending retry', async () => {
  const h = rig();
  h.services.runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.usable();
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Finish the report' });
  await h.turn(LOST);
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Check the latest report' });
  const outcome = await h.turn(async input => {
    input.onEvent({ type: 'tool_start', callId: 'unknown_action', name: 'bash', args: { command: 'export-report' }, own: true });
    return LOST; // the tool result never arrived
  });
  assert.ok(h.services.runs.items(outcome.runId).some(item => item.kind === 'tool_call'), 'the actual attempt started a native tool');
  assert.equal(new KvRepo(h.db).list('redelivery').length, 0);
  assert.equal(h.onlineTimers.pending.length, 0);
  h.cooling(); h.usable(); h.online();
  assert.equal(h.retries().length, 0, 'the old retry cannot bypass the unknown-effects guard');
});
