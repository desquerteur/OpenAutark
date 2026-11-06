// One-time import of the legacy JSON store (schema ≤ 7, `<userData>/settings.json`, the format the former
// app's settings.cjs and chat-data.cjs wrote) into SQLite.
// Owns: mapping profile/preferences/notifications, agents (ids kept), chats → conversations,
// members, messages (authors + timestamps kept), drafts, attachments (bytes copied into the
// blob store), and handing legacy connections to the accounts module.
// Never: decrypts or copies API keys into new places (only the existing ciphertext reference
// is kept in kv 'legacy'/'connections'), modifies the old file (it is renamed to
// settings.v7-backup.json only after a successful import), or runs twice (meta 'import.v7').
// Call it before OrgService.ensureSeed() so an imported Manager is not duplicated.
// B-044: <data>/settings.json is now also the open data folder's settings file (settings/service.ts). At the
// default path a file without a `schema` field – or one that is no JSON (a broken edit of that file) – is that
// file, not a legacy store: nothing to import, no error. The settings service leaves a legacy store alone until
// this import has moved it aside (legacy-store.ts) – so a store an earlier import could not rename is moved aside
// at the next start (moveLeftover), else the settings file would never be written.

import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Clock, FileStore, Logger, SettingsService } from '../contracts.ts';
import type { Db } from './database.ts';
import { toJson } from './database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { Agent, AgentTemplate } from '../../shared/model/org.ts';
import type { SettingsPatch } from '../../shared/model/system.ts';
import { AgentRepo } from '../store/agents.ts';
import { KvRepo, MetaRepo } from '../store/kv.ts';
import { defaultAvatar } from '../org/avatar.ts';
import { isLegacyStore } from './legacy-store.ts';

export interface ImportV7Deps {
  db: Db;
  files: FileStore;
  settings: SettingsService;
  clock: Clock;
  log: Logger;
  dataDir: string; // legacy userData (settings.json + attachments/)
  template?: (key: string) => AgentTemplate | undefined; // for the legacy 'manager' agent
  /** Full-text indexing of imported messages (the chat module's normalizer). Default: raw body. */
  indexMessage?: (message: { id: string; conversationId: string; body: string }) => void;
}

export interface LegacyConnection {
  id: string;
  provider: string; // openai | anthropic | compatible | local
  name: string;
  endpoint: string;
  models: string[];
  checkedAt?: string;
  hasKey: boolean; // ciphertext stays in kv legacy/connections, never decrypted here
}

export interface ImportV7Result {
  status: 'imported' | 'skipped' | 'none';
  imported: { agents: number; chats: number; messages: number; drafts: number; attachments: number };
  missingAttachments: number;
  connections: LegacyConnection[];
  backupPath?: string;
}

const META_KEY = 'import.v7';
const MAX_FILE = 64 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max = 32000): string => (typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : '');
const time = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const empty = (): ImportV7Result => ({
  status: 'none', imported: { agents: 0, chats: 0, messages: 0, drafts: 0, attachments: 0 }, missingAttachments: 0, connections: [],
});

