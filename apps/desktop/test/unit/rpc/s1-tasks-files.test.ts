// Task/to-do/schedule, org/run, knowledge and file handlers (R3-S1) against real services:
// task lifecycle as the human, widget to-dos completed as answers, device limits, reorder,
// run cancel, chunked uploads, reads and path confinement for opening files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import { newId } from '../../../src/shared/ids.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { ChunkUploads } from '../../../src/runtime/rpc/uploads.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';
import { OWNER, PHONE, TODO_ONLY, TestClient, rpcFixture } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  return { ...f, chat, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE), todo: new TestClient(f.server, TODO_ONLY) };
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

test('tasks: create, update with rev, status and completion as the human', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const task = await f.phone.call<TaskView>('tasks.create', { conversationId: f.chat.id, title: 'Cut the trailer', steps: ['Rough cut', 'Music'], assigneeId: 'ag_ava' });
  assert.equal(task.createdBy, 'human');
  assert.equal(task.steps.length, 2);
  assert.ok(task.messageId, 'anchored by a task message in the chat');
  const updated = await f.phone.call<TaskView>('tasks.update', { id: task.id, rev: task.rev, patch: { title: 'Cut the 30 s trailer', dueAt: 5000 } });
  assert.equal(updated.title, 'Cut the 30 s trailer');
  assert.equal((await f.phone.request('tasks.update', { id: task.id, rev: task.rev, patch: { title: 'stale' } })).error?.code, 'conflict');
  assert.equal((await f.phone.request('tasks.update', { id: task.id, patch: { status: 'done' } })).error?.code, 'bad_request');
  const cleared = await f.phone.call<TaskView>('tasks.update', { id: task.id, patch: { dueAt: null } });
  assert.equal(cleared.dueAt, undefined);
  const blocked = await f.phone.call<TaskView>('tasks.setStatus', { id: task.id, status: 'blocked', note: 'No footage yet' });
  assert.equal(blocked.status, 'blocked');
  const done = await f.phone.call<TaskView>('tasks.complete', { id: task.id, note: 'Shipped it' });
  assert.equal(done.status, 'done');
  assert.equal(done.result?.summary, 'Shipped it');
  assert.equal(done.result?.verification, 'reported_by_human');
});

test('tasks.list accepts completedSince (recently finished, newest first)', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const early = await f.phone.call<TaskView>('tasks.create', { conversationId: f.chat.id, title: 'Early' });
  const late = await f.phone.call<TaskView>('tasks.create', { conversationId: f.chat.id, title: 'Late' });
  await f.phone.call('tasks.create', { conversationId: f.chat.id, title: 'Open' });
  await f.phone.call('tasks.complete', { id: early.id });
  f.clock.advance(5000);
  const since = f.clock.now();
  await f.phone.call('tasks.complete', { id: late.id });
  const recent = await f.phone.call<TaskView[]>('tasks.list', { status: ['done', 'cancelled'], completedSince: since, limit: 50 });
  assert.deepEqual(recent.map((task) => task.title), ['Late']);
  assert.equal((await f.phone.call<TaskView[]>('tasks.list', { completedSince: 0 })).length, 2, 'finished tasks only');
  const negative = await f.phone.request('tasks.list', { completedSince: -1 });
  assert.equal(negative.error?.code, 'bad_request');
  assert.equal(negative.error?.details?.param, 'completedSince');
});

test('chunked uploads above the in-memory size keep the client mime (streamed putPath)', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const uploads = new ChunkUploads({ temp: f.paths.temp, files: f.services.files, clock: f.clock, inMemoryMax: 4 });
  const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00, 0x00]); // AAC (ADTS): no magic we sniff
  const uploadId = newId('up');
  const head = { uploadId, name: 'voice note', mime: 'audio/aac', owner: 'owner' };
  await uploads.chunk({ ...head, index: 0, dataBase64: adts.subarray(0, 5).toString('base64'), final: false });
  const { file } = await uploads.chunk({ ...head, index: 1, dataBase64: adts.subarray(5).toString('base64'), final: true });
  assert.equal(file?.mime, 'audio/aac');
  assert.equal(file?.name, 'voice note');
  assert.equal(file?.size, adts.length);
});

