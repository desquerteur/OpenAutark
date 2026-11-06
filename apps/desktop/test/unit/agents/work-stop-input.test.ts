// The emergency stop of all agent work cuts computer input already running (23.10., agents/work-stop.ts with
// computer/activity.ts cutInput): an abort only rejects a helper call, so a typing or drag op that ignores it
// ends only when the helper process does – the stop ends that process, the fresh one then lets go of held keys
// and buttons, and computer use itself is not latched. Nothing is cut while no input op runs.
// Owns: these assertions only. Never: real helpers, screens or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkStop, bindWorkStop } from '../../../src/runtime/agents/work-stop.ts';
import { ComputerActivity, bindComputerActivity } from '../../../src/runtime/computer/activity.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { memoryDb, recordingBus } from '../store/helpers.ts';

/** A helper whose 'type' ignores its abort signal: only the end of the process ends it. */
class StubbornHelper implements HelperClient {
  calls: HelperOp[] = [];
  disposed = 0;
  private exit: Array<() => void> = [];
  async call<T>(op: HelperOp): Promise<T> {
    this.calls.push(op);
    if (op === 'release') return { released: ['shift'] } as T;
    if (op !== 'type') return { done: true } as T;
    return new Promise<T>((_resolve, reject) => { this.exit.push(() => reject(new Error('The helper process exited.'))); });
  }
  running(): boolean { return true; }
  async dispose(): Promise<void> { this.disposed++; for (const end of this.exit.splice(0)) end(); }
}

function rig() {
  const { bus } = recordingBus();
  const log = new MemoryLogger();
  const services = {
    db: memoryDb(), bus, log, clock: { now: () => 1 },
    devices: { self: () => ({ id: 'dev_tower', name: 'Tower' }) },
    dispatcher: { setHalted: () => {}, haltAll: () => ({ runIds: [], settled: Promise.resolve() }) },
  } as unknown as RuntimeServices;
  const stubborn = new StubbornHelper();
  const activity = new ComputerActivity({ now: () => 1, services: () => services });
  bindComputerActivity(services, activity);
  const helper = activity.wrapHelper(stubborn);
  const work = new WorkStop({ services: () => services });
  bindWorkStop(services, work);
  return { services, stubborn, activity, helper, work, log };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a typing op that ignores the abort ends at the stop: its helper process ends, held keys are released, computer use is not latched', async () => {
  const r = rig();
  const held = r.work.hold(new AbortController().signal); // a linked PC's computer.type running here
  const typing = r.helper.call('type', { text: 'a long text' }, { signal: held.signal });
  await settle();
  assert.deepEqual(r.stubborn.calls, ['type']);
  r.work.stop();
  await assert.rejects(typing, /helper process exited/);
  held.end();
  assert.equal(r.stubborn.disposed, 1, 'the helper process was ended');
  await settle();
  assert.deepEqual(r.stubborn.calls, ['type', 'release'], 'then a fresh helper lets go of what the cut op held');
  assert.equal(r.activity.stopped, false, 'the computer-use latch is its own');
  assert.ok(r.log.entries.some((entry) => /running computer input cut/.test(entry.message)));
});

test('nothing is cut while no input op runs; a runtime without computer use stops as before', async () => {
  const r = rig();
  await r.helper.call('click', { x: 1, y: 1 });
  r.work.stop();
  await settle();
  assert.deepEqual([r.stubborn.disposed, r.stubborn.calls], [0, ['click']]);

  const { bus } = recordingBus();
  const bare = { db: memoryDb(), bus, log: new MemoryLogger(), clock: { now: () => 1 }, dispatcher: { setHalted: () => {}, haltAll: () => ({ runIds: [], settled: Promise.resolve() }) } } as unknown as RuntimeServices;
  assert.equal(new WorkStop({ services: () => bare }).stop().stopped, true);
});
