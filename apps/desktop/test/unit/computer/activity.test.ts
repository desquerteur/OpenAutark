// Computer-use activity and the person's simple Stop (computer/activity.ts with ComputerService and
// devices/tools.ts): activity events at most once per second (trailing one-shot timer, "active"
// lingers after the last call), the Stop latch ends in-flight input (the helper process is stopped
// so a drag ends) and refuses new input and agents' computer tools with "Stopped by the person" –
// observing stays free for the person's preview; the latch survives a restart.
// Owns: these assertions only. Never: real screens, helpers or networks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_LINGER_MS, ComputerActivity, computerActivityOf, type ActivityTimers } from '../../../src/runtime/computer/activity.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { deviceTools, runRemoteTool, watched } from '../../../src/runtime/devices/tools.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { ComputerActivityState } from '../../../src/shared/model/computer.ts';
import { memoryDb, recordingBus } from '../store/helpers.ts';

/** Timers the test fires by hand (no real waiting). */
function manualTimers(): ActivityTimers & { due: Array<{ fn: () => void; ms: number; id: number }>; fire(): void } {
  let next = 1;
  const due: Array<{ fn: () => void; ms: number; id: number }> = [];
  return {
    due,
    set: (fn, ms) => { const id = next++; due.push({ fn, ms, id }); return id; },
    clear: (handle) => { const at = due.findIndex((entry) => entry.id === handle); if (at >= 0) due.splice(at, 1); },
    fire() { const entry = due.shift(); entry?.fn(); },
  };
}

/** A helper whose drag ('path' ending in 'drag') runs until it is stopped (or answered); everything else answers at once. */
class SlowHelper implements HelperClient {
  calls: HelperOp[] = [];
  disposed = 0;
  releasedAfterDispose = false;
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
    this.calls.push(op);
    if (op === 'release') { this.releasedAfterDispose = this.disposed > 0; return { released: ['left'] } as T; }
    if (op === 'presence') return { idleMs: 60_000, injectedAgoMs: null } as T;
    if (op === 'windows') return [] as T;
    if (op !== 'path' || args.end !== 'drag') return { done: true } as T;
    return new Promise<T>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
    });
  }
  running(): boolean { return true; }
  async dispose(): Promise<void> { this.disposed++; }
}

function host(): Host {
  return {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  };
}

interface FakeTask { id: string; conversationId: string; status: string; assigneeKind: string; title: string; parentId?: string; waitingOn?: unknown; createdBy?: string }

/** Services with a real kv table and bus, a tiny task store and this PC named Tower. */
function rig() {
  const db = memoryDb();
  const { bus, of } = recordingBus();
  let now = 100_000;
  const tasks = new Map<string, FakeTask>([['tk_1', { id: 'tk_1', conversationId: 'cv_1', status: 'working', assigneeKind: 'agent', title: 'Edit the video' }]]);
  const completed: Array<{ id: string; by: string }> = [];
  let todos = 0;
  const services = {
    db, bus, log: new MemoryLogger(), clock: { now: () => now },
    devices: { self: () => ({ id: 'dev_tower', name: 'Tower' }), list: () => [{ id: 'dev_laptop', name: 'Laptop', kind: 'pc', allow: { screen: true, control: true, browser: true } }] },
    secrets: { redact: (text: string) => text },
    settings: { get: () => ({ permissions: { grants: { computerUse: true, browser: true, phone: true }, hardStops: [] } }) },
    org: { get: () => undefined },
    tasks: {
      get: (id: string) => tasks.get(id),
      create: (input: Omit<FakeTask, 'id' | 'status'>) => { const task = { ...input, id: `td_${++todos}`, status: 'open' }; tasks.set(task.id, task); return task; },
      update: (id: string, patch: Partial<FakeTask>) => { const task = { ...tasks.get(id)!, ...patch }; tasks.set(id, task); return task; },
      complete: (id: string, _result: unknown, by: string) => { completed.push({ id, by }); tasks.set(id, { ...tasks.get(id)!, status: 'done' }); return tasks.get(id); },
    },
  } as unknown as RuntimeServices;
  const helper = new SlowHelper();
  const computer = new ComputerService({
    host: host(), supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(),
    helper, platform: 'win32', services: () => services, now: () => now,
  });
  return { services, computer, helper, tasks, completed, events: () => of('computer.activity') as ComputerActivityState[], tick: (ms: number) => { now += ms; } };
}

function ctx(services: RuntimeServices, patch: Partial<ToolContext> = {}): ToolContext {
  return {
    agent: { id: 'ag_mira', name: 'Mira' } as ToolContext['agent'], runId: 'run_1', mode: 'computer', services,
    signal: new AbortController().signal, status: () => undefined, ...patch,
  };
}