test('tasks.complete on a widget to-do is an answer; todo-only devices cannot finish agent work', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const todo = await f.todo.call<TaskView>('todos.add', { text: 'Call the bank about the card' });
  assert.equal(todo.assigneeKind, 'human');
  assert.equal(todo.conversationId, undefined, 'B-054: a to-do from the To-do area is chat-free');
  assert.ok(todo.widget);
  assert.ok((await f.todo.call<TaskView[]>('todos.list')).some((entry) => entry.id === todo.id));
  const done = await f.todo.call<TaskView>('tasks.complete', { id: todo.id, note: 'called' });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result?.answer, { done: true, note: 'called' });
  assert.ok(!f.db.get("SELECT 1 FROM messages WHERE kind = 'answer'"), 'B-054: no chat, so no receipt – the answer is stored on the to-do');

  const agentTask = f.tasks.create({ conversationId: f.chat.id, title: 'Agent work', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  assert.equal((await f.todo.request('tasks.complete', { id: agentTask.id })).error?.code, 'forbidden');
  assert.equal((await f.todo.request('tasks.list')).error?.code, 'forbidden', "tasks.* needs the 'tasks' capability");
  assert.equal((await f.phone.call<TaskView>('tasks.complete', { id: agentTask.id })).status, 'done');
});

test('B-054: todos.add without a chat makes a chat-free to-do; no hidden To-do chat is made', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const before = f.chats.list({ includeHidden: true }).length;
  const todo = await f.owner.call<TaskView>('todos.add', { text: 'Sign the contract' });
  assert.equal(todo.conversationId, undefined);
  assert.equal(f.chats.list({ includeHidden: true }).length, before, 'no stand-in chat');
  assert.ok((await f.owner.call<TaskView[]>('todos.list')).some((entry) => entry.id === todo.id), 'on My day');
});

test('todos.changeWidget and tasks.reorder keep other tasks in place', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const todo = await f.owner.call<TaskView>('todos.add', { text: 'Record the intro' });
  const switched = await f.owner.call<TaskView>('todos.changeWidget', { id: todo.id, type: 'confirm' });
  assert.equal(switched.widget?.type, 'confirm');
  const a = f.tasks.create({ conversationId: f.chat.id, title: 'A', createdBy: 'human' });
  f.clock.advance(10);
  const b = f.tasks.create({ conversationId: f.chat.id, title: 'B', createdBy: 'human' });
  f.clock.advance(10);
  const c = f.tasks.create({ conversationId: f.chat.id, title: 'C', createdBy: 'human' });
  await f.owner.call('tasks.reorder', { ids: [c.id, a.id] });
  const sorts = new Map(f.tasks.list({ conversationId: f.chat.id }).map((task) => [task.id, task.sort]));
  assert.ok(sorts.get(c.id)! < sorts.get(b.id)! && sorts.get(b.id)! < sorts.get(a.id)!, 'c takes a’s slot, a takes c’s slot, b stays');
  await f.owner.call('tasks.delete', { id: b.id });
  assert.equal(f.tasks.get(b.id), undefined);
});

test('schedules: list for devices, update/runNow/delete owner-only', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const schedule = f.scheduler.create({ ownerId: 'human', conversationId: f.chat.id, kind: 'message', title: 'Weekly recap', spec: { cron: '0 9 * * 1' }, payload: { body: 'Recap please' } });
  assert.equal((await f.phone.call<unknown[]>('schedules.list', { conversationId: f.chat.id })).length, 1);
  assert.equal((await f.phone.request('schedules.update', { id: schedule.id, active: false })).error?.code, 'forbidden');
  assert.equal((await f.owner.call<{ active: boolean }>('schedules.update', { id: schedule.id, active: false })).active, false);
  await f.owner.call('schedules.runNow', { id: schedule.id });
  assert.ok(f.chats.messages(f.chat.id).some((message) => message.body === 'Recap please' && message.meta.via === 'schedule'));
  await f.owner.call('schedules.delete', { id: schedule.id });
  assert.equal((await f.owner.request('schedules.delete', { id: schedule.id })).error?.code, 'not_found');
});

