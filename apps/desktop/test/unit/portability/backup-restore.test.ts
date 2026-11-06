// Portability (runtime/portability/*): backup = a copy of the data folder (database via VACUUM INTO, the other
// entries – the memory tree too – as they are, the workspace's and its agents' skills; no CLI logins, logs, chat mirror or earlier backups); restore =
// staged, then put back at the next start with the replaced data moved aside; "Export" = one JSON file with the
// agent, its folder's texts and its notes (secrets redacted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyEntry, isTempFile } from '../../../src/runtime/portability/backup.ts';
import { applyPendingRestore, restorePending } from '../../../src/runtime/portability/restore.ts';
import { restoreStatus } from '../../../src/runtime/portability/service.ts';
import { portabilityFixture, remember, SECRET_VALUE } from './fixture.ts';

test('backup copies the data folder (not logins, logs, chats or old backups) and the workspace skills', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    mkdirSync(path.join(f.paths.data, 'agents', 'ag_x'), { recursive: true });
    writeFileSync(path.join(f.paths.data, 'agents', 'ag_x', 'SYSTEM.md'), '# X\n');
    writeFileSync(path.join(f.paths.data, 'theme.css'), ':root { --accent: red; }\n');
    writeFileSync(path.join(f.paths.data, 'settings.json'), '{ "profile": { "name": "Ada" } }\n');
    mkdirSync(path.join(f.paths.data, 'custom'), { recursive: true });
    mkdirSync(path.join(f.paths.data, 'chats'), { recursive: true });
    writeFileSync(path.join(f.paths.accounts, 'login.json'), '{}');
    writeFileSync(path.join(f.paths.data, 'next-due.json.tmp'), '{}'); // an atomic write's temp file, renamed away at any moment
    mkdirSync(path.join(f.paths.workspace, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(path.join(f.paths.workspace, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n');
    const result = await f.portability.backup();
    const entries = readdirSync(result.path).sort();
    assert.ok(entries.includes('workforce.db') && entries.includes('manifest.json') && entries.includes('agents') && entries.includes('theme.css'));
    assert.equal(readFileSync(path.join(result.path, 'settings.json'), 'utf8'), '{ "profile": { "name": "Ada" } }\n', 'settings.json is in the backup');
    assert.ok(entries.includes('workspace-skills'));
    const note = remember(f, f.manager.id, 'Office', 'Berlin');
    const withMemory = await f.portability.backup(path.join(f.root, 'second-backup'));
    const copied = path.join(withMemory.path, 'memory', ...note.id.split(':'));
    assert.match(readFileSync(copied, 'utf8'), /title: Office[\s\S]*Berlin/, 'the memory tree is in the backup');
    assert.equal(statSync(copied).mtimeMs, statSync(path.join(f.paths.data, 'memory', ...note.id.split(':'))).mtimeMs, 'with its file times');
    for (const left of ['accounts', 'logs', 'chats', 'backups', 'tmp', 'custom', 'next-due.json.tmp']) assert.ok(!entries.includes(left), `${left} is not copied`);
    assert.equal(JSON.parse(readFileSync(path.join(result.path, 'manifest.json'), 'utf8')).format, 'workforce-backup');
    assert.ok(result.bytes > 0);
  } finally { f.cleanup(); }
});

test('temp files at any depth stay out: device sync\'s <file>.<uuid>.tmp, uploads in blobs/tmp, skills in flight', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    mkdirSync(path.join(f.paths.data, 'memory', 'agent'), { recursive: true });
    writeFileSync(path.join(f.paths.data, 'memory', 'agent', 'x.md'), 'kept\n');
    writeFileSync(path.join(f.paths.data, 'memory', 'agent', 'x.md.0b1c.tmp'), 'half\n');
    mkdirSync(path.join(f.paths.blobs, 'tmp'), { recursive: true });
    writeFileSync(path.join(f.paths.blobs, 'tmp', 'y.part'), 'upload');
    writeFileSync(path.join(f.paths.blobs, 'tmp', 'z.bin'), 'in flight');
    mkdirSync(path.join(f.paths.workspace, 'skills', 's'), { recursive: true });
    writeFileSync(path.join(f.paths.workspace, 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n');
    writeFileSync(path.join(f.paths.workspace, 'skills', 's', 'SKILL.md.9f.tmp'), 'half');
    mkdirSync(path.join(f.paths.workspace, 'agents', 'ag_x', 'skills', 'own'), { recursive: true });
    writeFileSync(path.join(f.paths.workspace, 'agents', 'ag_x', 'skills', 'own', 'notes.md.1.tmp'), 'half');
    const result = await f.portability.backup();
    assert.equal(readFileSync(path.join(result.path, 'memory', 'agent', 'x.md'), 'utf8'), 'kept\n');
    assert.ok(!existsSync(path.join(result.path, 'memory', 'agent', 'x.md.0b1c.tmp')), 'a nested .tmp is not copied');
    const blobsIn = path.join(result.path, path.relative(f.paths.data, f.paths.blobs));
    assert.ok(!existsSync(path.join(blobsIn, 'tmp')), 'blobs/tmp (uploads in progress) is not copied');
    assert.ok(existsSync(path.join(result.path, 'workspace-skills', 's', 'SKILL.md')) && !existsSync(path.join(result.path, 'workspace-skills', 's', 'SKILL.md.9f.tmp')));
    assert.ok(!existsSync(path.join(result.path, 'workspace-agent-skills', 'ag_x', 'own', 'notes.md.1.tmp')));
    assert.ok(isTempFile('a.json.tmp') && isTempFile('b.part') && !isTempFile('tmp.md'));
  } finally { f.cleanup(); }
});

test('an entry gone between readdir and the copy leaves nothing behind, not even a half-copied folder', async () => {
  const f = portabilityFixture();
  try {
    const target = path.join(f.root, 'snapshot', 'memory');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'half.md'), 'copied before the folder vanished');
    await copyEntry(path.join(f.paths.data, 'vanished'), target);
    assert.ok(!existsSync(target), 'the partial target is removed');
    await copyEntry(path.join(f.paths.data, 'also-gone.json'), path.join(f.root, 'snapshot', 'also-gone.json'));
    assert.ok(!existsSync(path.join(f.root, 'snapshot', 'also-gone.json')));
  } finally { f.cleanup(); }
});