test('activity events: at most one per second, the latest state last, inactive after the linger', async () => {
  const timers = manualTimers();
  let now = 0;
  const sent: ComputerActivityState[] = [];
  const { bus } = recordingBus();
  bus.on('computer.activity', (state) => sent.push(state));
  const activity = new ComputerActivity({ now: () => now, timers, services: () => ({ bus, db: memoryDb(), log: new MemoryLogger(), clock: { now: () => now } }) as unknown as RuntimeServices });

  await activity.run({ agent: 'Mira', summary: 'Click at 1,1' }, async () => 'ok');
  now += 200;
  await activity.run({ agent: 'Mira', summary: 'Click at 2,2' }, async () => 'ok');
  now += 200;
  await activity.run({ agent: 'Ben', fromDevice: 'Laptop', summary: 'Type 4 characters' }, async () => 'ok');
  assert.equal(sent.length, 1, 'the first change goes out at once, the next ones wait for the second to pass');
  assert.deepEqual([sent[0].agent, sent[0].summary, sent[0].active], ['Mira', 'Click at 1,1', true]);
  const trailing = timers.due.find((entry) => entry.ms === 800); // set by the second change (at 200 ms)
  assert.ok(trailing, 'one trailing timer for the rest of the second (no poll)');
  now += 600;
  trailing.fn();
  timers.clear(trailing.id);
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].agent, sent[1].fromDevice, sent[1].summary], ['Ben', 'Laptop', 'Type 4 characters'], 'the latest state, not every step');

  const linger = timers.due.find((entry) => entry.ms === ACTIVE_LINGER_MS);
  assert.ok(linger, 'active lingers after the last call');
  now += ACTIVE_LINGER_MS;
  linger.fn();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].active, false);
  assert.equal(sent[2].agent, undefined, 'nothing names an agent once idle');
});

test('Stop ends a running drag (the helper process is stopped), refuses new input, lets the preview look; Resume lifts it', async () => {
  const r = rig();
  const drag = r.computer.drag({ x1: 0, y1: 0, x2: 500, y2: 0, durationMs: 4000, motion: 'instant' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.helper.calls, ['path'], 'the drag is in flight');
  const state = r.computer.activity.stop();
  assert.equal(state.stopped, true);
  await assert.rejects(drag, /^WorkforceError: Stopped by the person/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.helper.disposed, 1, 'a running input op ends only with the helper process');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.helper.calls, ['path', 'release'], 'then the fresh helper lets go of what the cut drag held');
  assert.equal(r.helper.releasedAfterDispose, true);

  await assert.rejects(r.computer.click({ x: 1, y: 1 }), /Stopped by the person: computer use on this PC is paused/);
  await assert.rejects(r.computer.act({ name: 'OK', window: 3, action: 'invoke' }), /Stopped by the person/);
  assert.deepEqual(r.helper.calls, ['path', 'release'], 'no input reached the helper');
  assert.deepEqual(await r.computer.windows(), [], 'observing (the person\'s preview) still works');

  assert.equal(r.computer.activity.resume().stopped, false);
  await r.computer.click({ x: 1, y: 1, motion: 'instant' });
  assert.deepEqual(r.helper.calls.slice(-1), ['click']);
  const events = r.events();
  assert.deepEqual(events.map((event) => event.stopped), [true, false], 'Stop and Resume are announced at once');
});

test('a call already running when the person stops ends with "Stopped by the person"', async () => {
  const r = rig();
  const slow: ToolDef = {
    name: 'computer.drag', description: '', category: 'device', remote: true, inputSchema: { type: 'object' },
    describe: () => ({ summary: 'Drag from 0,0 to 9,9', reversible: false, external: false }),
    run: (_args, c) => new Promise((_resolve, reject) => { c.signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true }); }),
  };
  const tool = watched(slow, r.computer.activity);
  const running = tool.run({}, ctx(r.services, { taskId: 'tk_1' }));
  r.computer.activity.stop();
  await assert.rejects(running, /^WorkforceError: Stopped by the person/);
});

test('the Stop survives a restart (kv) and the RPC handlers reach the hub through the runtime services', () => {
  const r = rig();
  assert.equal(computerActivityOf(r.services), r.computer.activity, 'bound when the service saw the runtime services');
  r.computer.activity.stop();
  const again = new ComputerActivity({ now: () => 1, services: () => r.services });
  assert.equal(again.stopped, true, 'a restarted runtime keeps the person\'s Stop');
  assert.throws(() => again.guard(), /Stopped by the person/);
  again.resume();
  assert.equal(new ComputerActivity({ now: () => 2, services: () => r.services }).stopped, false);
  assert.throws(() => computerActivityOf({}), /not available/);
});

test('X02: a Stop from a phone names it – kept across a restart, cleared by Resume; agents hear they wait for Resume', () => {
  const r = rig();
  const stopped = r.computer.activity.stop('Pixel');
  assert.deepEqual([stopped.stopped, stopped.stoppedFrom], [true, 'Pixel']);
  assert.equal(r.computer.activity.stop('iPad').stoppedFrom, 'Pixel', 'the first stopper stays while stopped');
  assert.equal(r.events().at(-1)?.stoppedFrom, 'Pixel', 'the event names the phone');
  const again = new ComputerActivity({ now: () => 1, services: () => r.services });
  assert.equal(again.current().stoppedFrom, 'Pixel', 'restored from kv');
  assert.throws(() => again.guard(), /until they press Resume/);
  const resumed = again.resume();
  assert.deepEqual([resumed.stopped, resumed.stoppedFrom], [false, undefined]);
  assert.equal(new ComputerActivity({ now: () => 2, services: () => r.services }).current().stoppedFrom, undefined);
  assert.equal(new ComputerActivity({ now: () => 3, services: () => r.services }).stop().stoppedFrom, undefined, "this PC's own Stop names no phone");
});