test('runs: items, cancel interrupts only running runs; agents.activity comes from the dispatcher', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const retries = new KvRepo(f.db);
  const retryKey = `ag_ava:${f.chat.id}`;
  const pending = { agentId: 'ag_ava', conversationId: f.chat.id, runId: 'older_outage', cursor: 0, at: f.clock.now() };
  retries.set('redelivery', retryKey, pending, f.clock.now());
  const run = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId: f.chat.id, trigger: 'message' });
  f.services.runs.item(run.id, { kind: 'tool_call', name: 'shell', data: { cmd: 'ls' } });
  assert.equal((await f.owner.call<unknown[]>('runs.items', { runId: run.id })).length, 1);
  await f.owner.call('runs.cancel', { runId: run.id });
  assert.deepEqual(f.dispatcher.interrupts, [{ agentId: 'ag_ava', conversationId: f.chat.id }]);
  assert.equal(retries.get('redelivery', retryKey), undefined, 'cancelling this chat also removes its older pending retry');
  f.services.runs.finish(run.id, { status: 'done' });
  retries.set('redelivery', retryKey, pending, f.clock.now());
  await f.owner.call('runs.cancel', { runId: run.id });
  assert.equal(f.dispatcher.interrupts.length, 1, 'finished runs are not interrupted again');
  assert.deepEqual(retries.get('redelivery', retryKey), pending, 'cancelling an old finished run cannot clear current pending work');
  assert.equal((await f.owner.request('runs.cancel', { runId: 'run_missing' })).error?.code, 'not_found');
  f.dispatcher.active = [{ agentId: 'ag_ava', runId: run.id, note: 'editing', startedAt: 0 }];
  assert.equal((await f.phone.call<unknown[]>('agents.activity')).length, 1);
  assert.equal((await f.phone.call<unknown[]>('runs.items', { runId: run.id })).length, 1, 'C5: a chat device reads the run details');
  for (const fields of [{ taskId: 'task_other' }, { splitId: 'split_other' }]) {
    const other = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId: f.chat.id, trigger: 'task', ...fields });
    await f.owner.call('runs.cancel', { runId: other.id });
    assert.deepEqual(retries.get('redelivery', retryKey), pending, 'task/split cancellation leaves the main chat retry alone');
  }
});

test('runs.cancel stops the run by id when the dispatcher can (never another turn of the agent)', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const cancelled: string[] = [];
  Object.assign(f.dispatcher, { cancelRun: async (runId: string) => { cancelled.push(runId); return true; } });
  const run = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', trigger: 'task' }); // no chat
  await f.owner.call('runs.cancel', { runId: run.id });
  assert.deepEqual(cancelled, [run.id]);
  assert.deepEqual(f.dispatcher.interrupts, [], 'no agent-wide interrupt');
});

test('knowledge: human saves are trusted user items; list pages with a numeric cursor', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  (f.services as { knowledge: unknown }).knowledge = new KnowledgeStore({ db: f.db, clock: f.clock, bus: f.bus });
  for (let i = 0; i < 3; i++) {
    f.clock.advance(1);
    await f.owner.call('knowledge.save', { title: `Fact ${i}`, body: `Body ${i}`, scope: 'global', kind: 'fact' });
  }
  const page1 = await f.owner.call<{ items: KnowledgeItem[]; next?: string }>('knowledge.list', { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].createdBy, 'human');
  assert.deepEqual(page1.items[0].source, { kind: 'user', trusted: true });
  assert.equal(page1.next, '2');
  const page2 = await f.owner.call<{ items: KnowledgeItem[]; next?: string }>('knowledge.list', { limit: 2, cursor: page1.next });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next, undefined);
  await f.owner.call('knowledge.expire', { id: page2.items[0].id, reason: 'outdated' });
  assert.equal((await f.owner.call<{ items: unknown[] }>('knowledge.list', {})).items.length, 2);
  assert.equal((await f.owner.request('knowledge.list', { cursor: 'abc' })).error?.code, 'bad_request');
  assert.equal((await f.todo.request('knowledge.list', {})).error?.code, 'forbidden', 'knowledge needs the chat capability');
  assert.equal((await f.phone.request('knowledge.list', {})).error, undefined, 'a chat device may read knowledge (DEV2 tiers)');
});

