// Tests for the parts split out of the dispatcher (23.10. code size hygiene): the running turns
// (agents/dispatch-runs.ts – the executor runs a microtask after start, the wakes are settled done
// or released, the freed slot is handed on before the keep-awake lease follows, a crashed turn
// closes its run, live notes and activity rows, hooks of another run change nothing), the abort
// kinds (the first kind decides, a Stop after an urgent cut makes it a stop, a shutdown keeps the
// wakes, an urgent abort leaves a deferred boundary action) and the slot FIFO (agents/dispatch-slots.ts).
// The dispatcher's own behaviour stays covered by dispatcher.test.ts and its siblings.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortTurn, RunningTurns, type RunEntry } from '../../../src/runtime/agents/dispatch-runs.ts';
import { SlotQueue } from '../../../src/runtime/agents/dispatch-slots.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import type { LiveStatus } from '../../../src/runtime/agents/dispatch-live.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { RuntimeServices, Wake } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function wake(id: string, patch: Partial<Wake> = {}): Wake {
  return { id, agentId: 'ag_tom', reason: 'message', dueAt: 10, createdAt: 10, attempts: 0, ...patch };
}

function rig(execute: (request: TurnRequest) => Promise<TurnOutcome>) {
  const events: string[] = [];
  const finished: Array<{ runId: string; status: string }> = [];
  const services = {
    clock: { now: () => 1_000 },
    tasks: { get: (id: string) => ({ id, conversationId: 'cv_task', priority: 0 }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    wakes: { done: (ids: string[]) => events.push(`done:${ids.join(',')}`), release: (ids: string[]) => events.push(`release:${ids.join(',')}`) },
    runs: { get: () => ({ status: 'running' }), finish: (runId: string, patch: { status: string }) => finished.push({ runId, status: patch.status }) },
  } as unknown as RuntimeServices;
  const live = {
    awake: (on: boolean) => events.push(`awake:${on}`),
    status: (id: string, status: string, note?: string) => events.push(`status:${id}:${status}${note ? `:${note}` : ''}`),
    emit: () => events.push('emit'),
  } as unknown as LiveStatus;
  const ended: string[] = [];
  let turns!: RunningTurns;
  const supervisor = { admit: async () => () => {}, nudge: () => events.push('nudge') };
  turns = new RunningTurns({ services: () => services, executor: { execute }, supervisor }, live, (agentId) => {
    ended.push(agentId);
    events.push(`ended:${agentId}:running=${turns.has(agentId)}`);
  });
  return { services, events, finished, ended, turns };
}

const tom = { id: 'ag_tom' } as Agent;

test('a turn runs a microtask after start, settles its wakes and hands the slot on before the lease', async () => {
  let release!: (outcome: TurnOutcome) => void;
  const requests: TurnRequest[] = [];
  const r = rig((request) => { requests.push(request); return new Promise((resolve) => { release = resolve; }); });
  const [group] = groupWakes([wake('wk_1', { taskId: 'tk_1', note: 'from the schedule' }), wake('wk_2', { taskId: 'tk_1' })]);
  r.turns.start(r.services, tom, group!);
  assert.equal(requests.length, 0, 'never inside the caller');
  const entry = r.turns.get('ag_tom')!;
  assert.equal(entry.conversationId, 'cv_task', 'the task\'s chat when the wakes named only the task');
  assert.deepEqual(entry.wakeIds, ['wk_1', 'wk_2']);
  assert.equal(r.turns.byRunId(entry.runId), entry);
  assert.equal(r.turns.size, 1);
  await flush();
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.conversationId, undefined, 'the request keeps the group\'s chat');
  assert.equal(request.taskId, 'tk_1');
  assert.deepEqual(request.notes, [{ text: 'from the schedule', at: 10, reason: 'message' }]);
  assert.equal(request.signal, entry.controller.signal);
  request.onStatus?.('  running\n tests ');
  assert.equal(r.turns.activity()[0]!.note, 'running tests');
  release({ runId: entry.runId, status: 'done' });
  await entry.finished;
  assert.deepEqual(r.events, [
    'awake:true', 'status:ag_tom:working', 'status:ag_tom:working:running tests',
    'done:wk_1,wk_2', 'status:ag_tom:idle', 'nudge', 'ended:ag_tom:running=false', 'awake:false',
  ]);
  assert.equal(r.turns.size, 0);
});

test('released wakes after an urgent cut; a crashed turn closes its run as failed', async () => {
  const r = rig((request) => new Promise((resolve) => request.signal.addEventListener('abort', () => resolve({ runId: request.runId, status: 'interrupted' }))));
  r.turns.start(r.services, tom, groupWakes([wake('wk_1', { conversationId: 'cv_a' })])[0]!);
  await flush();
  const entry = r.turns.get('ag_tom')!;
  abortTurn(entry, 'Interrupted by an important message.', 'urgent', 'release');
  await entry.finished;
  assert.ok(r.events.includes('release:wk_1'));
  assert.deepEqual(r.ended, ['ag_tom']);

  const crash = rig(async () => { throw new Error('boom'); });
  crash.turns.start(crash.services, tom, groupWakes([wake('wk_9', { conversationId: 'cv_a' })])[0]!);
  const run = crash.turns.get('ag_tom')!;
  await run.finished;
  assert.deepEqual(crash.finished, [{ runId: run.runId, status: 'failed' }]);
  assert.ok(crash.events.includes('done:wk_9'), 'a crashed turn is not re-run');
});

function entryFor(): RunEntry {
  const r = rig(() => new Promise(() => {}));
  r.turns.start(r.services, tom, groupWakes([wake('wk_1', { conversationId: 'cv_a' })])[0]!);
  return r.turns.get('ag_tom')!;
}

test('abort kinds: the first decides, a Stop after an urgent cut is a stop, a shutdown keeps the wakes', () => {
  const urgent = entryFor();
  urgent.boundary.tool('call_1', true);
  assert.equal(urgent.boundary.at(() => {}), false);
  abortTurn(urgent, 'Interrupted by urgent work.', 'urgent', 'release');
  assert.equal(urgent.control.stopKind, 'urgent');
  assert.equal(urgent.settle, 'release');
  assert.equal(urgent.boundary.deferred, true, 'an urgent abort leaves the boundary action');
  const reason = urgent.controller.signal.reason as { code: string; details?: { stopKind?: string } };
  assert.equal(reason.code, 'cancelled');
  assert.equal(reason.details?.stopKind, 'urgent');
  abortTurn(urgent, 'The turn was stopped.', 'human');
  assert.equal(urgent.control.stopKind, 'human');
  assert.equal(urgent.settle, 'done', 'stopped work never comes back through the urgent hand-over');
  assert.equal(urgent.boundary.deferred, false);

  const human = entryFor();
  abortTurn(human, 'The turn was stopped.', 'human');
  abortTurn(human, 'Interrupted by urgent work.', 'urgent', 'release');
  assert.equal(human.control.stopKind, 'human');
  assert.equal(human.settle, 'done');
  abortTurn(human, 'The runtime is shutting down.', 'shutdown', 'release');
  assert.equal(human.control.stopKind, 'human', 'the first kind decides');
  assert.equal(human.settle, 'release', 'a shutdown keeps the wakes');
});

test('slot FIFO: each agent once, urgent work to the front, drain empties it', () => {
  const slots = new SlotQueue();
  slots.push('ag_a');
  slots.push('ag_b');
  slots.push('ag_c');
  assert.ok(slots.has('ag_b'));
  slots.toFront('ag_c');
  slots.toFront('ag_d');
  assert.equal(slots.size, 4);
  assert.equal(slots.shift(), 'ag_d');
  assert.equal(slots.has('ag_d'), false);
  assert.deepEqual(slots.drain(), ['ag_c', 'ag_a', 'ag_b']);
  assert.equal(slots.size, 0);
  assert.equal(slots.has('ag_a'), false);
  assert.equal(slots.shift(), undefined);
});
