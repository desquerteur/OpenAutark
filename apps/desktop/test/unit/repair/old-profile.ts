// Test fixture (23.10.2026): a representative profile an older app left behind – the database at an
// old schema (migrate until OLD_SCHEMA, rows written with that schema's columns, as that app wrote
// them) plus the stored file in the blob store: a space, a Manager and a video specialist reporting
// to it, a chat with both messages (one with an attachment), a finished task with a done step, an
// open human to-do, a stored image with its media row (described and tagged), a CLI account's
// metadata (disabled, so no CLI ever runs) and a local API account, an agent memory and the version
// the old app recorded. Used by the unit upgrade test and the headless e2e.
// Owns: fixture data only. Never imported by src/.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';

/** Schema 9: the last migration before the 20s (task_assigned_by) – an early 0.1.x profile. */
export const OLD_SCHEMA = 9;
export const OLD_VERSION = '0.1.8';
const T = Date.UTC(2026, 8, 30, 10);

/** 1×1 PNG. */
export const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const IMAGE_ID = createHash('sha256').update(IMAGE).digest('hex');

export const FIXTURE = {
  spaceId: 'sp_company', managerId: 'ag_manager', videoId: 'ag_video', chatId: 'cv_launch',
  taskId: 'tk_flyer', stepId: 'tk_flyer_step', todoId: 'tk_sign', codexId: 'ac_codex', localId: 'ac_local', knowledgeId: 'kn_style',
} as const;

/** Writes the old profile into `dataDir` (workforce.db + blobs). */
export function writeOldProfile(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const blob = path.join(dataDir, 'blobs', IMAGE_ID.slice(0, 2), IMAGE_ID.slice(2, 4));
  mkdirSync(blob, { recursive: true });
  writeFileSync(path.join(blob, IMAGE_ID), IMAGE);
  mkdirSync(path.join(dataDir, 'accounts', FIXTURE.codexId), { recursive: true });

  const db = new Db(path.join(dataDir, 'workforce.db'));
  migrate(db, { until: OLD_SCHEMA });
  const f = FIXTURE;
  db.run(`INSERT INTO spaces (id, name, kind, sort, created_at) VALUES (?, 'Company', 'company', 0, ?)`, [f.spaceId, T]);
  db.run(`INSERT INTO agents (id, name, role, avatar, space_id, instructions, mode, template, created_by, created_at, updated_at)
          VALUES (?, 'Mira', 'Manager', 'm1', ?, 'Keep the team small.', 'manager', 'manager', 'human', ?, ?)`, [f.managerId, f.spaceId, T, T]);
  db.run(`INSERT INTO agents (id, name, role, avatar, space_id, manager_id, mode, template, created_by, created_at, updated_at)
          VALUES (?, 'Vid', 'Video editor', 'v1', ?, ?, 'video', 'video-editor', ?, ?, ?)`, [f.videoId, f.spaceId, f.managerId, f.managerId, T, T]);
  db.run(`INSERT INTO conversations (id, title, title_named, space_id, created_by, last_message_at, last_seq, created_at, updated_at)
          VALUES (?, 'Product launch', 1, ?, 'human', ?, 2, ?, ?)`, [f.chatId, f.spaceId, T + 2, T, T + 2]);
  for (const [member, kind] of [['human', 'human'], [f.managerId, 'agent']] as const) {
    db.run(`INSERT INTO members (conversation_id, member_id, kind, read_seq, joined_at) VALUES (?, ?, ?, 2, ?)`, [f.chatId, member, kind, T]);
  }
  const attachment = JSON.stringify([{ fileId: IMAGE_ID, name: 'flyer.png', mime: 'image/png', size: IMAGE.length }]);
  db.run(`INSERT INTO messages (id, conversation_id, seq, author_id, author_kind, body, created_at) VALUES ('ms_1', ?, 1, 'human', 'human', 'Please make the launch flyer.', ?)`, [f.chatId, T + 1]);
  db.run(`INSERT INTO messages (id, conversation_id, seq, author_id, author_kind, body, attachments, task_id, created_at) VALUES ('ms_2', ?, 2, ?, 'agent', 'Here is the flyer.', ?, ?, ?)`, [f.chatId, f.managerId, attachment, f.taskId, T + 2]);
  db.run(`INSERT INTO tasks (id, conversation_id, message_id, title, notes, status, assignee_kind, assignee_id, created_by, done_when, mode, result, created_at, updated_at, completed_at)
          VALUES (?, ?, 'ms_1', 'Make the launch flyer', 'A4, our colours.', 'done', 'agent', ?, 'human', 'A PNG in the chat', 'general', ?, ?, ?, ?)`,
  [f.taskId, f.chatId, f.managerId, JSON.stringify({ summary: 'Flyer made.', evidence: [`file:${IMAGE_ID}`] }), T, T + 2, T + 2]);
  db.run(`INSERT INTO tasks (id, conversation_id, parent_id, title, status, assignee_kind, assignee_id, created_by, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, 'Pick the colours', 'done', 'agent', ?, 'human', ?, ?, ?)`, [f.stepId, f.chatId, f.taskId, f.managerId, T, T + 1, T + 1]);
  db.run(`INSERT INTO tasks (id, conversation_id, title, status, assignee_kind, assignee_id, created_by, human_reason, created_at, updated_at)
          VALUES (?, ?, 'Sign the print order', 'open', 'human', 'human', ?, 'signature', ?, ?)`, [f.todoId, f.chatId, f.managerId, T + 3, T + 3]);
  db.run(`INSERT INTO files (id, name, mime, size, created_at, width, height, refs) VALUES (?, 'flyer.png', 'image/png', ?, ?, 1, 1, 1)`, [IMAGE_ID, IMAGE.length, T + 2]);
  db.run(`INSERT INTO media (file_id, conversation_id, kind, mime, name, width, height, description, tags, described_by, described_at, created_at, updated_at)
          VALUES (?, ?, 'image', 'image/png', 'flyer.png', 1, 1, 'Launch flyer, final', '["launch","flyer"]', 'human', ?, ?, ?)`, [IMAGE_ID, f.chatId, T + 3, T + 2, T + 3]);
  db.run(`INSERT INTO media_fts (rowid, file_id, name, description, tags) VALUES ((SELECT rowid FROM media WHERE file_id = ?), ?, 'flyer.png', 'launch flyer, final', 'launch flyer')`, [IMAGE_ID, IMAGE_ID]);
  db.run(`INSERT INTO accounts (id, provider, label, auth, home, state, plan, email, priority, rotation, enabled, detected, created_at)
          VALUES (?, 'codex', 'Codex · work', 'cli', ?, 'ok', 'pro', 'person@example.com', 0, 0, 0, 1, ?)`, [f.codexId, path.join(dataDir, 'accounts', f.codexId), T]);
  db.run(`INSERT INTO accounts (id, provider, label, auth, base_url, state, priority, rotation, enabled, created_at)
          VALUES (?, 'compatible', 'Local model', 'none', 'http://127.0.0.1:9/v1', 'ok', 1, 0, 1, ?)`, [f.localId, T]);
  db.run(`INSERT INTO knowledge (id, scope, scope_id, kind, title, body, source, recorded_at, created_by)
          VALUES (?, 'agent', ?, 'preference', 'Flyer style', 'Use the brand colours on flyers.', '{"kind":"human"}', ?, 'human')`, [f.knowledgeId, f.managerId, T]);
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('system', 'version', ?, ?)`, [JSON.stringify(OLD_VERSION), T]);
  db.close();
}
