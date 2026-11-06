// B-057 × B-059 #18 – a split lane whose tool ignores the abort is released like a main-lane turn (agents/dispatch-settle.ts
// armRelease, dispatch-runs.ts release): after the grace its run is closed ('interrupted', a 'released' journal note), the
// lane frees – the lane-free listeners fire, the agent shows idle – and after the person's Stop the split service hears
// the end (split-turn.ts turnEndedEarly: 'stopped'); after a shutdown's cut it does not (the hung turn's own late end puts
// the part back, never a second turn beside it). A lane that ends in time is never released. Dispatcher harness with a
// hanging executor, and RunningTurns on fake services. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, setup } from './fakes.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import { abortTurn, runEntry, RunningTurns } from '../../../src/runtime/agents/dispatch-runs.ts';
import { laneKey } from '../../../src/runtime/agents/dispatch-lanes.ts';
import type { LiveStatus } from '../../../src/runtime/agents/dispatch-live.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { RuntimeServices, SplitService } from '../../../src/runtime/contracts.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';

const TURN: SplitTurn = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'Part one', parentRunId: 'run_parent', parentThread: 'ch_x', context: 'brief', firstTurn: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a split lane that ignores the person's Stop is released after the grace: run closed, split stopped, lane free", async () => {
  const h = setup({ maxConcurrent: 4 });
  h.org.add(agent('ag_tom', 'Tom'));
  const ends: Array<Record<string, unknown>> = [];
  h.services.splits = {
    turnFor: () => TURN, inputFor: () => [], get: () => undefined, afterParentTurn: () => {}, stop: () => 0,
    onSplitRunEnd: (splitId: string, end: Record<string, unknown>) => { ends.push({ splitId, ...end }); },
  } as unknown as SplitService;
  const requests: TurnRequest[] = [];
  const dispatcher = new DispatcherImpl({
    services: () => h.services, maxConcurrent: 4, releaseMs: 20, supervisor: { admit: async () => () => {} },
    executor: {
      execute: (request) => {
        requests.push(request);
        h.runStatus.set(request.runId, 'running');
        return new Promise<TurnOutcome>(() => {}); // a tool that never settles and ignores the signal
      },
    },
  });
  h.services.dispatcher = dispatcher;
  let freed = 0;
  dispatcher.onLaneFree(() => { freed++; });
  dispatcher.start();
  assert.equal(dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'started');
  await flush();
  const runId = requests[0]!.runId;
  const before = freed;
  assert.equal(dispatcher.stopSplit('sp_1', 'human'), true);
  await flush();
  assert.equal(dispatcher.splitLanes().length, 1, 'still held within the grace');
  assert.deepEqual(ends, []);
  await sleep(60);
  await flush();
  assert.deepEqual(dispatcher.splitLanes(), [], 'released');
  assert.deepEqual(ends, [{ splitId: 'sp_1', runId, status: 'stopped' }], 'the split service heard the end once');
  assert.deepEqual(h.finishedRuns, [{ runId, status: 'interrupted' }]);
  assert.ok(h.runItems.some((item) => item.runId === runId && item.kind === 'note' && item.data.released === true && item.data.stopKind === 'human'));
  assert.ok(freed > before, 'the freed lane fires the lane-free listeners');
  assert.equal(h.org.get('ag_tom')!.status, 'idle');
  await dispatcher.stop();
});

function lanes(execute: (request: TurnRequest) => Promise<TurnOutcome>) {
  const ends: Array<Record<string, unknown>> = [];
  const ended: Array<[string, boolean | undefined]> = [];
  const finished: Array<{ runId: string; status?: string }> = [];
  const services = {
    clock: { now: () => 1 }, log: { info() {}, warn() {}, error() {}, debug() {} },
    runs: {
      item: () => undefined, items: () => [], get: () => ({ status: 'running' }),
      finish: (runId: string, patch: { status?: string }) => { finished.push({ runId, status: patch.status }); },
    },
    splits: { onSplitRunEnd: (splitId: string, end: Record<string, unknown>) => { ends.push({ splitId, ...end }); } },
  } as unknown as RuntimeServices;
  const live = { awake() {}, status() {}, emit() {} } as unknown as LiveStatus;
  const turns = new RunningTurns({ services: () => services, executor: { execute }, supervisor: { admit: async () => () => {} }, releaseMs: 20 }, live, (agentId, split) => { ended.push([agentId, split]); });
  const entry = runEntry({ runId: 'run_s1', agentId: 'ag_tom', lane: laneKey('ag_tom', 'sp_1'), reason: 'split', split: TURN, wakeIds: [], attempts: 0, startedAt: 0 });
  turns.launch(services, entry, { runId: 'run_s1', agentId: 'ag_tom', reason: 'split', split: TURN, notes: [] });
  return { turns, entry, ends, ended, finished };
}

test("a split lane cut by a shutdown and hung frees its lane but stays the split service's until its own late end; one that ends in time is never released", async () => {
  let late!: (outcome: TurnOutcome) => void;
  const hung = lanes(() => new Promise<TurnOutcome>((resolve) => { late = resolve; }));
  await flush();
  abortTurn(hung.entry, 'The split was cut off.', 'shutdown', 'release');
  await sleep(60);
  await flush();
  assert.deepEqual(hung.turns.lanes(), []);
  // Not put back here: a dispatcher started again (prepareRestart cancelled) would run a second turn on the split's
  // session while the hung one still works; its late end (turn-finish, or the boot reconcile) puts it back instead.
  assert.deepEqual(hung.ends, [], 'the split service is not told at the release');
  assert.deepEqual(hung.finished, [{ runId: 'run_s1', status: 'interrupted' }]);
  assert.deepEqual(hung.ended, [['ag_tom', true]]);
  late({ runId: 'run_s1', status: 'interrupted' });
  await flush();
  assert.deepEqual(hung.ends, [], 'the dispatcher adds nothing at the late end (turn-finish reports it)');
  assert.deepEqual(hung.ended, [['ag_tom', true]], 'its lane freed once');

  const prompt = lanes((request) => new Promise<TurnOutcome>((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ runId: request.runId, status: 'interrupted' }), { once: true });
  }));
  await flush();
  abortTurn(prompt.entry, 'The split was stopped.', 'human');
  await sleep(60);
  await flush();
  assert.deepEqual(prompt.turns.lanes(), []);
  assert.deepEqual(prompt.ends, [], 'its own finish reports (here: none) – no release report');
  assert.deepEqual(prompt.finished, [], 'its run is not closed by a release');
  assert.deepEqual(prompt.ended, [['ag_tom', true]], 'its lane freed once');
});
