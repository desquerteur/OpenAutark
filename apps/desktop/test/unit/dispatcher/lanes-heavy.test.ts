// B-057 S12 – heavy CLI slots and splits (system/supervisor.ts admit, agents/split-admit.ts, turn-attempt.ts):
// - the person is never blocked by split work: when every held heavy slot is background work (split turns), an agent's
//   own turn borrows one slot beyond maxHeavy – one at a time – and a split never borrows;
// - a split on an engine with a persistent per-account server (warm/prewarm – the Codex app-server) holds the slot only
//   while that server starts: three cold parts of one account start it once and run their turns at the same time;
//   another part that started it meanwhile frees the slot at once; a failed start ends the attempt like the engine's own
//   failed start; an abort while it starts interrupts at once (the slot frees when the start settles);
// - a split on an engine with one process per turn, and the agent's own turn, keep the slot for the whole turn.
// Real supervisor on a fake OS; runAttempt on the agents fixture with scripted engines. Owns: these assertions only.
// Never: real processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { RESERVE_MB, TURN_MB } from '../../../src/runtime/system/headroom.ts';
import { runAttempt } from '../../../src/runtime/agents/turn-attempt.ts';
import { accountFailure } from '../../../src/runtime/accounts/failure.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { Engine, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { TurnPlan, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { setup } from '../agents/fixture.ts';
import { flush } from './fakes.ts';

const MB = 1024 ** 2;
/** A supervisor with exactly `slots` heavy slots (system/headroom.ts: one only when starved, else the reserve plus TURN_MB per slot). */
const supervisorWith = (slots: number) => new Supervisor({
  os: { freemem: () => (slots === 1 ? 0 : (RESERVE_MB + slots * TURN_MB) * MB + 1), cpuCount: () => 8, setPriority: () => {}, platform: 'linux' },
});

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await flush(2);
  assert.ok(done(), 'condition not reached');
}