test('restore is staged, then put back at the next start; the replaced data moves aside', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const kept = remember(f, f.manager.id, 'Office', 'Berlin');
    writeFileSync(path.join(f.paths.data, 'theme.css'), 'old\n');
    writeFileSync(path.join(f.paths.data, 'settings.json'), '{ "profile": { "company": "Old Co" } }\n');
    const ownSkill = (slug: string, name: string) => path.join(f.paths.workspace, 'agents', slug, 'skills', name, 'SKILL.md');
    mkdirSync(path.dirname(ownSkill('ag_x', 'weekly-review')), { recursive: true });
    writeFileSync(ownSkill('ag_x', 'weekly-review'), '---\nname: weekly-review\n---\nCheck every team.\n');
    const backup = await f.portability.backup();
    assert.ok(existsSync(path.join(backup.path, 'workspace-agent-skills', 'ag_x', 'weekly-review', 'SKILL.md')), 'an agent’s own skill is in the backup');
    rmSync(path.join(f.paths.workspace, 'agents', 'ag_x', 'skills'), { recursive: true });
    mkdirSync(path.dirname(ownSkill('ag_y', 'later')), { recursive: true });
    writeFileSync(ownSkill('ag_y', 'later'), '---\nname: later\n---\n');
    remember(f, f.manager.id, 'Later', 'written after the backup');
    writeFileSync(path.join(f.paths.data, 'theme.css'), 'new\n');
    writeFileSync(path.join(f.paths.data, 'settings.json'), '{ "profile": { "company": "New Co" } }\n');
    await assert.rejects(f.portability.restore(path.join(f.paths.data, 'agents')), /outside the data folder/);
    await f.portability.restore(backup.path);
    assert.equal(restoreStatus({ paths: f.paths, host: {} } as never).staged?.path, path.resolve(backup.path));
    f.db.close();
    assert.equal(restorePending(f.paths.data), true);
    assert.equal(applyPendingRestore(f.paths.data, f.log, { workspace: f.paths.workspace, now: Date.UTC(2026, 9, 31, 12) }), true);
    assert.equal(readFileSync(path.join(f.paths.data, 'theme.css'), 'utf8'), 'old\n');
    assert.equal(readFileSync(path.join(f.paths.data, 'settings.json'), 'utf8'), '{ "profile": { "company": "Old Co" } }\n', 'the settings come back');
    assert.match(readFileSync(ownSkill('ag_x', 'weekly-review'), 'utf8'), /Check every team/, 'the agent’s own skill comes back');
    assert.ok(!existsSync(ownSkill('ag_y', 'later')), 'a later agent skill moves aside');
    const notes = path.join(f.paths.data, 'memory', 'agents', f.manager.id);
    assert.deepEqual(readdirSync(notes).filter((name) => !name.startsWith('_')), ['office.md'], `${kept.id} is back, the later note is not`);
    assert.ok(readdirSync(path.join(f.paths.data, readdirSync(f.paths.data).find((name) => name.startsWith('before-restore-'))!, 'memory', 'agents', f.manager.id)).includes('later.md'), 'the later note stays aside');
    assert.ok(readdirSync(f.paths.data).some((name) => name.startsWith('before-restore-')), 'the replaced data stays aside');
    assert.equal(restorePending(f.paths.data), false);
    assert.equal(restoreStatus({ paths: f.paths, host: { restart: async () => undefined } } as never).last?.ok, true);
  } finally { f.cleanup(); }
});

test('a broken staged backup is refused once and the data stays', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const backup = await f.portability.backup();
    await f.portability.restore(backup.path);
    writeFileSync(path.join(backup.path, 'manifest.json'), '{ broken');
    f.db.close();
    assert.equal(applyPendingRestore(f.paths.data, f.log), false);
    assert.equal(restorePending(f.paths.data), false);
    assert.ok(existsSync(path.join(f.paths.data, 'restore-failed.json')));
    assert.equal(restoreStatus({ paths: f.paths, host: {} } as never).last?.ok, false);
  } finally { f.cleanup(); }
});

test('Export writes one redacted JSON file (Duplicate is the skill agent-duplicate, no method)', async () => {
  const f = portabilityFixture();
  try {
    const source = f.org.create({ name: 'Vic', role: 'Video editor', instructions: `Cut fast. Key ${SECRET_VALUE}`, mode: 'video', createdBy: 'human' });
    remember(f, source.id, 'Format', '9:16 for shorts');
    const file = await f.portability.exportAgent(source.id);
    const doc = JSON.parse(new TextDecoder().decode(await f.files.read(file.id)));
    assert.equal(doc.format, 'workforce-agent');
    assert.equal(doc.agent.role, 'Video editor');
    assert.ok(!JSON.stringify(doc).includes(SECRET_VALUE), 'secret values are redacted');
    assert.deepEqual(doc.knowledge.map((note: { title: string }) => note.title), ['Format']);
  } finally { f.cleanup(); }
});
