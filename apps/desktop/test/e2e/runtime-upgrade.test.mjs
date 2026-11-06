// Upgrade of a representative old profile over the real headless runtime (23.10.2026; the built
// app/runtime-cli.mjs, demo engine, a temp data folder):
//  1. A schema-9 profile (test/unit/repair/old-profile.ts: org with a manager and a video specialist,
//     a chat with an attachment, a finished task with its step, a human to-do, a described and
//     tagged image, a disabled CLI account and a local API account, an agent memory, old version
//     0.1.8) starts on this version: the runtime takes one pre-update copy, migrates, and serves
//     every one of those over RPC as the app reads them; repair.state says it is not in repair
//     mode and lists the copy; the start notice says it was updated.
//  2. A second start of the same version keeps the data and makes no second copy.
//  3. Data saved by a newer app is refused: the runtime does not start, says why, and the data
//     stays untouched (the desktop app shows the repair screen for it – unit-tested in
//     test/unit/repair/*; the headless runtime has no window).
// Run: npm run build && node --test test/e2e/runtime-upgrade.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';
import { FIXTURE, IMAGE_ID, OLD_SCHEMA, writeOldProfile } from '../unit/repair/old-profile.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function schemaOf(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'), { readOnly: true });
  try { return Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get().value); } finally { db.close(); }
}

test('an old profile upgrades over the real runtime: agents, chat, tasks, to-do, media, accounts and memory survive', { timeout: 180_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeOldProfile(dataDir);

  const first = await startRuntime({ dataDir, keepData: true });
  try {
    const { client } = first;
    const agents = await client.call('agents.list');
    const mira = agents.find((agent) => agent.id === FIXTURE.managerId);
    const vid = agents.find((agent) => agent.id === FIXTURE.videoId);
    assert.equal(mira?.name, 'Mira');
    assert.equal(mira?.mode, 'manager');
    // B-078 D15: the standard head is always present – the startup repair puts it on top, her own text stays under '## My role'.
    assert.match(mira?.instructions ?? '', /^This is my SYSTEM\.md[^]*\n# How I work\n/, 'the standard head is on top');
    assert.match(mira?.instructions ?? '', /\n## My role\n[^#]*Keep the team small\./, 'her own text survives under My role');
    assert.equal(vid?.managerId, FIXTURE.managerId, 'the org survives');
    assert.equal(vid?.mode, 'video');

    const chat = (await client.call('chats.list')).find((item) => item.id === FIXTURE.chatId);
    assert.equal(chat?.title, 'Product launch');
    const messages = await client.call('messages.list', { conversationId: FIXTURE.chatId });
    assert.deepEqual(messages.filter((message) => message.kind === 'text').map((message) => message.body), ['Please make the launch flyer.', 'Here is the flyer.']);
    assert.equal(messages.find((message) => message.id === 'ms_2')?.attachments[0]?.fileId, IMAGE_ID);

    const tasks = await client.call('tasks.list', { conversationId: FIXTURE.chatId, includeSteps: true, status: ['done', 'open'] });
    const flyer = tasks.find((task) => task.id === FIXTURE.taskId);
    assert.equal(flyer?.status, 'done');
    assert.equal(flyer?.result?.summary, 'Flyer made.');
    const steps = flyer?.steps ?? tasks.filter((task) => task.parentId === FIXTURE.taskId);
    assert.ok(steps.some((step) => step.id === FIXTURE.stepId && step.status === 'done'), 'the done step is kept');
    const todos = await client.call('todos.list');
    assert.ok(todos.some((todo) => todo.id === FIXTURE.todoId && todo.title === 'Sign the print order'), 'the human to-do is still in For you');

    const media = await client.call('media.list', { conversationId: FIXTURE.chatId });
    const flyerFile = media.find((item) => item.fileId === IMAGE_ID);
    assert.equal(flyerFile?.description, 'Launch flyer, final');
    assert.deepEqual(flyerFile?.tags, ['launch', 'flyer']);
    const found = await client.call('media.list', { text: 'flyer' });
    assert.ok(found.some((item) => item.fileId === IMAGE_ID), 'still found by its description');
    const file = await client.call('files.get', { id: IMAGE_ID });
    assert.equal(file?.name, 'flyer.png');

    const accounts = await client.call('accounts.list');
    const codex = accounts.find((account) => account.id === FIXTURE.codexId);
    assert.deepEqual({ provider: codex?.provider, label: codex?.label, plan: codex?.plan, email: codex?.email, enabled: codex?.enabled },
      { provider: 'codex', label: 'Codex · work', plan: 'pro', email: 'person@example.com', enabled: false });
    // An API connection moves into settings.json's providers section and gets an id from its service or name there (accounts/provider-file.ts moveOld).
    const local = accounts.find((account) => account.baseUrl === 'http://127.0.0.1:9/v1');
    assert.equal(local?.label, 'Local model', 'the local API account survives');
    assert.ok(!accounts.some((account) => account.id === FIXTURE.localId), 'under its new id from the file');
    assert.ok(Object.hasOwn((await client.call('settings.get')).providers ?? {}, local.id), 'and the file names it');
    const memory = await client.call('knowledge.list', { scope: 'agent', scopeId: FIXTURE.managerId });
    const migrated = memory.items.find((item) => item.title === 'Flyer style');
    assert.ok(migrated, 'the agent memory survives in the memory tree');
    assert.equal(migrated.body, 'Use the brand colours on flyers.');
    assert.equal(migrated.kind, 'preference');
    assert.equal(migrated.scope, 'agent');
    assert.equal(migrated.scopeId, FIXTURE.managerId);
    const history = await client.call('knowledge.history', { id: FIXTURE.knowledgeId });
    assert.equal(history.at(-1)?.id, migrated.id, 'the old ID still resolves to the migrated file');
    assert.equal(history.at(-1)?.body, migrated.body);

    const repair = await client.call('repair.state');
    assert.equal(repair.active, false);
    assert.deepEqual(repair.backups.map((copy) => copy.schema), [OLD_SCHEMA], 'one pre-update copy of the schema-9 data');
    const info = await client.call('system.info');
    assert.match(info.notice?.text ?? '', /^Updated to /);
  } finally {
    await first.stop();
  }

  const second = await startRuntime({ dataDir, keepData: true });
  try {
    const repair = await second.client.call('repair.state');
    assert.equal(repair.backups.length, 1, 'a second start makes no second copy');
    assert.ok((await second.client.call('agents.list')).some((agent) => agent.id === FIXTURE.videoId));
    const memory = await second.client.call('knowledge.history', { id: FIXTURE.knowledgeId });
    assert.equal(memory.at(-1)?.body, 'Use the brand colours on flyers.', 'memory and its old ID survive another restart');
  } finally {
    await second.stop();
  }
  assert.ok(readdirSync(path.join(dataDir, 'backups', 'pre-upgrade')).some((name) => name.endsWith(`-s${OLD_SCHEMA}.db`)));
});

test('data saved by a newer app: the runtime refuses to start, says why, and leaves the data as it is', { timeout: 120_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-newer-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeOldProfile(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'));
  db.prepare(`UPDATE meta SET value = '9999' WHERE key = 'schema'`).run();
  db.close();
  const run = spawnSync(process.execPath, [path.join(root, 'app', 'runtime-cli.mjs'), '--data', dataDir, '--resources', path.join(root, 'resources'), '--ui', path.join(root, 'app', 'ui'), '--port', '0', '--fake'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /saved by a newer version of Autark \(schema 9999/);
  assert.equal(schemaOf(dataDir), 9999, 'nothing migrated');
});
