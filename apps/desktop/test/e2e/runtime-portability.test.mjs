// End-to-end flows of the 19.10.2026 round over the real headless runtime (demo engine, temp
// profiles), exactly as the desktop window and the CLI reach them over WebSocket RPC:
//  1. Backup → later changes → staged restore → restart: the next start brings the backed-up
//     state back (chat, attached file) and keeps the replaced data as a fallback copy.
//  2. An agent's export file carries its knowledge without ids or local paths. (Importing such a file went with the
//     import machinery and Duplicate is the skill agent-duplicate – Umbau Einfachheit.)
//  3. Media library: an attachment is measured, an agent describes it with its media tool, and
//     the person finds it by that description.
//  4. MM7: a backup restored into a second installation (another data folder = another PC): the data comes back,
//     no CLI login travels (accounts/ is not in a backup), and the headless runtime says it cannot restart itself
//     (the desktop app's "Restart now" is RuntimeHost's, unit-tested). (Re-anchoring account homes and the re-entry
//     to-dos went – Umbau Einfachheit.)
//  5. MM8: a backup carries the workspace's and agents' skills back.
// Run: npm run build && node --test test/e2e/runtime-portability.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON = path.join(root, 'assets', 'icon.png'); // real 1024×1024 PNG of this repo

async function attachIcon(client, conversationId, body) {
  const ref = await client.call('files.upload', { name: 'icon.png', mime: 'image/png', dataBase64: (await readFile(ICON)).toString('base64') });
  await client.call('messages.send', { conversationId, body, attachments: [{ fileId: ref.id, name: ref.name, mime: ref.mime, size: ref.size }] });
  return ref;
}

