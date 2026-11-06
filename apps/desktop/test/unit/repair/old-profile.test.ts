// Upgrade of a representative old profile (schema 9, test/unit/repair/old-profile.ts) to this
// version through the real start path (db/upgrade.ts openDatabase): the pre-update copy holds the
// untouched schema-9 data; after the migration the agents (with org and mode), the chat with its
// messages and attachment, the finished task with its step, the human to-do, the stored file with
// its media description and tags, both accounts' metadata and the agent memory are all still there.
// The service-level proof over RPC is test/e2e/runtime-upgrade.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { listUpgradeBackups, openDatabase, storedSchema, upgradeBackupFile } from '../../../src/runtime/db/upgrade.ts';
import { FIXTURE, IMAGE_ID, OLD_SCHEMA, writeOldProfile } from './old-profile.ts';

test('an old schema-9 profile upgrades with one pre-update copy; tasks, media, accounts and agents survive', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-old-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  writeOldProfile(dir);
  const db = openDatabase({ file: path.join(dir, 'workforce.db'), dataDir: dir, version: '0.3.0', now: () => 7 });
  try {
    assert.equal(storedSchema(db), SCHEMA_VERSION);
    const agents = db.all<{ id: string; name: string; manager_id: string | null; mode: string; space_id: string }>('SELECT id, name, manager_id, mode, space_id FROM agents ORDER BY id');
    assert.deepEqual(agents.map((agent) => [agent.id, agent.name, agent.manager_id, agent.mode, agent.space_id]), [
      [FIXTURE.managerId, 'Mira', null, 'manager', FIXTURE.spaceId],
      [FIXTURE.videoId, 'Vid', FIXTURE.managerId, 'video', FIXTURE.spaceId],
    ]);
    assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM messages WHERE conversation_id = ?', [FIXTURE.chatId])?.n, 2);
    assert.match(db.get<{ attachments: string }>(`SELECT attachments FROM messages WHERE id = 'ms_2'`)?.attachments ?? '', new RegExp(IMAGE_ID));
    const tasks = db.all<{ id: string; status: string; parent_id: string | null; assignee_kind: string; result: string | null }>('SELECT id, status, parent_id, assignee_kind, result FROM tasks ORDER BY id');
    assert.deepEqual(tasks.map((task) => [task.id, task.status, task.parent_id, task.assignee_kind]), [
      [FIXTURE.taskId, 'done', null, 'agent'], [FIXTURE.stepId, 'done', FIXTURE.taskId, 'agent'], [FIXTURE.todoId, 'open', null, 'human'],
    ]);
    assert.match(tasks[0].result ?? '', /Flyer made/);
    const media = db.get<{ description: string; tags: string; conversation_id: string }>('SELECT description, tags, conversation_id FROM media WHERE file_id = ?', [IMAGE_ID]);
    assert.deepEqual({ ...media }, { description: 'Launch flyer, final', tags: '["launch","flyer"]', conversation_id: FIXTURE.chatId });
    const accounts = db.all<{ id: string; provider: string; label: string; plan: string | null; email: string | null; enabled: number; home: string | null }>('SELECT id, provider, label, plan, email, enabled, home FROM accounts ORDER BY id');
    assert.deepEqual(accounts.map((account) => [account.id, account.provider, account.label, account.plan, account.email, account.enabled]), [
      [FIXTURE.codexId, 'codex', 'Codex · work', 'pro', 'person@example.com', 0], [FIXTURE.localId, 'compatible', 'Local model', null, null, 1],
    ]);
    assert.equal(accounts[0].home, path.join(dir, 'accounts', FIXTURE.codexId));
    assert.equal(db.get<{ body: string }>('SELECT body FROM knowledge WHERE id = ?', [FIXTURE.knowledgeId])?.body, 'Use the brand colours on flyers.');
  } finally {
    db.close();
  }
  const [copy] = listUpgradeBackups(dir);
  assert.equal(copy.id, `0.3.0-s${OLD_SCHEMA}`);
  const old = new DatabaseSync(upgradeBackupFile(dir, copy.id)!, { readOnly: true });
  try {
    assert.equal((old.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string }).value, String(OLD_SCHEMA));
    assert.equal((old.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 3, 'the copy has the old data');
  } finally {
    old.close();
  }
});
