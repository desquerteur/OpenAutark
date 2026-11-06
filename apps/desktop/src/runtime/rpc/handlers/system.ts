// RPC handlers: system info/resources/restart, event subscriptions, settings, UI state
// (drafts of all chats + the last open chat; both are chat content, so a device without 'chat'
// – a To-do link – gets an empty state). A device with
// 'settings' changes only preferences and notifications, never the PC-only preferences (window
// close, login item, automatic update download – they change the PC, settings audit 23.10.2026).
// system.root (B-044, owner): where <data> and its generated map README.md are (the map written when missing),
// plus the settings file's quiet notice.
// Owns: param checks and scope rules for these methods. Never: business logic – it delegates
// to extras.system, the settings service and the chat service.

import { WorkforceError } from '../../../shared/errors.ts';
import type { Topic } from '../../../shared/api/protocol.ts';
import type { Attachment } from '../../../shared/model/chat.ts';
import path from 'node:path';
import type { RootInfo, SettingsPatch } from '../../../shared/model/system.ts';
import { ROOT_README } from '../../root/layout.ts';
import '../../contracts/open-fs.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import { json } from '../../db/database.ts';
import { attachedSecrets } from '../../secrets/chat-capture.ts';
import { restartRuntime, restoreStatus } from '../../portability/service.ts';
import { bad, id, input, isIdLike, optBool, text } from '../params.ts';
import { isTopic, maySubscribe } from '../scopes.ts';
import { scopeHas } from '../table.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const CHAT = { capability: 'chat' } as const;
const SETTINGS = { capability: 'settings' } as const;
/** Settings sections a phone/browser with the 'settings' capability may change. */
const DEVICE_SETTINGS: ReadonlySet<string> = new Set(['preferences', 'notifications']);
/** Preferences that change the PC itself (window close, login item, updates): never from a device (settings audit 23.10.). */
const PC_ONLY_PREFERENCES: ReadonlySet<string> = new Set(['closeToTray', 'openAtLogin', 'autoDownloadUpdates']);
const MAX_TOPICS = 256;
const MAX_DRAFT = 100_000;
const UI_KV = { ns: 'ui', key: 'lastConversationId' };

/** Remembers the chat the human used last (ui.state → reopen it after a restart). */
export function rememberConversation(services: RuntimeServices, conversationId: string): void {
  try {
    const kv = new KvRepo(services.db);
    if (kv.get<string>(UI_KV.ns, UI_KV.key) !== conversationId) kv.set(UI_KV.ns, UI_KV.key, conversationId, services.clock.now());
  } catch (error) {
    services.log.warn('could not store the last conversation', { error: String(error) });
  }
}

function topicsOf(params: unknown): Topic[] {
  const o = input(params);
  const value = o.topics;
  if (!Array.isArray(value) || value.length > 64) bad('topics', 'a list of at most 64 topics');
  for (const topic of value) if (!isTopic(topic)) bad('topics', "topics like 'chats', 'tasks', 'org', 'providers', 'system', 'chat:<id>' or 'runs:<agentId>'");
  return value as Topic[];
}

function subscribe(params: unknown, ctx: HandlerContext): { ok: true } {
  const wanted = topicsOf(params).filter((topic) => maySubscribe(ctx.scope, topic)); // others can never deliver
  const fresh = wanted.filter((topic) => !ctx.topics.has(topic));
  if (ctx.topics.size + fresh.length > MAX_TOPICS) throw new WorkforceError('conflict', 'Too many subscriptions on this connection.');
  for (const topic of fresh) ctx.topics.add(topic);
  return { ok: true };
}

function updateSettings(params: unknown, ctx: HandlerContext) {
  const patch = input(params) as SettingsPatch;
  if (ctx.scope.kind === 'device') {
    for (const section of Object.keys(patch)) {
      if (!DEVICE_SETTINGS.has(section)) throw new WorkforceError('forbidden', 'This device may only change appearance and notification settings.', { details: { section } });
    }
    const prefs = patch.preferences;
    for (const key of prefs && typeof prefs === 'object' ? Object.keys(prefs) : []) {
      if (PC_ONLY_PREFERENCES.has(key)) throw new WorkforceError('forbidden', 'This setting changes the PC and can only be changed there.', { details: { section: 'preferences', key } });
    }
  }
  return ctx.services.settings.update(patch);
}

