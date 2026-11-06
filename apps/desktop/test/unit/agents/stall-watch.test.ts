// B-044 engine stall watchdog (agents/stall-watch.ts, agents/turn-attempt.ts): an engine quiet for
// 10 min (45 min while a tool call runs) is cut and the attempt ends 'unavailable' ("The engine stopped
// responding.") – an account failure, so failover applies; events and call ends restart the quiet time;
// the turn's own abort wins (no stall).
// Owns: these assertions only. Never: real engines or real waiting (fake timers, a manual clock).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { STALL_IDLE_MS, STALL_MESSAGE, STALL_TOOL_MS, StallWatch, type StallTimers } from '../../../src/runtime/agents/stall-watch.ts';
import { canFailover, runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { accountFailure } from '../../../src/runtime/accounts/failure.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { TurnPlan } from '../../../src/runtime/agents/turn-types.ts';
import { setup } from './fixture.ts';

const MINUTE = 60_000;

/** Fake timers: `run(ms)` advances the clock and fires what is due. */
function rig(options: { parent?: AbortController } = {}) {
  const clock = new ManualClock(0);
  let pending: { fn: () => void; at: number } | undefined;
  const timers: StallTimers = { set: (fn, ms) => { pending = { fn, at: clock.now() + ms }; return pending; }, clear: () => { pending = undefined; } };
  const parent = options.parent ?? new AbortController();
  const watch = new StallWatch({ now: () => clock.now(), parent: parent.signal, timers });
  const run = (ms: number) => {
    const until = clock.now() + ms;
    while (pending && pending.at <= until) { const due = pending; pending = undefined; clock.set(due.at); due.fn(); }
    clock.set(until);
  };
  return { clock, watch, run, parent };
}

test('quiet for 10 minutes: the attempt is cut as unavailable', () => {
  const { watch, run } = rig();
  watch.start();
  run(STALL_IDLE_MS - 1);
  assert.equal(watch.signal.aborted, false);
  run(1);
  assert.equal(watch.stalled, true);
  assert.ok(watch.signal.aborted);
  const reason = watch.signal.reason as WorkforceError;
  assert.ok(reason instanceof WorkforceError && reason.code === 'unavailable' && reason.message === STALL_MESSAGE);
});

test('events restart the quiet time; a running tool call allows 45 minutes', () => {
  const { watch, run } = rig();
  watch.start();
  run(9 * MINUTE);
  watch.activity();
  run(9 * MINUTE);
  assert.equal(watch.stalled, false, 'an event 9 minutes in moves the limit');
  watch.call('call_1', true);
  run(40 * MINUTE);
  assert.equal(watch.stalled, false, 'a build may run long');
  run(STALL_TOOL_MS - 40 * MINUTE);
  assert.equal(watch.stalled, true);
});

test('a call that ended counts as an event; the limit is the idle one again', () => {
  const { watch, run } = rig();
  watch.start();
  watch.call('call_1', true);
  run(30 * MINUTE);
  watch.call('call_1', false);
  run(STALL_IDLE_MS - 1);
  assert.equal(watch.stalled, false);
  run(1);
  assert.equal(watch.stalled, true);
});

test('the turn\'s own abort is never a stall', () => {
  const b = rig();
  b.watch.start();
  b.parent.abort(new WorkforceError('cancelled', 'Stopped'));
  b.run(STALL_IDLE_MS);
  assert.equal(b.watch.stalled, false);
  assert.ok(b.watch.signal.aborted, 'the engine still sees the Stop');
});

test('runAttempt: a silent engine is cut after 10 minutes, ends unavailable and may fail over', async () => {
  const h = setup();
  const plan: TurnPlan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  h.state.script = (input) => new Promise((resolve) => {
    started();
    input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted' }), { once: true });
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const attempt = runAttempt(h.services, plan, h.routed(), h.request(), undefined);
    await running;
    h.clock.advance(STALL_IDLE_MS);
    mock.timers.tick(STALL_IDLE_MS);
    const result = await attempt;
    assert.equal(result.result.stop, 'error');
    assert.deepEqual(result.result.error, { code: 'unavailable', message: STALL_MESSAGE, details: { stalled: true } });
    assert.equal(accountFailure(result.result), 'overload', 'a short cooling for the account, not a sign-in');
    assert.equal(canFailover(result, new AbortController().signal), true, 'no tool ran: another account may take it');
    assert.ok(h.items.some((item) => item.kind === 'note' && (item.data as { stalled?: unknown }).stalled), 'the run journal names the cut');
  } finally {
    mock.timers.reset();
  }
});

test('runAttempt: timeout review status keeps an approved long-running local tool alive', async () => {
  const h = setup({ dynamicTools: true, mcp: false });
  const plan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let report!: (note: string) => void;
  let finish!: () => void;
  h.services.tools.get = () => undefined;
  h.services.tools.call = async (_name, _args, ctx) => {
    report = ctx.status;
    started();
    await new Promise<void>((resolve) => { finish = resolve; });
    return { content: [{ type: 'text', text: 'finished' }] };
  };
  let signal!: AbortSignal;
  h.state.script = async (input) => {
    signal = input.signal;
    await input.callTool('shell.exec', {}, 'c1');
    return { text: 'Done', stop: 'done' };
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const attempt = runAttempt(h.services, plan, h.routed(), h.request(), undefined);
    await running;
    for (let minute = 0; minute < 60; minute++) {
      h.clock.advance(MINUTE);
      mock.timers.tick(MINUTE);
      if (minute % 25 === 0) report('Subconscious chose another 1800 seconds');
    }
    assert.equal(signal.aborted, false, 'a reviewed tool may keep running beyond the old 45-minute limit');
    finish();
    assert.equal((await attempt).result.stop, 'done');
  } finally { mock.timers.reset(); }
});

test('runAttempt: the person\'s Stop stays an interrupt, never a stall', async () => {
  const h = setup();
  const plan: TurnPlan = { agent: h.tom, mode: GENERAL_MODE, conversationId: h.chat.id, memberCursor: 0, focus: '' } as unknown as TurnPlan;
  const stop = new AbortController();
  h.state.script = (input) => new Promise((resolve) => {
    input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted' }), { once: true });
    setImmediate(() => stop.abort(new WorkforceError('cancelled', 'Stopped by the person')));
  });
  const result = await runAttempt(h.services, plan, h.routed(), h.request({ signal: stop.signal }), undefined);
  assert.equal(result.result.stop, 'interrupted');
});
