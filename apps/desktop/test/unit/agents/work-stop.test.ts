// Tests for the person's emergency stop of all agent work (21.10. 17:09, agents/work-stop.ts with
// the real dispatcher and run journal): Stop aborts every running turn at once as the person's Stop,
// holds new turns and survives a restart (kv); Resume lets what waited run. The RPC tiers and the 'work.state' event follow the computer-use brake.
// Live test C4: the stop asks every engine to end its background commands (Engine.stopBackground).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { FakeExecutor, flush, openWakes, setup } from '../dispatcher/fakes.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { WorkStop, bindWorkStop, workStopOf } from '../../../src/runtime/agents/work-stop.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { SecretService } from '../../../src/runtime/contracts.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

function stage() {
  const h = setup();
  h.org.add(agent('ag_tom', 'Tom'));
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  h.services.secrets = { redact: (text: string) => text } as unknown as SecretService;
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const stop = new WorkStop({ services: () => h.services });
  bindWorkStop(h.services, stop);
  return { h, runs, chat, stop };
}

test('Stop: every running turn ends at once (mid-call too), nothing starts until Resume, then what waited runs', async () => {
  const { h, runs, chat, stop } = stage();
  h.dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'pay the supplier', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  runs.start({ id: call.request.runId, agentId: 'ag_tom', conversationId: chat.id, trigger: 'message' });
  // Our external call in flight: the registry marks it unknown when the abort cuts it (tools/registry.ts).
  const pay = runs.item(call.request.runId, { kind: 'tool_call', name: 'payments.pay', data: { callId: 'c1', summary: 'Pay 120 EUR to ACME', category: 'spend' }, effectStatus: 'pending' });
  call.request.signal.addEventListener('abort', () => runs.updateItem(pay.id, { effectStatus: 'unknown' }), { once: true });
  // An engine-native command without its result.
  runs.item(call.request.runId, { kind: 'tool_call', name: 'shell', data: { callId: 'n1', own: true, args: 'git push' }, effectStatus: 'none' });
  call.request.onTool?.('c1', true);

  const state = stop.stop();
  assert.equal(state.stopped, true);
  assert.equal(state.stoppedRuns, 1);
  assert.equal(call.request.signal.aborted, true, 'the emergency stop does not wait for the tool boundary');
  assert.equal(call.request.control.stopKind, 'human', 'a task the turn worked on pauses (turn-finish: stopped)');
  assert.equal(h.tasks.list({}).some((task) => task.title.startsWith('Did this happen?')), false, 'no "Did this happen?" to-dos');

  h.chats.send({ conversationId: chat.id, body: 'what happened?', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1, 'held while stopped');
  assert.equal(stop.stop().at, state.at, 'a second Stop changes nothing');
  const resumed = stop.resume();
  assert.equal(resumed.stopped, false);
  await flush();
  assert.equal(h.executor.calls.length, 2, 'the message written meanwhile is answered after Resume');
  h.executor.last().finish();
  await flush();
  assert.equal(openWakes(h.db).length, 0);
  assert.deepEqual(h.of('work.state').map((item) => item.stopped), [true, false], 'stop, resume');
});

test('a stored stop survives a restart: the new runtime starts held until the person resumes', async () => {
  const { h, chat, stop } = stage();
  stop.stop('Pixel 9');
  await h.dispatcher.stop();
  // "Restart": a new dispatcher and latch on the same database.
  const executor = new FakeExecutor();
  const dispatcher = new DispatcherImpl({ services: () => h.services, executor, supervisor: { admit: async () => () => {} }, maxConcurrent: 2 });
  h.services.dispatcher = dispatcher;
  const again = new WorkStop({ services: () => h.services });
  assert.deepEqual({ stopped: again.current().stopped, from: again.current().stoppedFrom }, { stopped: true, from: 'Pixel 9' });
  again.restore();
  dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'still there?', authorId: 'human' });
  await flush();
  assert.equal(executor.calls.length, 0, 'held from the start');
  again.resume();
  await flush();
  assert.equal(executor.calls.length, 1, 'Resume lets it run');
  assert.equal(new WorkStop({ services: () => h.services }).current().stopped, false, 'the latch is gone from the store');
  executor.last().finish();
  await flush();
  await dispatcher.stop();
});

test('RPC: work.state and work.stop for every paired device, work.resume needs full access; no stop without a halting dispatcher', () => {
  const table = createHandlerTable();
  assert.deepEqual(table.get('work.state')!.scope, { capability: 'todo' });
  assert.deepEqual(table.get('work.stop')!.scope, { capability: 'todo' });
  assert.deepEqual(table.get('work.resume')!.scope, { capability: 'manage' });
  const { h } = stage();
  assert.equal(workStopOf(h.services).stopped, false);
  assert.throws(() => workStopOf({}), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  const plain = setup();
  Object.assign(plain.services, { dispatcher: { activity: () => [] } });
  assert.throws(() => new WorkStop({ services: () => plain.services }).stop(), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
});

test('live test C4: the stop asks every engine to end its background commands at once; a failing engine does not stop the brake', async () => {
  const { h, stop } = stage();
  const asked: string[] = [];
  const engines = [
    { id: 'sync', stopBackground: () => { asked.push('sync'); throw new Error('thrown at once'); } }, // before codex: the others are still asked
    { id: 'codex', stopBackground: async () => { asked.push('codex'); return 2; } },
    { id: 'claude' }, // no background commands of its own to end
    { id: 'fake', stopBackground: async () => { asked.push('fake'); throw new Error('server gone'); } },
  ];
  (h.services as unknown as { engines: unknown }).engines = { all: () => engines, get: () => undefined, disposeIdle: async () => {} };
  const state = stop.stop();
  assert.equal(state.stopped, true);
  assert.deepEqual(asked, ['sync', 'codex', 'fake'], 'asked within the stop itself');
  assert.equal(stop.current().stopped, true);
  stop.resume();
  // A registry that cannot build its engines: the brake still holds (the failure is logged).
  (h.services as unknown as { engines: unknown }).engines = { all: () => { throw new Error('factory failed'); }, get: () => undefined, disposeIdle: async () => {} };
  assert.equal(stop.stop().stopped, true);
  stop.resume();
});

test("scopes: 'work.state' reaches every paired device holding 'todo' (the brake's state on the phone), not one without", () => {
  const device = (capabilities: DeviceCapability[], secure: boolean): ClientScope => ({ kind: 'device', deviceId: 'dev_pixel', capabilities, secure });
  const state = { stopped: true, at: 1, stoppedRuns: 1 };
  for (const scope of [device(['todo'], false), device(['todo', 'chat', 'manage'], true)]) assert.equal(mayReceive(scope, 'system', 'work.state', state), true);
  assert.equal(mayReceive(device(['chat'], true), 'system', 'work.state', state), false, 'only with todo');
  assert.equal(mayReceive({ kind: 'owner' }, 'system', 'work.state', state), true);
});
