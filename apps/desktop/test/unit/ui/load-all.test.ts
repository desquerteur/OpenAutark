// The shell's snapshot load (lib/load.ts behind store.loadAll) on a paired phone: the optional
// snapshots (accounts, usage; asked for on the desktop only until session.info exists) are empty
// when refused or not asked and never block `loaded` or set loadError – while a failing base
// snapshot still reports an error.
// A To-do-only device is refused chats, activity and tasks; it still boots with its For-you list.
// The PWA's offline For-you snapshot is written only after the first successful load; the
// in-memory copy the 'Offline' / 'Not paired' view shows follows every change at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshots, OPEN_STATUSES, SCOPED_SNAPSHOTS } from '../../../src/ui/lib/load.ts';
import type { LoadCall, OptionalSnapshot } from '../../../src/ui/lib/load.ts';
import { rpc, RpcError } from '../../../src/ui/lib/rpc.ts';
import { platform } from '../../../src/ui/lib/platform.ts';
import { accounts, activity, conversations, loadAll, loadError, loaded, tasks, todos, usage } from '../../../src/ui/lib/store.ts';
import { offlineSnapshot, readTodoSnapshot, watchTodoSnapshot } from '../../../src/ui/pwa/install.ts';
import type { TodoSnapshot } from '../../../src/ui/pwa/install.ts';

const OPTIONAL = new Set(['accounts.list', 'usage.list']);

function forbidden(): RpcError {
  return new RpcError({ code: 'forbidden', message: 'This device is not allowed to do that.' });
}

/** What a paired phone's runtime answers: data for device methods, 'forbidden' for the optional ones. */
function deviceAnswers(overrides: Record<string, (params: unknown) => unknown> = {}): Record<string, (params: unknown) => unknown> {
  return {
    'settings.get': () => ({ profile: { name: 'Alex' } }),
    'chats.list': () => [{ id: 'ch_main', title: 'Manager', members: [], settings: {}, createdAt: 1, unread: 0, working: [] }],
    'agents.list': () => [{ id: 'ag_manager', name: 'Manager' }],
    'agents.activity': () => [],
    'todos.list': () => [{ id: 'ta_todo', title: 'Sign the delivery note', assigneeKind: 'human', status: 'open' }],
    'tasks.list': () => [{ id: 'ta_open', title: 'Edit the trailer', status: 'working' }],
    'ui.state': () => ({ drafts: { ch_main: 'Hello' } }),
    'system.info': () => ({}),
    'accounts.list': () => { throw forbidden(); },
    'usage.list': () => { throw forbidden(); },
    ...overrides,
  };
}

/** A 'To-do only' link (capabilities ['todo']): chats and activity need 'chat', tasks need 'tasks'. */
function todoOnlyAnswers(): Record<string, (params: unknown) => unknown> {
  return deviceAnswers(Object.fromEntries(SCOPED_SNAPSHOTS.map((method) => [method, () => { throw forbidden(); }])));
}

function fakeCall(answers: Record<string, (params: unknown) => unknown>): { call: LoadCall; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = (async (method: string, params?: unknown) => {
    calls.push({ method, params });
    const answer = answers[method];
    if (!answer) throw new RpcError({ code: 'not_found', message: `unexpected call ${method}` });
    return answer(params);
  }) as unknown as LoadCall;
  return { call, calls };
}

