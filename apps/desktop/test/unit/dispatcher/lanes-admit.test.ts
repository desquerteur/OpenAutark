// B-057 S12 – heavy slots under splits: a split's turn asks the supervisor for a heavy (CLI) slot as background work
// (agents/dispatch-runs.ts launch), and the supervisor (system/supervisor.ts admit) gives a freed slot to the agents' own
// turns – the person's replies – before any waiting split, and never lets a split take a slot while one of those
// waits. Real supervisor on a fake OS (one heavy slot); a dispatcher with a recording supervisor and a fake executor.
// Owns: these assertions only. Never: real processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { flush, setup } from './fakes.ts';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import type { SplitService } from '../../../src/runtime/contracts.ts';
import type { SplitTurn } from '../../../src/shared/model/splits.ts';

/** A supervisor with exactly one heavy slot (little free RAM). */
const oneSlot = () => new Supervisor({ os: { freemem: () => 0, cpuCount: () => 8, setPriority: () => {}, platform: 'linux' } });

test('a freed heavy slot goes to an agent\'s own turn before the splits that waited longer', async () => {
  const supervisor = oneSlot();
  const order: string[] = [];
  const held = await supervisor.admit();
  const wait = (name: string, background: boolean) => supervisor.admit(undefined, background ? { background: true } : {}).then((release) => { order.push(name); return release; });
  const split1 = wait('split 1', true);
  const split2 = wait('split 2', true);
  await flush();
  const reply = wait('reply', false); // the person wrote while two splits wait
  await flush();
  assert.deepEqual(order, []);
  held();
  (await reply)();
  (await split1)();
  (await split2)();
  assert.deepEqual(order, ['reply', 'split 1', 'split 2']);
});

test('a split never takes a free slot while an agent\'s own turn waits; an aborted split leaves the queue', async () => {
  const supervisor = oneSlot();
  const held = await supervisor.admit();
  const reply = supervisor.admit();
  const aborted = new AbortController();
  const gone = supervisor.admit(aborted.signal, { background: true });
  aborted.abort(new Error('stopped'));
  await assert.rejects(gone, /stopped/);
  held();
  const releaseReply = await reply;
  let split = false;
  const later = supervisor.admit(undefined, { background: true }).then((release) => { split = true; return release; });
  await flush();
  assert.equal(split, false, 'the reply holds the slot');
  releaseReply();
  (await later)();
  assert.equal(split, true);
});

test('the dispatcher asks for a split turn\'s heavy slot as background work, for the agent\'s own turn as usual', async () => {
  const h = setup({ maxConcurrent: 4 });
  h.org.add(agent('ag_tom', 'Tom'));
  const asked: Array<{ background?: boolean } | undefined> = [];
  const dispatcher = new DispatcherImpl({
    services: () => h.services, executor: h.executor, maxConcurrent: 4,
    supervisor: { admit: async (_signal?: AbortSignal, options?: { background?: boolean }) => { asked.push(options); return () => {}; } },
  });
  h.services.dispatcher = dispatcher;
  const turn: SplitTurn = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 2, title: 'Part one', parentRunId: 'run_parent', parentThread: 'ch_x', context: 'brief', firstTurn: true };
  h.services.splits = {
    turnFor: () => turn, inputFor: () => [], get: () => undefined, onSplitRunEnd: () => {}, afterParentTurn: () => {}, stop: () => 0,
  } as unknown as SplitService;
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'go', authorId: 'human' });
  await flush();
  assert.equal(dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'started');
  await flush();
  const main = h.executor.calls.find((call) => !call.request.split)!;
  const lane = h.executor.calls.find((call) => call.request.split)!;
  await main.request.admit!(main.request.signal);
  await lane.request.admit!(lane.request.signal);
  assert.deepEqual(asked, [{}, { background: true }]);
  main.finish();
  lane.finish();
  await flush();
  await dispatcher.stop();
});

test('no split starts while the data disk is almost full (B-059 low-disk gate); it starts once space is back', async () => {
  const h = setup({ maxConcurrent: 4 });
  h.org.add(agent('ag_tom', 'Tom'));
  let free = 100 * 1024 ** 2;
  Object.assign(h.services, { paths: { ...(h.services.paths ?? {}), data: 'C:/data' } });
  const dispatcher = new DispatcherImpl({
    services: () => h.services, executor: h.executor, maxConcurrent: 4, freeBytes: () => free,
    supervisor: { admit: async () => () => {} },
  });
  h.services.dispatcher = dispatcher;
  const turn: SplitTurn = { splitId: 'sp_1', groupId: 'sg_1', idx: 1, of: 1, title: 'Part one', parentRunId: 'run_parent', parentThread: 'ch_x', context: 'brief', firstTurn: true };
  h.services.splits = {
    turnFor: () => turn, inputFor: () => [], get: () => undefined, onSplitRunEnd: () => {}, afterParentTurn: () => {}, stop: () => 0,
  } as unknown as SplitService;
  dispatcher.start();
  assert.equal(dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'busy');
  assert.equal(h.executor.calls.length, 0);
  free = 10 * 1024 ** 3;
  h.clock.advance(61_000); // the next reading (at most once a minute)
  assert.equal(dispatcher.startSplit({ agentId: 'ag_tom', splitId: 'sp_1' }), 'started');
  await flush();
  h.executor.last().finish();
  await flush();
  await dispatcher.stop();
});