test('files: base64 upload, get and read with a size cap', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const ref = await f.phone.call<FileRef>('files.upload', { name: 'notes.txt', dataBase64: b64('hello world') });
  assert.equal(ref.mime, 'text/plain');
  assert.equal((await f.phone.call<FileRef>('files.get', { id: ref.id })).size, 11);
  const read = await f.phone.call<{ dataBase64: string; mime: string }>('files.read', { id: ref.id });
  assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'hello world');
  assert.equal((await f.phone.request('files.read', { id: ref.id, maxBytes: 5 })).error?.code, 'bad_request');
  assert.equal((await f.phone.request('files.upload', { name: 'x', dataBase64: '***' })).error?.code, 'bad_request');
  assert.equal((await f.phone.request('files.get', { id: 'a'.repeat(64) })).error?.code, 'not_found');
});

test('files.uploadChunk assembles chunks in order, per owner, and cleans up', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const uploadId = newId('up');
  const parts = ['first-', 'second-', 'third'];
  const chunk = (client: TestClient, index: number, final = false) =>
    client.request('files.uploadChunk', { uploadId, index, dataBase64: b64(parts[index]), final, name: 'take 1.txt', mime: 'text/plain' });
  assert.deepEqual((await chunk(f.phone, 0)).result, { received: 6 });
  assert.equal((await chunk(f.phone, 2)).error?.code, 'conflict', 'index order is enforced');
  assert.equal((await chunk(f.owner, 1)).error?.code, 'forbidden', 'another client cannot append');
  assert.deepEqual((await chunk(f.phone, 1)).result, { received: 13 });
  const last = await chunk(f.phone, 2, true);
  const file = (last.result as { received: number; file: FileRef }).file;
  assert.equal(file.name, 'take 1.txt');
  assert.equal(file.size, 18);
  assert.equal(Buffer.from(await f.services.files.read(file.id)).toString(), 'first-second-third');
  const leftovers = path.join(f.paths.temp, 'uploads', uploadId);
  assert.throws(() => readFileSync(path.join(leftovers, 'take 1.txt')), 'temp data removed');
  assert.equal((await chunk(f.phone, 1)).error?.code, 'not_found', 'finished uploads cannot continue');
  assert.equal((await f.phone.request('files.uploadChunk', { uploadId: 'bad', index: 0, dataBase64: '', name: 'x' })).error?.code, 'bad_request');
});

test('files.uploadChunk sessions expire after 30 minutes without chunks', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const uploadId = newId('up');
  await f.phone.call('files.uploadChunk', { uploadId, index: 0, dataBase64: b64('abc'), name: 'a.txt' });
  f.clock.advance(31 * 60_000);
  assert.equal((await f.phone.request('files.uploadChunk', { uploadId, index: 1, dataBase64: b64('def'), name: 'a.txt', final: true })).error?.code, 'not_found');
});

test('files.openPath only opens files in the workspace or data folder, never executables or account homes', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const report = path.join(f.paths.workspace, 'report.pdf');
  writeFileSync(report, '%PDF-1.4');
  const script = path.join(f.paths.workspace, 'run.bat');
  writeFileSync(script, 'echo hi');
  mkdirSync(path.join(f.paths.accounts, 'codex-1'), { recursive: true });
  const auth = path.join(f.paths.accounts, 'codex-1', 'auth.json');
  writeFileSync(auth, '{}');
  const outside = path.join(path.dirname(f.paths.workspace), 'elsewhere.txt');
  writeFileSync(outside, 'x');

  await f.owner.call('files.openPath', { path: report });
  await f.owner.call('files.openPath', { path: script, reveal: true });
  assert.equal(f.opened.length, 2);
  assert.equal((await f.owner.request('files.openPath', { path: script })).error?.code, 'forbidden');
  writeFileSync(`${script}.`, 'echo hi'); // Windows drops the trailing dot (same file); elsewhere a second file
  assert.equal((await f.owner.request('files.openPath', { path: `${script}.` })).error?.code, 'forbidden', 'trailing dot does not hide .bat');
  assert.equal((await f.owner.request('files.openPath', { path: auth })).error?.code, 'forbidden');
  assert.equal((await f.owner.request('files.openPath', { path: outside })).error?.code, 'forbidden');
  assert.equal((await f.owner.request('files.openPath', { path: path.join(f.paths.workspace, '..', 'elsewhere.txt') })).error?.code, 'forbidden');
  assert.equal((await f.owner.request('files.openPath', { path: path.join(f.paths.workspace, 'missing.pdf') })).error?.code, 'not_found');
  assert.equal((await f.phone.request('files.openPath', { path: report })).error?.code, 'forbidden', 'owner only');
});