/** Points the app's rpc.call (used by store.loadAll) at a fake; returns the calls it receives. */
function stubRpc(answers: Record<string, (params: unknown) => unknown>): Array<{ method: string; params: unknown }> {
  const { call, calls } = fakeCall(answers);
  (rpc as unknown as { call: unknown }).call = call;
  return calls;
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('loadSnapshots: archived agents come apart from the active ones (their old chats still need a name and a picture)', async () => {
  const { call, calls } = fakeCall(deviceAnswers({
    'agents.list': () => [{ id: 'ag_manager', name: 'Manager' }, { id: 'ag_otto', name: 'Otto', archivedAt: 9 }],
  }));
  const snapshot = await loadSnapshots({ call, optional: () => false });
  assert.deepEqual(calls.find((entry) => entry.method === 'agents.list')?.params, { includeArchived: true });
  assert.deepEqual(snapshot.agents.map((agent) => agent.id), ['ag_manager']);
  assert.deepEqual(snapshot.archivedAgents.map((agent) => agent.id), ['ag_otto']);
});

test('loadSnapshots: refused optional snapshots are empty and never fail the load', async () => {
  const { call, calls } = fakeCall(deviceAnswers());
  const snapshot = await loadSnapshots({ call, optional: () => true });
  assert.deepEqual(snapshot.accounts, []);
  assert.deepEqual(snapshot.usage, []);
  assert.equal(snapshot.chats[0].id, 'ch_main');
  assert.equal(snapshot.todos[0].id, 'ta_todo');
  assert.equal(snapshot.tasks[0].id, 'ta_open');
  assert.deepEqual(snapshot.drafts, { ch_main: 'Hello' });
  assert.deepEqual(calls.find((entry) => entry.method === 'tasks.list')?.params, { status: OPEN_STATUSES }, 'only open work is loaded');
});

test('loadSnapshots: optional snapshots are not asked for when not allowed; other failures keep the shown data', async () => {
  const asked: OptionalSnapshot[] = [];
  const device = fakeCall(deviceAnswers());
  const phone = await loadSnapshots({ call: device.call, optional: (method) => { asked.push(method); return false; } });
  assert.deepEqual(asked.sort(), ['accounts.list', 'usage.list']);
  assert.ok(!device.calls.some((entry) => OPTIONAL.has(entry.method)), 'a phone never asks for optional snapshots');
  assert.deepEqual(phone.accounts, []);
  assert.deepEqual(phone.usage, []);

  const owner = fakeCall(deviceAnswers({
    'accounts.list': () => [{ id: 'acc_1' }],
    'usage.list': () => { throw new RpcError({ code: 'internal', message: 'Something went wrong.' }); },
  }));
  const desktop = await loadSnapshots({ call: owner.call, optional: () => true });
  assert.deepEqual(desktop.accounts?.map((account) => account.id), ['acc_1']);
  assert.equal(desktop.usage, undefined, 'a failure other than a refusal leaves the current usage in place');
});

test('loadSnapshots: a failing base snapshot rejects the load', async () => {
  const { call } = fakeCall(deviceAnswers({ 'todos.list': () => { throw new RpcError({ code: 'internal', message: 'Something went wrong.' }); } }));
  await assert.rejects(loadSnapshots({ call, optional: () => true }), (error: unknown) => error instanceof RpcError && error.code === 'internal');
});

test('loadSnapshots: a To-do-only device is refused chats, activity and tasks and still loads its To-dos', async () => {
  const { call, calls } = fakeCall(todoOnlyAnswers());
  const snapshot = await loadSnapshots({ call, optional: () => false });
  assert.deepEqual(snapshot.chats, []);
  assert.deepEqual(snapshot.activity, []);
  assert.deepEqual(snapshot.tasks, []);
  assert.deepEqual(snapshot.todos.map((task) => task.id), ['ta_todo']);
  assert.equal(snapshot.agents[0].id, 'ag_manager');
  assert.deepEqual(snapshot.drafts, { ch_main: 'Hello' });
  assert.ok(!calls.some((entry) => OPTIONAL.has(entry.method)));

  const failing = fakeCall(deviceAnswers({ 'tasks.list': () => { throw new RpcError({ code: 'internal', message: 'Something went wrong.' }); } }));
  await assert.rejects(loadSnapshots({ call: failing.call, optional: () => false }), (error: unknown) => error instanceof RpcError && error.code === 'internal', 'only a refusal of a scoped snapshot is empty');
});

test('store.loadAll on a To-do-only phone: loaded with its For-you list, no error', async () => {
  loaded.value = false;
  loadError.value = null;
  todos.value = [];
  stubRpc(todoOnlyAnswers());
  await loadAll();
  assert.equal(loadError.value, null);
  assert.equal(loaded.value, true);
  assert.deepEqual(todos.value.map((task) => task.id), ['ta_todo']);
  assert.deepEqual(conversations.value, []);
  assert.deepEqual(activity.value, []);
  assert.deepEqual(tasks.value, []);
});

test('store.loadAll on a paired phone: loaded with chats, To-dos and tasks; no optional calls; no error', async () => {
  assert.equal(platform, 'pwa', 'unit tests run as the browser/phone build');
  loaded.value = false;
  loadError.value = null;
  accounts.value = [];
  const calls = stubRpc(deviceAnswers());
  await loadAll();
  const methods = calls.map((entry) => entry.method);
  assert.equal(loadError.value, null);
  assert.equal(loaded.value, true);
  assert.deepEqual(conversations.value.map((chat) => chat.id), ['ch_main']);
  assert.deepEqual(todos.value.map((task) => task.id), ['ta_todo']);
  assert.deepEqual(tasks.value.map((task) => task.id), ['ta_open']);
  assert.deepEqual(accounts.value, []);
  assert.deepEqual(usage.value, []);
  assert.ok(!methods.some((method) => OPTIONAL.has(method)), `optional snapshots are not asked for: ${methods.join(', ')}`);
});

test('store.loadAll: a failing snapshot sets loadError and keeps the data and `loaded` as they were', async () => {
  loaded.value = false;
  loadError.value = null;
  todos.value = [];
  stubRpc(deviceAnswers({ 'chats.list': () => { throw new RpcError({ code: 'internal', message: 'Something went wrong. It was logged.' }); } }));
  await loadAll();
  assert.equal(loadError.value, 'Something went wrong. It was logged.');
  assert.equal(loaded.value, false);
  assert.deepEqual(todos.value, [], 'nothing from the failed load is applied');
});

test('offline snapshot: written only after the first successful load, then on every change', async () => {
  loaded.value = false;
  loadError.value = null;
  todos.value = [];
  const written: TodoSnapshot[] = [];
  const stop = watchTodoSnapshot(async (snapshot) => { written.push(snapshot); }, 0);
  try {
    await tick();
    assert.equal(written.length, 0, 'the empty boot list is never written');

    stubRpc(deviceAnswers({ 'todos.list': () => { throw new RpcError({ code: 'unavailable', message: 'Connection to the runtime was lost.' }); } }));
    await loadAll();
    await tick();
    assert.ok(loadError.value);
    assert.equal(written.length, 0, 'a failed load writes nothing');

    stubRpc(deviceAnswers());
    await loadAll();
    await tick();
    assert.equal(written.length, 1, 'one write for the whole (batched) load');
    assert.deepEqual(written[0].items.map((task) => task.id), ['ta_todo']);

    todos.value = [];
    await tick();
    assert.equal(written.length, 2, 'later changes (an answered item) are written');
    assert.deepEqual(written[1].items, []);
  } finally {
    stop();
  }
});

test('offline snapshot: the read-only view gets the current list at once, not the one read at app start', async () => {
  loaded.value = false;
  loadError.value = null;
  todos.value = [];
  offlineSnapshot.value = { at: 1, items: [] }; // what main.tsx read from IndexedDB at boot
  const written: TodoSnapshot[] = [];
  const stop = watchTodoSnapshot(async (snapshot) => { written.push(snapshot); }, 60_000);
  try {
    stubRpc(deviceAnswers());
    await loadAll();
    assert.deepEqual(offlineSnapshot.value?.items.map((task) => task.id), ['ta_todo'], 'mirrored without waiting for the debounced write');
    assert.equal(written.length, 0, 'the IndexedDB write is still debounced');
    const current = offlineSnapshot.value!;
    assert.ok(current.at > 1);

    todos.value = [];
    assert.deepEqual(offlineSnapshot.value?.items, [], 'an answered item leaves the read-only list too');
    // A late boot read of an older IndexedDB copy never replaces what this page knows.
    assert.equal(await readTodoSnapshot(), offlineSnapshot.value);
  } finally {
    stop();
    offlineSnapshot.value = null;
  }
});
