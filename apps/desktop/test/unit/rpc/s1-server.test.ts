// RPC server core (R3-S1): framing, dispatch, scopes, parallel calls, event fan-out by topic
// and scope, run.item routing, connection cleanup, the unauthenticated HTTP route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { RpcServer } from '../../../src/runtime/rpc/server.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { memoryConnection, portConnection } from '../../../src/runtime/rpc/connection.ts';
import type { RpcConnection } from '../../../src/runtime/rpc/connection.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Run, RunItem } from '../../../src/shared/model/runs.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { register as system } from '../../../src/runtime/rpc/handlers/system.ts';
import { OWNER, PHONE, TODO_ONLY, TestClient, fakeExtras, settle } from './s1-helpers.ts';

function message(conversationId: string, id = 'msg_1'): Message {
  return {
    id, conversationId, seq: 1, authorId: 'human', authorKind: 'human', kind: 'text', body: 'hi', attachments: [], mentions: [],
    priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: 0,
  };
}

/** A tiny table with test methods plus the real system module (events.subscribe …). */
function setup(options: { runs?: Map<string, Run> } = {}) {
  const bus = new Bus((error) => { throw error; });
  const runs = options.runs ?? new Map<string, Run>();
  let runLookups = 0;
  const services = {
    bus, log: nullLogger, clock: { now: () => 1000 },
    runs: { get: (id: string) => { runLookups++; return runs.get(id); } },
  } as unknown as RuntimeServices;
  const table = new HandlerTable();
  system(table);
  const gates: Array<() => void> = [];
  const seen: HandlerContext[] = [];
  table.add('spaces.list', async (_params, ctx) => {
    seen.push(ctx);
    await new Promise<void>((resolve) => gates.push(resolve)); // held until released
    return [];
  });
  table.add('agents.org', () => { throw new Error('boom with secret sk-123'); });
  table.add('agents.templates', () => { throw new WorkforceError('conflict', 'Busy.'); });
  table.add('todos.list', () => [], { capability: 'todo' });
  const server = new RpcServer({ services: () => services, extras: () => fakeExtras(), table, log: nullLogger });
  return { bus, server, gates, seen, runs, lookups: () => runLookups };
}

test('request/response, JSON text frames and error mapping', async () => {
  const { server } = setup();
  const client = new TestClient(server, OWNER);
  const ok = await client.request('system.info');
  assert.equal((ok.result as { deviceName: string }).deviceName, 'Test PC');

  // String (WebSocket) frames are parsed too.
  const replies: unknown[] = [];
  client.raw.onFrame((frame) => replies.push(frame));
  client.raw.send(JSON.stringify({ id: 99, method: 'system.info' }));
  await settle(); await settle();
  assert.ok(replies.some((frame) => (frame as { id: number }).id === 99 && 'result' in (frame as object)));

  const internal = await client.request('agents.org');
  assert.deepEqual(internal.error, { code: 'internal', message: 'Something went wrong. It was logged.' });
  const conflict = await client.request('agents.templates');
  assert.equal(conflict.error?.code, 'conflict');
  assert.equal(conflict.error?.message, 'Busy.');
});

test('unknown method → not_found; bad method name → bad_request; garbage is ignored', async () => {
  const { server } = setup();
  const client = new TestClient(server, OWNER);
  assert.equal((await client.request('nope.nothing')).error?.code, 'not_found');
  assert.equal((await client.request(42 as unknown as string)).error?.code, 'bad_request');
  client.raw.send('not json');
  client.raw.send({ event: 'x', data: 1 });
  client.raw.send({ method: 'system.info' }); // no id → nothing to reply to
  await settle(); await settle();
  assert.equal(client.raw.received.length, 2);
});

test('device scopes are limited by the method scope rules', async () => {
  const { server } = setup();
  const phone = new TestClient(server, PHONE);
  assert.equal((await phone.request('system.resources')).error?.code, 'forbidden');
  assert.ok((await phone.request('todos.list')).result);
  const peer = new TestClient(server, { kind: 'peer', deviceId: 'dev_pc' });
  assert.equal((await peer.request('system.info')).error?.code, 'forbidden');
  const noTodo = new TestClient(server, { kind: 'device', deviceId: 'dev_x', capabilities: ['chat'] });
  assert.equal((await noTodo.request('todos.list')).error?.code, 'forbidden');
});

test('requests run in parallel: a slow call does not block later ones', async () => {
  const { server, gates } = setup();
  const client = new TestClient(server, OWNER);
  const slow = client.request('spaces.list');
  const fast = await client.request('system.info');
  assert.ok(fast.result, 'fast call answered while the slow one is pending');
  assert.equal(gates.length, 1);
  gates[0]();
  assert.deepEqual((await slow).result, []);
});

