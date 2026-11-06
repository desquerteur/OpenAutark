import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importV7 } from '../../../src/runtime/db/import-v7.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { clock, memoryDb, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'settings-v7.json');

function setup(withFixture = true) {
  const temp = tempDir();
  const db = memoryDb();
  const time = clock();
  const { bus } = recordingBus();
  const settings = new SettingsStore({ db, bus, clock: time, env: { locale: 'de-DE', timezone: 'Europe/Berlin' } });
  const files = new Blobs({ db, blobs: path.join(temp.dir, 'blobs'), clock: time, log: nullLogger });
  const org = new Org({ db, bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
  if (withFixture) {
    copyFileSync(FIXTURE, path.join(temp.dir, 'settings.json'));
    mkdirSync(path.join(temp.dir, 'attachments'));
    writeFileSync(path.join(temp.dir, 'attachments', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.txt'), 'brief text!');
    writeFileSync(path.join(temp.dir, 'attachments', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd.txt'), 'draft');
  }
  const deps = { db, files, settings, clock: time, log: nullLogger, dataDir: temp.dir, template: (key: string) => org.templates().find((t) => t.key === key) };
  return { ...temp, db, settings, files, org, deps };
}

test('imports profile, preferences, agents, chats, messages, drafts, attachments, connections', async () => {
  const { db, settings, org, deps, dir, cleanup } = setup();
  try {
    const original = readFileSync(path.join(dir, 'settings.json'), 'utf8');
    const result = await importV7(deps);
    assert.equal(result.status, 'imported');
    assert.deepEqual(result.imported, { agents: 2, chats: 2, messages: 3, drafts: 1, attachments: 2 });
    assert.equal(result.missingAttachments, 1);

    // Settings
    const s = settings.get();
    assert.equal(s.profile.name, 'Ana Example');
    assert.equal(s.profile.company, 'Example GmbH');
    assert.equal(s.profile.timezone, 'Europe/Berlin');
    assert.equal(s.onboarding.completed, true);
    assert.equal(s.onboarding.step, 'done', 'B-044: a set-up legacy profile skips the first run');
    assert.equal(s.preferences.theme, 'dark');
    assert.equal('motion' in s.preferences, false, 'B-044: no Animations setting – the legacy value is not carried over');
    assert.equal(s.preferences.sidebarOpen, false);
    assert.equal(s.preferences.sidebarWidth, 320);
    assert.equal(s.preferences.autoDownloadUpdates, true);
    assert.equal(s.notifications.enabled, true, 'legacy opt-out default does not switch off the new quiet pushes');

    // Agents keep ids; the legacy manager becomes the chief of staff; no extra seed.
    const manager = org.get('manager')!;
    assert.equal(manager.role, 'Chief of staff');
    assert.equal(manager.template, 'manager');
    assert.ok(manager.instructions.length > 0);
    assert.equal(org.get('8f1d2c3b-1111-4222-8333-944455556666')?.name, 'Video Mara');
    assert.equal(org.ensureSeed(), undefined);
    assert.equal(org.list().length, 2);

    // Conversations, members, messages
    const chat = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', ['0a0b0c0d-0000-4000-8000-000000000001'])!;
    assert.equal(chat.title, 'Launch plan');
    assert.equal(chat.title_named, 1);
    assert.equal(chat.last_seq, 2);
    assert.equal(chat.created_at, Date.parse('2026-10-12T08:00:00.000Z'));
    assert.equal(chat.last_message_at, Date.parse('2026-10-12T08:02:00.000Z'));
    assert.deepEqual(JSON.parse(String(chat.settings)), { notifications: 'off' });
    const members = db.all<{ member_id: string; kind: string; role: string; read_seq: number }>('SELECT member_id, kind, role, read_seq FROM members WHERE conversation_id = ? ORDER BY kind', [chat.id as string]);
    assert.deepEqual(members.map((member) => ({ ...member })), [
      { member_id: 'manager', kind: 'agent', role: 'member', read_seq: 2 },
      { member_id: 'human', kind: 'human', role: 'owner', read_seq: 2 },
    ]);
    const group = db.all<{ member_id: string; role: string }>(`SELECT member_id, role FROM members WHERE conversation_id = '0a0b0c0d-0000-4000-8000-000000000002' AND kind = 'agent' ORDER BY role`);
    assert.deepEqual(group.map((member) => member.role), ['lead', 'member']);

    const messages = db.all<Record<string, unknown>>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', [chat.id as string]);
    assert.equal(messages[0].id, '11111111-1111-4111-8111-111111111111');
    assert.equal(messages[0].author_id, 'human');
    assert.equal(messages[0].author_kind, 'human');
    assert.equal(messages[0].created_at, Date.parse('2026-10-12T08:01:00.000Z'));
    const attachments = JSON.parse(String(messages[0].attachments));
    assert.equal(attachments.length, 1, 'missing legacy file is skipped');
    assert.equal(attachments[0].name, 'brief.txt');
    assert.equal(await deps.files.text(attachments[0].fileId), 'brief text!');
    assert.equal(messages[1].author_id, 'manager');
    assert.deepEqual(JSON.parse(String(messages[1].meta)), { model: 'gpt-6.1-sol' });
    const fts = db.all('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?', ['launch']);
    assert.equal(fts.length, 1);
    const odd = db.get<{ created_at: number }>(`SELECT created_at FROM messages WHERE id = '44444444-4444-4444-8444-444444444444'`)!;
    assert.equal(odd.created_at, Date.parse('2026-10-13T08:00:00.000Z'), 'invalid timestamps fall back to the chat creation time');

    // Draft with attachment
    const draft = db.get<{ text: string; attachments: string }>('SELECT text, attachments FROM drafts WHERE conversation_id = ?', [chat.id as string])!;
    assert.equal(draft.text, 'Next I want');
    assert.equal(JSON.parse(draft.attachments)[0].name, 'draft.txt');

    // Connections: list for accounts, ciphertext only in kv, never decrypted
    assert.deepEqual(result.connections.map((connection) => [connection.id, connection.provider, connection.hasKey]), [['openai', 'openai', true], ['local-1', 'local', false]]);
    assert.ok(!JSON.stringify(result.connections).includes('Y2lwaGVydGV4dA=='));
    const stored = new KvRepo(db).get<Array<{ id: string; key: string | null }>>('legacy', 'connections')!;
    assert.equal(stored[0].key, 'Y2lwaGVydGV4dA==');

    // Old file renamed (content unchanged), not deleted
    assert.ok(!existsSync(path.join(dir, 'settings.json')));
    assert.equal(result.backupPath, path.join(dir, 'settings.v7-backup.json'));
    assert.equal(readFileSync(result.backupPath!, 'utf8'), original);
  } finally { cleanup(); }
});

test('idempotent: a second run (even with the file back in place) does nothing', async () => {
  const { deps, dir, db, cleanup } = setup();
  try {
    await importV7(deps);
    copyFileSync(FIXTURE, path.join(dir, 'settings.json'));
    const picked = await importV7(deps, { path: path.join(dir, 'settings.json') });
    assert.equal(picked.status, 'skipped');
    assert.ok(existsSync(path.join(dir, 'settings.json')), 'a skipped import never touches a file the person picked');
    // B-044: a legacy store left at the default path (an earlier backup rename failed) is moved aside, never imported again.
    const again = await importV7(deps);
    assert.equal(again.status, 'skipped');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n, 3);
    assert.equal(existsSync(path.join(dir, 'settings.json')), false, 'moved aside, so the settings file can be written');
    assert.equal(readFileSync(again.backupPath!, 'utf8'), readFileSync(FIXTURE, 'utf8'));
    assert.notEqual(again.backupPath, path.join(dir, 'settings.v7-backup.json'), 'the first backup is kept');
    writeFileSync(path.join(dir, 'settings.json'), '{ "profile": { "name": "Ada" } }');
    assert.equal((await importV7(deps)).backupPath, undefined, "the data folder's own settings.json stays");
  } finally { cleanup(); }
});

test('no legacy file: nothing imported, seed still possible', async () => {
  const { deps, org, cleanup } = setup(false);
  try {
    const result = await importV7(deps);
    assert.equal(result.status, 'none');
    assert.ok(org.ensureSeed());
  } finally { cleanup(); }
});

test('corrupt or unknown files are rejected and left untouched', async () => {
  const { deps, dir, db, cleanup } = setup(false);
  try {
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, '{ not json');
    await assert.rejects(importV7(deps, { path: file }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
    writeFileSync(file, JSON.stringify({ schema: 99 }));
    await assert.rejects(importV7(deps), /unknown format/);
    assert.equal(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'import.v7'`), undefined);
  } finally { cleanup(); }
});

test("B-044: the data folder's own settings.json (no schema field, or a broken edit) is no legacy store: nothing is imported, nothing fails", async () => {
  const { deps, dir, db, cleanup } = setup(false);
  try {
    const file = path.join(dir, 'settings.json');
    for (const text of [JSON.stringify({ profile: { name: 'Ada' } }, null, 2), '{ broken edit']) {
      writeFileSync(file, text);
      assert.equal((await importV7(deps)).status, 'none', text);
      assert.equal(readFileSync(file, 'utf8'), text, 'left as it is');
    }
    assert.equal(db.get(`SELECT value FROM meta WHERE key = 'import.v7'`), undefined);
    await assert.rejects(importV7(deps, { path: file }), /could not be read/, 'a file the person picks is still checked');
  } finally { cleanup(); }
});

test('B-044: a legacy store at settings.json is imported first; the settings file follows from the imported values', async () => {
  const { deps, dir, db, cleanup } = setup();
  try {
    const original = readFileSync(path.join(dir, 'settings.json'), 'utf8');
    const settings = new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env: { locale: 'de-DE', timezone: 'Europe/Berlin' }, dataDir: dir });
    assert.equal(settings.get().profile.name, '', 'the legacy store is not taken over as the settings file');
    assert.equal(settings.notice(), undefined);
    const result = await importV7({ ...deps, settings });
    assert.equal(result.status, 'imported');
    assert.equal(readFileSync(result.backupPath!, 'utf8'), original, 'the backup is the legacy store itself');
    assert.equal(existsSync(path.join(dir, 'settings.rejected.json')), false, 'nothing of it was copied');
    settings.update({ preferences: { enterSends: false } }); // the next change (or the watcher, or the next start) writes the file
    const written = parseText(readFileSync(path.join(dir, 'settings.json'), 'utf8')).data as Record<string, Record<string, unknown>>; // the file carries comment lines
    assert.equal(written.profile.name, 'Ana Example');
    assert.equal(written.schema, undefined);
    assert.equal((await importV7({ ...deps, settings })).status, 'skipped');
  } finally { cleanup(); }
});