async function until(check, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('backup, staged restore and restart bring the backed-up state back', { timeout: 180_000 }, async (t) => {
  const backups = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-backups-'));
  t.after(() => rm(backups, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const first = await startRuntime({ keepData: true });
  // Stopped by hand before the restart; this only covers a failure before that point (a live
  // child would keep the test process running, and keepData would leave its profile behind).
  let firstStopped = false;
  t.after(async () => {
    if (firstStopped) return;
    await first.stop();
    await rm(first.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  const { client } = first;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const kept = await client.call('chats.create', { title: 'Kept by the backup', agentIds: [manager.id] });
  const icon = await attachIcon(client, kept.id, 'Logo for the backup');

  const backup = await client.call('system.backup', { dir: path.join(backups, 'snapshot') });
  assert.ok(backup.bytes > 0, 'the backup has content');
  assert.ok(existsSync(path.join(backup.path, 'manifest.json')), 'the manifest is written');

  const later = await client.call('chats.create', { title: 'Created after the backup', agentIds: [manager.id] });
  await assert.rejects(client.call('system.restore', { path: path.join(first.dataDir, 'nowhere') }), /./, 'a folder inside the data folder is refused');
  assert.deepEqual(await client.call('system.restore', { path: backup.path }), { ok: true, restartRequired: true });
  // Staging changes nothing yet: the running installation is untouched until the next start.
  assert.ok((await client.call('chats.list')).some((chat) => chat.id === later.id));
  await first.stop();
  firstStopped = true;

  const second = await startRuntime({ dataDir: first.dataDir });
  t.after(() => second.stop());
  const chats = await second.client.call('chats.list');
  assert.ok(chats.some((chat) => chat.id === kept.id), 'the backed-up chat is back');
  assert.ok(!chats.some((chat) => chat.id === later.id), 'the later chat is gone with the restore');
  const read = await second.client.call('files.read', { id: icon.id });
  assert.equal(Buffer.from(read.dataBase64, 'base64').length, icon.size, 'the attached file came back with its bytes');
  const names = readdirSync(first.dataDir);
  assert.ok(names.some((name) => name.startsWith('before-restore-')), 'the replaced data is kept as a fallback copy');
  assert.ok(!names.includes('restore-failed.json'), 'the restore did not fail');
});

test('an agent\'s export file carries its knowledge without local paths', { timeout: 180_000 }, async (t) => {
  const home = await startRuntime();
  t.after(() => home.stop());

  const manager = (await home.client.call('agents.list')).find((agent) => agent.template === 'manager');
  const writer = await home.client.call('agents.create', { template: 'writer', name: 'Rhea', managerId: manager.id });
  await home.client.call('knowledge.save', { scope: 'agent', scopeId: writer.id, kind: 'preference', title: 'Tone', body: 'Short sentences, no jargon.' });

  const file = await home.client.call('agents.export', { id: writer.id, includeKnowledge: true });
  const bytes = await home.client.call('files.read', { id: file.id });
  const text = Buffer.from(bytes.dataBase64, 'base64').toString('utf8');
  assert.match(text, /Short sentences, no jargon\./, 'the knowledge travels in the file');
  assert.ok(!text.includes(writer.id), 'the agent id is not exported');
  assert.ok(!text.includes(home.dataDir) && !text.includes(home.dataDir.replaceAll('\\', '\\\\')), 'no absolute path of the old installation');

  // (Importing an agent file into another installation went with the import machinery – Umbau Einfachheit; the AI
  // sets an agent up from such a file through its folder; Duplicate is the skill agent-duplicate.)
  await assert.rejects(home.client.call('agents.derive', { id: writer.id, as: 'copy' }), 'no duplicate method any more');
});

test('media library: measured on attach, described by an agent, found by the person', { timeout: 180_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Brand assets', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  const icon = await attachIcon(client, chat.id, 'Our app icon');

  const measured = await until(async () => (await client.call('media.list', { conversationId: chat.id })).find((row) => row.fileId === icon.id && row.width), 'the probe');
  assert.equal(measured.kind, 'image');
  assert.equal(measured.width, 1024);
  assert.equal(measured.height, 1024);
  assert.equal(measured.description, undefined, 'nothing is described automatically');

  const args = JSON.stringify({ fileId: icon.id, description: 'App icon: a white W on a blue rounded square.', tags: ['icon', 'brand'] });
  await client.call('messages.send', { conversationId: chat.id, body: `@Manager describe it [[tool:media.describe ${args}]]` });
  const described = await client.waitFor('media.upserted', (row) => row.fileId === icon.id && row.description, 90_000).catch(async (error) => {
    const page = await client.call('messages.list', { conversationId: chat.id });
    const lines = (page.items ?? page).map((message) => `${message.authorId} [${message.state}] ${String(message.body).slice(0, 160)} ${message.error ? JSON.stringify(message.error) : ''}`);
    throw new Error(`${error.message}\n${lines.join('\n')}`);
  });
  assert.equal(described.describedBy, manager.id, 'the agent is recorded as author');
  assert.deepEqual(described.tags, ['icon', 'brand']);

  const found = await client.call('media.list', { text: 'blue square' });
  assert.ok(found.some((row) => row.fileId === icon.id), 'the person finds it by the description');
  assert.ok(!(await client.call('media.list', { text: 'zebra' })).some((row) => row.fileId === icon.id));

  const edited = await client.call('media.describe', { fileId: icon.id, description: 'App icon (white W, blue).', tags: ['icon'] });
  assert.equal(edited.describedBy, 'human', 'a person’s edit is recorded as the person’s');
});

test('restore into a second installation: data back, no login travels', { timeout: 240_000 }, async (t) => {
  const backups = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-backups-'));
  t.after(() => rm(backups, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const oldPc = await startRuntime({ keepData: true });
  let oldStopped = false;
  t.after(async () => {
    if (!oldStopped) await oldPc.stop();
    await rm(oldPc.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  const manager = (await oldPc.client.call('agents.list')).find((agent) => agent.template === 'manager');
  const moved = await oldPc.client.call('chats.create', { title: 'Moved to the new PC', agentIds: [manager.id] });
  await oldPc.client.call('secrets.save', { label: 'Shop login', kind: 'password', value: 'e2e-placeholder-value' });
  const backup = await oldPc.client.call('system.backup', { dir: path.join(backups, 'snapshot') });
  await oldPc.stop();
  oldStopped = true;

  // A CLI login of the old installation (a placeholder file in its home): the backup leaves accounts/ out.
  const oldHome = path.join(oldPc.dataDir, 'accounts', 'codex', 'acc_e2emovedhome01');
  await mkdir(oldHome, { recursive: true });
  await writeFile(path.join(oldHome, 'auth.json'), '{"note":"e2e placeholder, not a login"}');
  assert.ok(!existsSync(path.join(backup.path, 'accounts')), 'no CLI login in the backup');

  const newPc = await startRuntime({ keepData: true });
  const newData = newPc.dataDir;
  let running = newPc; // the live runtime of the second installation (null while stopped)
  t.after(async () => {
    if (running) await running.stop();
    await rm(newData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  assert.deepEqual(await newPc.client.call('system.restore', { path: backup.path }), { ok: true, restartRequired: true });
  const staged = await newPc.client.call('system.restoreStatus');
  assert.equal(staged.staged?.path, backup.path);
  assert.equal(staged.canRestart, false, 'a headless runtime cannot restart itself');
  await assert.rejects(newPc.client.call('system.restartRuntime'), (error) => error.code === 'unavailable');
  running = null;
  await newPc.stop();

  const restored = await startRuntime({ dataDir: newData, keepData: true });
  running = restored;
  const { client } = restored;
  assert.ok((await client.call('chats.list')).some((chat) => chat.id === moved.id), 'the data came back');

  assert.ok(!existsSync(path.join(newData, 'accounts', 'codex', 'acc_e2emovedhome01', 'auth.json')), 'the login never travels');
  const status = await client.call('system.restoreStatus');
  assert.equal(status.staged, undefined);
  assert.equal(status.last?.ok, true);
  assert.equal(status.last?.from, backup.path);

  // The next start keeps it.
  running = null;
  await restored.stop();
  running = await startRuntime({ dataDir: newData, keepData: true });
  assert.ok((await running.client.call('chats.list')).some((chat) => chat.id === moved.id), 'still there after the next start');
  assert.ok(!readdirSync(newData).includes('restore-failed.json'));
});

test('skills move with a backup: the restore brings the workspace’s and the agents’ skills back', { timeout: 180_000 }, async (t) => {
  const backups = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-backups-'));
  t.after(() => rm(backups, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const first = await startRuntime({ keepData: true });
  let firstStopped = false;
  t.after(async () => {
    if (firstStopped) return;
    await first.stop();
    await rm(first.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  const { client } = first;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  await client.call('skills.save', { name: 'house-voice', description: 'How we write.', body: 'Short and warm.' });
  await client.call('skills.save', { name: 'weekly-review', description: 'The manager’s weekly review.', body: 'Check every team.', ownerAgentId: manager.id });
  const backup = await client.call('system.backup', { dir: path.join(backups, 'snapshot') });
  const manifest = JSON.parse(await readFile(path.join(backup.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'workforce-backup');
  assert.ok(existsSync(path.join(backup.path, 'workspace-skills', 'house-voice', 'SKILL.md')), 'the workspace skills are in the backup');

  await client.call('skills.delete', { name: 'house-voice' });
  await client.call('skills.delete', { name: 'weekly-review' });
  await client.call('system.restore', { path: backup.path });
  await first.stop();
  firstStopped = true;

  const second = await startRuntime({ dataDir: first.dataDir });
  t.after(() => second.stop());
  const skills = await second.client.call('skills.list');
  const voice = skills.find((skill) => skill.name === 'house-voice');
  assert.ok(voice, 'the workspace skill is back');
  assert.equal(voice.disabled, undefined, 'restored skills are the person’s own: enabled as before');
  assert.equal(skills.find((skill) => skill.name === 'weekly-review')?.ownerAgentId, manager.id, 'the manager’s own skill is back');
  assert.match((await second.client.call('skills.get', { name: 'weekly-review' })).body, /Check every team/);
});