/** An admit that records its release when it gets a slot. */
function asking(supervisor: Supervisor, background: boolean) {
  let got: (() => void) | undefined;
  void supervisor.admit(undefined, background ? { background: true } : {}).then((release) => { got = release; });
  return {
    admitted: (): boolean => got !== undefined,
    release: (): void => { assert.ok(got, 'never admitted'); got(); },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** A scripted CLI engine: `persistent` gives it warm/prewarm (one shared server per account, like codex/engine.ts). */
function cliEngine(id: string, persistent: boolean, start?: () => Promise<void>) {
  const state = { warm: false, starts: 0, running: 0, maxRunning: 0, runs: 0 };
  const gate = deferred();
  let warming: Promise<void> | undefined;
  const engine: Record<string, unknown> = {
    id, caps: { sessions: false, dynamicTools: false, mcp: false, images: false, rebase: false, structured: false, ownTools: true },
    run: async (): Promise<EngineTurnResult> => {
      state.runs++;
      state.running++;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      await gate.promise;
      state.running--;
      return { text: 'Part done.', stop: 'done' };
    },
  };
  if (persistent) {
    engine.warm = () => state.warm;
    engine.prewarm = () => {
      if (state.warm) return Promise.resolve();
      warming ??= (async () => {
        state.starts++;
        await (start ? start() : flush(2));
        state.warm = true;
      })().finally(() => { warming = undefined; });
      return warming;
    };
  }
  return { engine: engine as unknown as Engine, state, gate };
}

type H = ReturnType<typeof setup>;

const part = (h: H, idx: number): SplitTurn => ({
  splitId: `sp_${idx}`, groupId: 'sg_1', idx, of: 3, title: `Part ${idx}`, parentRunId: 'run_parent', parentThread: h.chat.id,
  parentConversationId: h.chat.id, context: 'brief', firstTurn: true,
});

const planOf = (h: H, split?: SplitTurn) => ({
  agent: h.tom, mode: GENERAL_MODE, memberCursor: 0, focus: '',
  ...(split ? { thread: `split:${split.splitId}`, split } : { thread: h.chat.id, conversationId: h.chat.id }),
}) as unknown as TurnPlan;

/** The attempt of a split part (background admission, as dispatch-runs.ts asks for it) or of the agent's own turn. */
function attempt(h: H, supervisor: Supervisor, engine: Engine, idx: number, options: { own?: boolean; signal?: AbortSignal } = {}) {
  const split = options.own ? undefined : part(h, idx);
  const request: TurnRequest = h.request({
    runId: `run_${idx}`, admit: (signal: AbortSignal) => supervisor.admit(signal, split ? { background: true } : {}),
    ...(split ? { conversationId: undefined, reason: 'split' as const, split } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return runAttempt(h.services, planOf(h, split), { ...h.routed(), engine }, request, undefined);
}

test("the person's own turn borrows one slot beyond maxHeavy while only splits hold them; one at a time; splits never borrow", async () => {
  for (const slots of [1, 2]) {
    const supervisor = supervisorWith(slots);
    const splits: Array<() => void> = [];
    for (let i = 0; i < slots; i++) splits.push(await supervisor.admit(undefined, { background: true }));
    assert.equal(supervisor.canAdmit(), false, `maxHeavy ${slots}: full`);
    const waitingSplit = asking(supervisor, true);
    const reply = asking(supervisor, false);
    await flush();
    assert.ok(reply.admitted(), `maxHeavy ${slots}: the person's turn is admitted at once`);
    const second = asking(supervisor, false);
    await flush();
    assert.equal(second.admitted(), false, 'the borrowed slot is in use: the next own turn waits');
    assert.equal(waitingSplit.admitted(), false, 'a split never borrows');
    reply.release();
    await flush();
    assert.ok(second.admitted(), 'the freed borrowed slot goes to the waiting own turn');
    assert.equal(waitingSplit.admitted(), false);
    second.release();
    await flush();
    assert.equal(waitingSplit.admitted(), false, 'still full of split work');
    splits.shift()!();
    await flush();
    assert.ok(waitingSplit.admitted(), 'a split slot freed: the waiting split takes it');
    waitingSplit.release();
    for (const release of splits) release();
    assert.equal(supervisor.canAdmit(), true, 'every slot back');
  }
});

test("no borrowing while an agent's own turn holds a slot; a background admit with no slot free waits", async () => {
  const supervisor = supervisorWith(2);
  const own = await supervisor.admit();
  const split = await supervisor.admit(undefined, { background: true });
  const reply = asking(supervisor, false);
  const later = asking(supervisor, true);
  await flush();
  assert.equal(reply.admitted(), false, 'an own turn holds a slot: no borrowing');
  own();
  await flush();
  assert.ok(reply.admitted(), 'the freed slot goes to the waiting reply');
  assert.equal(later.admitted(), false);
  reply.release();
  await flush();
  assert.ok(later.admitted());
  later.release();
  split();
  assert.equal(supervisor.canAdmit(), true);
});

test('three cold split parts on one Codex-like account start its server once and run their turns at the same time', async () => {
  for (const slots of [1, 2]) {
    const h = setup();
    const supervisor = supervisorWith(slots);
    const { engine, state, gate } = cliEngine('codex', true);
    const attempts = [1, 2, 3].map((idx) => attempt(h, supervisor, engine, idx));
    await until(() => state.running === 3);
    assert.equal(state.starts, 1, `maxHeavy ${slots}: one server start for the account`);
    assert.equal(state.maxRunning, 3, 'the three turns overlap');
    assert.equal(supervisor.canAdmit(), true, 'no part holds a slot while its turn runs');
    const own = await supervisor.admit(); // the person's own turn meanwhile: a slot at once
    own();
    gate.resolve();
    const results = await Promise.all(attempts);
    assert.deepEqual(results.map((item) => item.result.stop), ['done', 'done', 'done']);
    assert.equal(supervisor.canAdmit(), true);
  }
});

test('a part whose server another part started while it waited frees the slot at once, without a start of its own', async () => {
  const h = setup();
  const supervisor = supervisorWith(1);
  const { engine, state, gate } = cliEngine('codex', true);
  const holder = await supervisor.admit(undefined, { background: true });
  const run = attempt(h, supervisor, engine, 1);
  await flush();
  assert.equal(state.runs, 0, 'waits for the slot');
  state.warm = true; // started meanwhile (another part, or the helper prewarm)
  holder();
  await until(() => state.running === 1);
  assert.equal(state.starts, 0);
  assert.equal(supervisor.canAdmit(), true, 'its slot freed at once');
  gate.resolve();
  assert.equal((await run).result.stop, 'done');
});

test("a failed server start ends the part like the engine's own failed start: 'unavailable', no turn, slot freed", async () => {
  const h = setup();
  const supervisor = supervisorWith(1);
  const { engine, state } = cliEngine('codex', true, async () => { throw new Error('spawn ENOENT'); });
  const { result } = await attempt(h, supervisor, engine, 1);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'unavailable');
  assert.equal(result.error?.message, 'Codex is not installed or could not start.');
  assert.equal(accountFailure(result), 'overload', 'a short cooling of the account, as when Codex itself cannot start');
  assert.equal(state.runs, 0);
  assert.equal(supervisor.canAdmit(), true);
});

test('a stop while the server starts interrupts the part at once; the slot frees when the start settles', async () => {
  const h = setup();
  const supervisor = supervisorWith(1);
  const starting = deferred();
  const { engine, state } = cliEngine('codex', true, () => starting.promise);
  const stop = new AbortController();
  const run = attempt(h, supervisor, engine, 1, { signal: stop.signal });
  await until(() => state.starts === 1);
  stop.abort(new Error('stopped'));
  const { result } = await run;
  assert.equal(result.stop, 'interrupted');
  assert.equal(state.runs, 0);
  assert.equal(supervisor.canAdmit(), false, 'the process is still coming up');
  starting.resolve();
  await flush();
  assert.equal(supervisor.canAdmit(), true);
});

test("a split on an engine with one process per turn, and the agent's own Codex turn, keep the slot for the whole turn", async () => {
  const h = setup();
  const supervisor = supervisorWith(1);
  const claude = cliEngine('claude', false);
  const split = attempt(h, supervisor, claude.engine, 1);
  await until(() => claude.state.running === 1);
  assert.equal(supervisor.canAdmit(), false, 'held for the whole turn');
  const reply = await supervisor.admit(); // only split work holds the slot: the person's turn borrows one
  reply();
  claude.gate.resolve();
  assert.equal((await split).result.stop, 'done');
  assert.equal(supervisor.canAdmit(), true);

  const codex = cliEngine('codex', true);
  const own = attempt(h, supervisor, codex.engine, 2, { own: true });
  await until(() => codex.state.running === 1);
  assert.equal(codex.state.starts, 0, 'the own turn starts its server in the engine itself, as before');
  assert.equal(supervisor.canAdmit(), false, 'held for the whole turn');
  codex.gate.resolve();
  assert.equal((await own).result.stop, 'done');
  assert.equal(supervisor.canAdmit(), true);
});