test('events reach only subscribed connections whose scope may see them', async () => {
  const { server, bus } = setup();
  const owner = new TestClient(server, OWNER);
  const phone = new TestClient(server, PHONE);
  const todo = new TestClient(server, TODO_ONLY);
  const idle = new TestClient(server, OWNER);
  await owner.call('events.subscribe', { topics: ['chats', 'chat:ch_a', 'providers', 'system'] });
  await phone.call('events.subscribe', { topics: ['chats', 'chat:ch_a', 'providers', 'system', 'tasks'] });
  await todo.call('events.subscribe', { topics: ['chats', 'chat:ch_a', 'tasks', 'system'] });

  bus.emit('message.created', message('ch_a'));
  bus.emit('message.created', message('ch_b', 'msg_2'));
  bus.emit('usage.updated', []);
  bus.emit('settings.updated', {} as never);
  bus.emit('notify', { kind: 'todo', title: 'Record intro', body: '' });
  bus.emit('task.removed', { id: 'task_1', conversationId: 'ch_a' });
  await settle();

  assert.deepEqual(owner.events().map((e) => e.event), ['message.created', 'usage.updated', 'settings.updated', 'notify']);
  assert.deepEqual(phone.events().map((e) => e.event), ['message.created', 'usage.updated', 'notify', 'task.removed'], 'chat phones get usage, never settings');
  assert.deepEqual(todo.events().map((e) => e.event), ['notify', 'task.removed'], "no chat content without the 'chat' capability");
  assert.equal(idle.events().length, 0);

  await owner.call('events.unsubscribe', { topics: ['chat:ch_a'] });
  bus.emit('message.created', message('ch_a', 'msg_3'));
  await settle();
  assert.equal(owner.events('message.created').length, 1);
});

test('events.subscribe validates topics', async () => {
  const { server } = setup();
  const owner = new TestClient(server, OWNER);
  assert.equal((await owner.request('events.subscribe', { topics: ['bogus'] })).error?.code, 'bad_request');
  assert.equal((await owner.request('events.subscribe', { topics: 'chats' })).error?.code, 'bad_request');
  assert.equal((await owner.request('events.subscribe', { topics: ['chat:'] })).error?.code, 'bad_request');
  assert.equal((await owner.request('events.subscribe', { topics: ['runs:ag_1', 'chat:manager'] })).result?.constructor, Object);
});

test('run.item goes to runs:<agentId> only (agent resolved via run.upserted cache or the journal)', async () => {
  const runs = new Map<string, Run>([['run_old', { id: 'run_old', agentId: 'ag_b', trigger: 'message', status: 'running' }]]);
  const { server, bus, lookups } = setup({ runs });
  const watcherA = new TestClient(server, OWNER);
  const watcherB = new TestClient(server, OWNER);
  const orgOnly = new TestClient(server, OWNER);
  const phone = new TestClient(server, PHONE);
  await watcherA.call('events.subscribe', { topics: ['runs:ag_a'] });
  await watcherB.call('events.subscribe', { topics: ['runs:ag_b'] });
  await orgOnly.call('events.subscribe', { topics: ['org'] });
  await phone.call('events.subscribe', { topics: ['runs:ag_a', 'org'] });

  bus.emit('run.upserted', { id: 'run_new', agentId: 'ag_a', trigger: 'message', status: 'running' });
  const item = (runId: string): RunItem => ({ id: 'ri_1', runId, seq: 1, kind: 'tool_call', data: {}, createdAt: 0 });
  bus.emit('run.item', item('run_new'));
  bus.emit('run.item', item('run_old'));
  bus.emit('run.item', item('run_missing'));
  await settle();

  assert.deepEqual(watcherA.events().map((e) => e.event), ['run.upserted', 'run.item']);
  assert.deepEqual(watcherB.events().map((e) => e.event), ['run.item']);
  assert.equal(orgOnly.events().length, 0, 'run items do not flood the org topic');
  assert.equal(phone.events().length, 0, 'runs topics are owner-only');
  assert.equal(lookups(), 2, 'cached run_new; looked up run_old and run_missing');
});

test('closing a connection aborts its calls, drops its topics and releases the bus', async () => {
  const { server, bus, seen, gates } = setup();
  const pair = memoryConnection();
  server.attach(pair.server, OWNER);
  pair.client.send({ id: 1, method: 'events.subscribe', params: { topics: ['chats'] } });
  pair.client.send({ id: 2, method: 'spaces.list' });
  await settle(); await settle();
  assert.equal(server.size, 1);
  const signal = seen[0].signal;
  assert.equal(signal.aborted, false);
  pair.client.close();
  assert.equal(signal.aborted, true);
  assert.equal(server.size, 0);
  gates[0](); // the pending call finishes after close: its reply is dropped
  await settle(); await settle();
  assert.equal(pair.client.received.filter((frame) => (frame as { id?: number }).id === 2).length, 0);
  const before = pair.client.received.length;
  bus.emit('conversation.removed', { id: 'ch_x' });
  await settle();
  assert.equal(pair.client.received.length, before);
});