export async function importV7(deps: ImportV7Deps, options: { path?: string } = {}): Promise<ImportV7Result> {
  const meta = new MetaRepo(deps.db);
  const result = empty();
  const file = options.path ?? path.join(deps.dataDir, 'settings.json');
  if (meta.get(META_KEY)) {
    if (!options.path) result.backupPath = await moveLeftover(file, deps);
    return { ...result, status: 'skipped' };
  }

  let raw: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_FILE) throw new WorkforceError('bad_request', 'The old settings file is too large to import.');
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return result;
    throw error;
  }
  let saved: Json;
  try { saved = obj(JSON.parse(raw)); } catch {
    if (!options.path) return result; // B-044: a broken edit of the data folder's settings.json, not a legacy store
    throw new WorkforceError('bad_request', 'The old settings file could not be read. It was not changed.');
  }
  if (!options.path && !('schema' in saved)) return result; // B-044: the data folder's settings.json (settings/service.ts)
  const schema = Number(saved.schema);
  if (!Number.isInteger(schema) || schema < 1 || schema > 7) throw new WorkforceError('bad_request', 'The old settings file has an unknown format. It was not changed.');

  const now = deps.clock.now();
  const chats = arr(saved.chats).map(obj);

  // 1. Attachments first (async): copy legacy files into the blob store, keyed by legacy uuid.
  const blobs = new Map<string, Attachment>();
  const legacyRefs = chats.flatMap((chat) => [...arr(chat.attachments), ...arr(chat.messages).flatMap((m) => arr(obj(m).attachments))]).map(obj);
  for (const ref of legacyRefs) {
    const id = str(ref.id, 64);
    if (!/^[a-f0-9-]{36}$/.test(id) || blobs.has(id)) continue;
    const ext = EXTENSIONS[str(ref.mime, 64)];
    if (!ext) { result.missingAttachments++; continue; }
    try {
      const bytes = await readFile(path.join(deps.dataDir, 'attachments', `${id}.${ext}`));
      const stored = await deps.files.put(new Uint8Array(bytes), str(ref.name, 200) || `${id}.${ext}`, str(ref.mime, 64));
      const attachment: Attachment = { fileId: stored.id, name: str(ref.name, 200) || stored.name, mime: stored.mime, size: stored.size };
      if (stored.width !== undefined) attachment.width = stored.width;
      if (stored.height !== undefined) attachment.height = stored.height;
      blobs.set(id, attachment);
    } catch (error) {
      deps.log.warn('legacy attachment missing', { id, error });
      result.missingAttachments++;
    }
  }
  const mapAttachments = (list: unknown): Attachment[] =>
    arr(list).map((ref) => blobs.get(str(obj(ref).id, 64))).filter((item): item is Attachment => Boolean(item));

  // 2. Connections → accounts module (no key material leaves the ciphertext row).
  const connectionsRaw = Object.entries(obj(saved.connections));
  result.connections = connectionsRaw.map(([id, value]) => {
    const connection = obj(value);
    return {
      id, provider: str(connection.provider, 40) || id, name: str(connection.name, 80), endpoint: str(connection.endpoint, 400),
      models: arr(connection.models).map((model) => str(model, 200)).filter(Boolean), checkedAt: str(connection.checkedAt, 40) || undefined,
      hasKey: typeof connection.key === 'string' && connection.key.length > 0,
    };
  });

  // 3. Everything else in one transaction together with the idempotency marker.
  const agents = new AgentRepo(deps.db);
  const kv = new KvRepo(deps.db);
  const agentIds = new Set<string>();
  const agentModels: Record<string, unknown> = {};
  const chatModels: Record<string, unknown> = {};
  const index = deps.indexMessage ?? ((message) => {
    deps.db.run('INSERT INTO messages_fts (message_id, conversation_id, text) VALUES (?, ?, ?)', [message.id, message.conversationId, message.body]);
  });

  deps.db.tx(() => {
    for (const value of arr(saved.agents).map(obj)) {
      const id = str(value.id, 80);
      const name = str(value.name, 80).trim();
      if (!id || !name || agentIds.has(id)) continue;
      agentIds.add(id);
      if (value.model) agentModels[id] = value.model;
      if (agents.get(id)) continue;
      const isManager = id === 'manager';
      const template = isManager ? deps.template?.('manager') : undefined;
      const agent: Agent = {
        id, name, role: isManager ? 'Chief of staff' : '', avatar: defaultAvatar(id, name),
        instructions: template?.instructions ?? '', mode: isManager ? 'manager' : 'general', skills: template?.skills ?? [],
        modelPolicy: template?.effort ? { effort: template.effort } : {}, status: 'idle',
        createdBy: HUMAN_ID, createdAt: now, updatedAt: now,
      };
      if (isManager) agent.template = 'manager';
      agents.save(agent);
      result.imported.agents++;
    }

    for (const chat of chats) {
      const id = str(chat.id, 80);
      if (!id || deps.db.get('SELECT 1 FROM conversations WHERE id = ?', [id])) continue;
      const createdAt = time(chat.createdAt, now);
      const messages = arr(chat.messages).map(obj);
      const members = arr(chat.members).map(obj)
        .filter((member) => member.type === 'agent' && agentIds.has(str(member.id, 80)))
        .map((member) => str(member.id, 80));
      const settings: Json = {};
      if (chat.notifications === 'on') settings.notifications = 'all';
      if (chat.notifications === 'off') settings.notifications = 'off';
      if (chat.models && Object.keys(obj(chat.models)).length) chatModels[id] = chat.models;
      const lastAt = messages.length ? time(messages[messages.length - 1].at, createdAt) : undefined;
      const title = str(chat.title, 120).trim();

      deps.db.run(
        `INSERT INTO conversations (id, title, title_named, created_by, pinned, settings, last_message_at, last_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [id, title, chat.titleNamed === true ? 1 : 0, HUMAN_ID, toJson(settings), lastAt ?? null, messages.length, createdAt, time(chat.updatedAt, createdAt)],
      );
      const memberSql = `INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at) VALUES (?, ?, ?, ?, ?, ?)`;
      deps.db.run(memberSql, [id, HUMAN_ID, 'human', 'owner', messages.length, createdAt]);
      members.forEach((agentId, position) => {
        // Groups get a lead (answers un-addressed messages); the first agent was the legacy default.
        deps.db.run(memberSql, [id, agentId, 'agent', members.length > 1 && position === 0 ? 'lead' : 'member', messages.length, createdAt]);
      });

      let seq = 0;
      for (const message of messages) {
        const messageId = str(message.id, 80);
        const author = obj(message.author);
        if (!messageId) continue;
        seq++;
        const human = author.type === 'human';
        const authorId = human ? HUMAN_ID : str(author.id, 80) || 'unknown';
        const body = str(message.text);
        const meta: Json = {};
        const model = obj(message.model);
        if (typeof model.model === 'string') meta.model = model.model;
        deps.db.run(
          `INSERT INTO messages (id, conversation_id, seq, author_id, author_kind, kind, body, attachments, state, meta, created_at)
           VALUES (?, ?, ?, ?, ?, 'text', ?, ?, 'final', ?, ?)`,
          [messageId, id, seq, authorId, human ? 'human' : 'agent', body, toJson(mapAttachments(message.attachments)), toJson(meta), time(message.at, createdAt)],
        );
        if (body) index({ id: messageId, conversationId: id, body });
        result.imported.messages++;
      }
      if (seq !== messages.length) deps.db.run('UPDATE conversations SET last_seq = ? WHERE id = ?', [seq, id]);
      deps.db.run('UPDATE members SET read_seq = ? WHERE conversation_id = ?', [seq, id]);

      const draftText = str(chat.draft);
      const draftFiles = mapAttachments(chat.attachments);
      if (draftText || draftFiles.length) {
        deps.db.run('INSERT INTO drafts (conversation_id, text, attachments, updated_at) VALUES (?, ?, ?, ?)', [id, draftText, toJson(draftFiles), now]);
        result.imported.drafts++;
      }
      result.imported.chats++;
    }

    // Ciphertext references only; the accounts module decides how to re-home them.
    kv.set('legacy', 'connections', connectionsRaw.map(([id, value]) => ({ id, ...obj(value) })), now);
    if (Object.keys(agentModels).length) kv.set('legacy', 'agentModels', agentModels, now);
    if (Object.keys(chatModels).length) kv.set('legacy', 'chatModels', chatModels, now);
    result.imported.attachments = blobs.size;
    meta.set(META_KEY, JSON.stringify({ at: now, schema, ...result.imported }));
  });

  applySettings(deps, saved);

  // Keep the old file as backup; a failed rename is harmless (the meta marker prevents re-import).
  const backup = await freeBackupPath(path.dirname(file), now);
  try {
    await rename(file, backup);
    result.backupPath = backup;
  } catch (error) {
    deps.log.warn('legacy settings backup rename failed', { error });
  }
  result.status = 'imported';
  deps.log.info('legacy store imported', { ...result.imported, missingAttachments: result.missingAttachments, connections: result.connections.length });
  return result;
}

/** Applies each legacy setting separately; an invalid legacy value never blocks the import. */
function applySettings(deps: ImportV7Deps, saved: Json): void {
  const profile = obj(saved.profile);
  const preferences = obj(saved.preferences);
  const notifications = obj(saved.notifications);
  const patches: SettingsPatch[] = [
    { profile: { name: str(profile.name, 120).trim(), company: str(profile.company, 200).trim() } },
    { onboarding: profile.configured === true ? { completed: true, step: 'done' } : { completed: false } }, // B-044: a set-up profile skips the first run
    { preferences: { theme: preferences.theme as never } },
    { preferences: { sidebarOpen: preferences.sidebarOpen as never } },
    { preferences: { sidebarWidth: preferences.sidebarWidth as never } },
    { preferences: { autoDownloadUpdates: saved.autoDownload as never } },
    // Legacy notifications were opt-in and off by default: only carry over an explicit opt-in.
    ...(notifications.enabled === true ? [{ notifications: { enabled: true, sound: notifications.sound === true } }] : []),
  ];
  for (const patch of patches) {
    const section = Object.values(patch)[0] as Json;
    if (Object.values(section).some((value) => value === undefined)) continue;
    try { deps.settings.update(patch); } catch (error) { deps.log.warn('legacy setting skipped', { section: Object.keys(patch)[0], error }); }
  }
}

/** B-044: a legacy store still at the default path after its import (the backup rename failed then) is moved aside now. */
async function moveLeftover(file: string, deps: Pick<ImportV7Deps, 'clock' | 'log'>): Promise<string | undefined> {
  let legacy = false;
  try { legacy = (await stat(file)).size <= MAX_FILE && isLegacyStore(JSON.parse(await readFile(file, 'utf8'))); } catch { return undefined; }
  if (!legacy) return undefined;
  const backup = await freeBackupPath(path.dirname(file), deps.clock.now());
  try { await rename(file, backup); } catch (error) { deps.log.warn('legacy settings backup rename failed', { error }); return undefined; }
  deps.log.info('legacy store left after its import moved aside', {});
  return backup;
}

async function freeBackupPath(dir: string, now: number): Promise<string> {
  const base = path.join(dir, 'settings.v7-backup.json');
  try { await stat(base); } catch { return base; }
  return path.join(dir, `settings.v7-backup-${now}.json`);
}