/** B-044 system.root: <data>, the workspace, the map (written now when it is missing) and the settings file's quiet notice. */
function rootInfo(services: RuntimeServices): RootInfo {
  services.rootMaps?.writeRoot();
  const notice = services.settings.notice?.();
  return { path: services.paths.data, workspace: services.paths.workspace, readme: path.join(services.paths.data, ROOT_README), ...(notice ? { notices: [notice] } : {}) };
}

function uiState(ctx: HandlerContext): { drafts: Record<string, string>; secretDrafts?: Record<string, string[]>; lastConversationId?: string } {
  if (!scopeHas(ctx.scope, 'chat')) return { drafts: {} };
  const { db } = ctx.services;
  const drafts: Record<string, string> = {};
  const rows = db.all<{ conversation_id: string; text: string; secret_ids: string }>(
    `SELECT d.conversation_id, d.text, d.secret_ids FROM drafts d JOIN conversations c ON c.id = d.conversation_id
     WHERE c.archived_at IS NULL AND (d.text != '' OR d.secret_ids != '[]') ORDER BY d.updated_at DESC LIMIT 500`,
  );
  for (const row of rows) if (row.text) drafts[row.conversation_id] = row.text;
  const secretDrafts: Record<string, string[]> = {};
  for (const row of rows) {
    const refs = json<string[]>(row.secret_ids, []);
    if (refs.length) secretDrafts[row.conversation_id] = refs;
  }
  const last = new KvRepo(db).get<string>(UI_KV.ns, UI_KV.key);
  const result: { drafts: Record<string, string>; secretDrafts?: Record<string, string[]>; lastConversationId?: string } = { drafts };
  if (Object.keys(secretDrafts).length) result.secretDrafts = secretDrafts;
  if (typeof last === 'string' && ctx.services.chats.get(last) && !ctx.services.chats.get(last)!.archivedAt) result.lastConversationId = last;
  return result;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** Draft attachments are a UI convenience: malformed entries are dropped, not rejected. */
function draftAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const entry of value.slice(0, 20)) {
    const a = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!isIdLike(a.fileId) || typeof a.name !== 'string' || typeof a.mime !== 'string') continue;
    const attachment: Attachment = { fileId: a.fileId, name: a.name.slice(0, 200), mime: a.mime.slice(0, 120), size: num(a.size) ?? 0 };
    for (const key of ['width', 'height', 'durationMs'] as const) {
      const value = num(a[key]);
      if (value !== undefined) attachment[key] = value;
    }
    out.push(attachment);
  }
  return out;
}

export function register(table: HandlerTable): void {
  table.add('system.info', (_params, ctx) => ctx.extras.system.info(), TODO);
  table.add('system.resources', (_params, ctx) => ctx.extras.system.resources());
  table.add('system.restartReadiness', (_params, ctx) => ctx.extras.system.restartReadiness());
  table.add('system.prepareRestart', async (params, ctx) => {
    await ctx.extras.system.prepareRestart(optBool(input(params), 'cancel'));
    return { ok: true };
  });

  table.add('events.subscribe', (params, ctx) => subscribe(params, ctx), TODO);
  table.add('events.unsubscribe', (params, ctx) => {
    for (const topic of topicsOf(params)) ctx.topics.delete(topic);
    return { ok: true };
  }, TODO);

  table.add('settings.get', (_params, ctx) => ctx.services.settings.get(), TODO);
  table.add('settings.update', (params, ctx) => updateSettings(params, ctx), SETTINGS);

  table.add('ui.state', (_params, ctx) => uiState(ctx), TODO);
  table.add('ui.saveDraft', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    const draft = text(o, 'text', { max: MAX_DRAFT, allowEmpty: true, multiline: true });
    ctx.services.chats.saveDraft(conversationId, draft, draftAttachments(o.attachments), attachedSecrets(ctx.services, conversationId, o.secrets));
    rememberConversation(ctx.services, conversationId);
    return { ok: true };
  }, CHAT);

  // MM7: Settings › About › Backup – the restore's state and the in-app restart (owner only: paths and the runtime of this PC).
  table.add('system.restoreStatus', (_params, ctx) => restoreStatus(ctx.services));
  table.add('system.restartRuntime', (_params, ctx) => restartRuntime(ctx.services));
  // B-044: where <data> and its generated README.md map are (owner only: paths of this PC).
  table.add('system.root', (_params, ctx) => rootInfo(ctx.services));
}