test('files.open opens a named copy of the blob (with an extension)', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  const ref = await f.owner.call<FileRef>('files.upload', { name: 'screenshot', dataBase64: png.toString('base64') });
  await f.owner.call('files.open', { id: ref.id });
  const opened = f.opened[0].path;
  assert.equal(path.basename(opened), 'screenshot.png');
  assert.ok(opened.startsWith(path.join(f.paths.temp, 'open')));
  assert.deepEqual(readFileSync(opened), png);
  assert.equal((await f.phone.request('files.open', { id: ref.id })).error?.code, 'forbidden');

  // "setup.exe." / "setup.exe " would run as setup.exe on Windows (and the copy drops the dot).
  for (const name of ['setup.exe.', 'setup.exe ', 'tool.searchconnector-ms']) {
    const exe = await f.owner.call<FileRef>('files.upload', { name, dataBase64: b64(`MZ ${name}`) });
    assert.equal((await f.owner.request('files.open', { id: exe.id })).error?.code, 'forbidden', name);
  }
  const before = f.opened.length;
  const exe = await f.owner.call<FileRef>('files.upload', { name: 'setup.exe.', dataBase64: b64('MZ setup.exe.') });
  await f.owner.call('files.open', { id: exe.id, reveal: true });
  assert.equal(f.opened.length, before + 1, 'show in folder stays possible');
});

test('files.open: bytes still on another PC are a clear error, APKs go directly to their folder', async (t) => {
  // Owner 05.11.2026 20:18: the APK posted on the server, clicked on the notebook → ENOENT copyfile, "Something went wrong".
  const f = setup();
  t.after(f.cleanup);
  const apk = Buffer.from('PK android package');
  const ref = await f.owner.call<FileRef>('files.upload', { name: 'Autark-Android-preview.apk', dataBase64: apk.toString('base64') });
  rmSync(f.services.files.path(ref.id));
  const missing = await f.owner.request('files.open', { id: ref.id });
  assert.equal(missing.error?.code, 'unavailable', 'no linked PC has the bytes: a named error, not internal');

  writeFileSync(f.services.files.path(ref.id), apk);
  const host = f.services.host;
  const open = host.openPath;
  const calls: Array<{ target: string; reveal: boolean | undefined }> = [];
  host.openPath = async (target, reveal) => {
    calls.push({ target, reveal });
    // Real Electron on Windows returns success while opening the app chooser, not an error.
    return open(target, reveal);
  };
  await f.owner.call('files.open', { id: ref.id });
  const shown = f.opened.at(-1);
  assert.equal(shown?.reveal, true, 'shown in its folder instead');
  assert.equal(path.basename(shown?.path ?? ''), 'Autark-Android-preview.apk');
  assert.deepEqual(readFileSync(shown?.path ?? ''), apk);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reveal, true, 'no OS-open attempt or app chooser for an Android installer');
});

test('files.open falls back to its folder when an ordinary file has no associated app', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const ref = await f.owner.call<FileRef>('files.upload', { name: 'report.unassigned', dataBase64: b64('report') });
  const host = f.services.host;
  const open = host.openPath;
  host.openPath = async (target, reveal) => {
    if (!reveal) throw new Error('No application is associated with the specified file for this operation.');
    return open(target, reveal);
  };
  await f.owner.call('files.open', { id: ref.id });
  assert.equal(f.opened.at(-1)?.reveal, true);
});
