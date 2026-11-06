// B-057 S13 – the person's Stop of an agent's own turn stops the split groups that turn created and that have not started,
// at the moment of the Stop (agents/split-stop.ts from dispatcher.ts personStop) – not only when the run ends – on every
// person-Stop path: runs.cancel (cancelRun), messages.stop and a task's stop or take-back (interrupt), the emergency stop
// (haltAll). A split lane's stop, an urgent cut and a shutdown do not; a Stop after a shutdown cut stays a cut. With the
// real split service: the groups end 'stopped' (PARENT_STOPPED) at once, a restart before the run's end starts nothing,
// and the run's own end later finds nothing pending. Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, setup } from './fakes.ts';
import { abortTurn, runEntry } from '../../../src/runtime/agents/dispatch-runs.ts';
import { stopPendingSplits } from '../../../src/runtime/agents/split-stop.ts';
import { PARENT_STOPPED } from '../../../src/runtime/splits/service.ts';
import type { RuntimeServices, SplitService } from '../../../src/runtime/contracts.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';
import { CHAT, PARENT, part, world } from '../splits/fixture.ts';

const TURN: SplitTurn = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'Part one', parentRunId: 'run_old', parentThread: 'ch_x', context: 'brief', firstTurn: true };

test("every person's Stop of a turn stops its pending split groups at once; a split lane's stop and a shutdown do not", async () => {
  const h = setup({ maxConcurrent: 4 });
  h.org.add(agent('ag_tom', 'Tom'));
  const after: Array<[string, string]> = [];
  h.services.splits = {
    afterParentTurn: (runId: string, status: string) => { after.push([runId, status]); },
    turnFor: () => TURN, inputFor: () => [], get: () => undefined, onSplitRunEnd: () => {}, stop: () => 0,
  } as unknown as SplitService;
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' }).id;
  h.dispatcher.start();
  const turn = async (body: string) => {
    h.chats.send({ conversationId: chat, body, authorId: 'human' });
    await flush();
    return h.executor.last().request.runId;
  };

  let runId = await turn('build it');
  const cancelling = h.dispatcher.cancelRun(runId); // runs.cancel
  assert.deepEqual(after, [[runId, 'stopped']], 'at the moment of the Stop, before the run ended');
  await cancelling;

  runId = await turn('and again');
  const interrupting = h.dispatcher.interrupt('ag_tom', chat); // messages.stop; a task's stop or take-back
  assert.deepEqual(after.at(-1), [runId, 'stopped']);
  await interrupting;

  runId = await turn('third try');
  assert.equal(h.dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'started');
  await flush();
  const lane = h.dispatcher.splitLanes()[0]!.runId;
  const halted = h.dispatcher.haltAll('All agent work was stopped by the person.'); // the emergency stop: the split lane too
  assert.deepEqual(halted.runIds.length, 2);
  assert.deepEqual(after.slice(2), [[runId, 'stopped']], "the split lane's run created no group: no call for it");
  assert.ok(!after.some(([id]) => id === lane));
  await halted.settled;
  assert.equal(after.length, 3);

  await turn('fourth');
  await h.dispatcher.stop(); // a shutdown cut: its groups start at the run's end (S14), not stopped here
  assert.equal(after.length, 3);
});

test('stopPendingSplits: only after the person\'s Stop of an own turn; a shutdown cut stays a cut; failures stay quiet', () => {
  const calls: Array<[string, string]> = [];
  const warned: string[] = [];
  const services = {
    splits: { afterParentTurn: (runId: string, status: string) => { calls.push([runId, status]); } },
    log: { warn: (message: string) => { warned.push(message); } },
  } as unknown as RuntimeServices;
  const entry = (lane = 'ag_tom', split?: SplitTurn) => runEntry({ runId: `run_${calls.length}_${lane}`, agentId: 'ag_tom', lane, reason: 'message', wakeIds: [], attempts: 0, startedAt: 0, ...(split ? { split } : {}) });

  const urgent = entry();
  abortTurn(urgent, 'Interrupted by an important message.', 'urgent', 'release');
  stopPendingSplits(services, urgent);
  assert.deepEqual(calls, [], 'an urgent hand-over is no Stop');
  abortTurn(urgent, 'The turn was stopped.', 'human'); // the person's Stop after the urgent cut makes it a stop
  stopPendingSplits(services, urgent);
  assert.deepEqual(calls, [[urgent.runId, 'stopped']]);

  const shutdown = entry();
  abortTurn(shutdown, 'The runtime is shutting down.', 'shutdown', 'release');
  abortTurn(shutdown, 'The turn was stopped.', 'human');
  stopPendingSplits(services, shutdown);
  assert.equal(calls.length, 1, 'the first kind decides: a cut stays a cut');

  const splitLane = entry('ag_tom#sp_1', TURN);
  abortTurn(splitLane, 'The split was stopped.', 'human');
  stopPendingSplits(services, splitLane);
  assert.equal(calls.length, 1, 'a split never splits');

  const failing = { splits: { afterParentTurn: () => { throw new Error('db locked'); } }, log: services.log } as unknown as RuntimeServices;
  const stopped = entry();
  abortTurn(stopped, 'The turn was stopped.', 'human');
  assert.doesNotThrow(() => stopPendingSplits(failing, stopped));
  assert.equal(warned.length, 1);
  assert.doesNotThrow(() => stopPendingSplits({ log: services.log } as unknown as RuntimeServices, stopped), 'no split service wired');
});

test("with the split service: the Stop ends the turn's pending groups at once; a restart before the run's end and the end itself start nothing", () => {
  const w = world();
  const view = w.splits.create(w.ctx(), { goal: 'Review the release', parts: [part('A'), part('B', { after: [1] })] });
  const entry = runEntry({ runId: PARENT, agentId: 'ag_ava', lane: 'ag_ava', reason: 'message', wakeIds: [], attempts: 0, startedAt: 0, conversationId: CHAT });
  abortTurn(entry, 'The turn was stopped.', 'human');
  stopPendingSplits(w.services, entry);
  const group = w.splits.list({ groupId: view.id })[0]!;
  assert.equal(group.status, 'stopped');
  assert.deepEqual(group.splits.map((split) => [split.status, split.error]), [['stopped', PARENT_STOPPED], ['stopped', PARENT_STOPPED]]);

  // The app restarts before the stopped turn ended: its run is still open, then marked interrupted by the boot recovery.
  w.runs.finish(PARENT, { status: 'interrupted', endedAt: w.clock.now() });
  const again = w.restart();
  again.splits.reconcile();
  assert.deepEqual(again.lanes.started, [], 'nothing starts after the restart');

  // The run's own end (turn-finish, or a release) later: nothing pending any more.
  w.splits.afterParentTurn(PARENT, 'stopped');
  w.splits.afterParentTurn(PARENT, 'done');
  assert.deepEqual(w.lanes.started, []);
  assert.equal(w.splits.list({ groupId: view.id })[0]!.status, 'stopped');
  assert.equal(w.wakes.list('ag_ava').length, 0, 'nobody is woken');
});