test('a throwing connection never throws into the bus and is detached', async () => {
  const { server, bus } = setup();
  let listener: ((data: unknown) => void) | undefined;
  let closed = 0;
  const replies: unknown[] = [];
  const broken: RpcConnection = {
    send: (frame) => {
      if ((frame as object) && 'event' in (frame as object)) throw new Error('socket gone');
      replies.push(frame);
    },
    close: () => { closed++; },
    onMessage: (fn) => { listener = fn; },
    onClose: () => {},
  };
  const healthy = new TestClient(server, OWNER);
  await healthy.call('events.subscribe', { topics: ['chats'] });
  server.attach(broken, OWNER);
  listener!({ id: 1, method: 'events.subscribe', params: { topics: ['chats'] } });
  await settle(); await settle();
  assert.equal(replies.length, 1);
  assert.equal(server.size, 2);
  // The bus here rethrows listener errors, so a throw would surface from emit().
  bus.emit('conversation.removed', { id: 'ch_x' });
  assert.equal(server.size, 1, 'the broken connection was detached');
  assert.ok(closed >= 1);
  await settle();
  assert.equal(healthy.events('conversation.removed').length, 1, 'other connections still get the event');
});

test('revoking a device closes its live connections', async () => {
  const { server, bus } = setup();
  const phone = new TestClient(server, PHONE);
  const owner = new TestClient(server, OWNER);
  bus.emit('device.upserted', { id: 'dev_phone', status: 'online' } as never);
  assert.equal(phone.raw.closed, false);
  bus.emit('device.upserted', { id: 'dev_phone', status: 'revoked', revokedAt: 5 } as never);
  assert.equal(phone.raw.closed, true);
  assert.equal(owner.raw.closed, false);
  assert.equal(server.size, 1);
});

test('handleHttp only serves pwa.exchange', async () => {
  const { server } = setup();
  const denied = await server.handleHttp({ id: 3, method: 'system.info' });
  assert.deepEqual(denied, { id: 3, error: { code: 'forbidden', message: 'Sign in first.' } });
  const ok = await server.handleHttp(JSON.stringify({ id: 4, method: 'pwa.exchange', params: { secret: 'good-secret', name: 'Pixel' } }));
  assert.deepEqual(ok, { id: 4, result: { token: 'device-token', deviceId: 'dev_new' } });
  const expired = await server.handleHttp({ id: 5, method: 'pwa.exchange', params: { secret: 'old' } });
  assert.equal(expired.error?.code, 'forbidden');
  const garbage = await server.handleHttp('{');
  assert.equal(garbage.error?.code, 'bad_request');
});

test('call() runs methods in-process with scope checks and WorkforceErrors', async () => {
  const { server } = setup();
  assert.equal(((await server.call('system.info', undefined, OWNER)) as { version: string }).version, '0.2.0');
  await assert.rejects(server.call('system.resources', undefined, PHONE), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');
  await assert.rejects(server.call('agents.org', undefined, OWNER), (error: unknown) => error instanceof WorkforceError && error.code === 'internal');
});

test('portConnection adapts Electron-style message ports', async () => {
  const listeners: Record<string, (event?: unknown) => void> = {};
  const posted: unknown[] = [];
  let started = false;
  const port = {
    postMessage: (frame: unknown) => posted.push(frame),
    close: () => listeners.close?.(),
    start: () => { started = true; },
    on: (event: 'message' | 'close', fn: (event?: unknown) => void) => { listeners[event] = fn; },
  };
  const { server } = setup();
  server.attach(portConnection(port), OWNER);
  assert.equal(started, true);
  listeners.message({ data: { id: 7, method: 'system.info' }, ports: [] });
  await settle(); await settle();
  assert.equal((posted[0] as { id: number }).id, 7);
  port.close();
  assert.equal(server.size, 0);
});

test('extras are resolved lazily per call (late binding)', async () => {
  const bus = new Bus();
  let extras: RpcExtras | undefined;
  const services = { bus, log: nullLogger } as unknown as RuntimeServices;
  const table = new HandlerTable();
  system(table);
  const server = new RpcServer({ services: () => services, extras: () => extras!, table });
  extras = fakeExtras();
  assert.equal(((await server.call('system.info', undefined, OWNER)) as { deviceId: string }).deviceId, 'dev_self');
});
