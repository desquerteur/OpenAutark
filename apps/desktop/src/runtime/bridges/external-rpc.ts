// External agents' RPC (C8, split from bridges/external-agents.ts): the person's
// chats.connectExternal ('manage' on a secure transport – the token is shown once) and what an
// external agent's call runs for exactly these methods (rpc/table.ts addExternal):
//  * chats.get and messages.list of its chat (rpc/scopes.ts externalChat / externalMessage) – also
//    the chat's earlier messages (the connect form says so), never a run's live row (state 'streaming');
//  * messages.send as the member: authorKind 'external' – never the person, never an answer,
//    approval or consent –, ≤ 8000 characters, ≤ 10 per minute for the token with all its senders,
//    ≤ 5 stored files (size, type and dimensions from the store), replies only to messages of its
//    chat, nothing while the chat is archived. B-050 K4: `silent: true` posts quietly; `priority:
//    'important'` only with a token the person marked trusted (bridges/external-agents.ts) and only as
//    the connector itself, never for a sender behind it. B-050 K8 (e):
//    `as: {key, name}` posts as a sender behind the connector (a WhatsApp or Signal contact of an
//    out-of-process bridge) – its own external member 'ext:api:<token key>:<sender hash>:<label>' (the
//    key hashed, the name as an ASCII label, so the id passes every RPC id check – chats.members remove,
//    mentions) that joins on its first message (one 'member_added' line, the inbound.ts memberFor
//    pattern), keeps the first name it was seen with and stays out once the person removed it;
//  * events.subscribe / unsubscribe: only its chat's topic (rpc/scopes.ts filters the events);
//  * files.upload: ≤ 2 MB a file, ≤ 10 a minute and ≤ 20 MB an hour per token (rate_limited with
//    retryAfterMs); a new file is queued for the blob clean-up after a 30-minute hold, so one that
//    no message uses goes again (files/cleanup.ts keeps every file something uses).
// Every call checks again that the token is unrevoked and the member still in the chat.
// Owns: those variants and their limits. Never: runs a person's handler for an external agent,
// reads files, drafts or chat settings for it, or trusts sizes and types it sends.

import { createHash } from 'node:crypto';
import type { ClientScope, Topic } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Attachment, Message } from '../../shared/model/chat.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { bad, id, input, onlyKeys, optBool, optId, optIds, optNum, optObj, optOneOf, optText, text } from '../rpc/params.ts';
import { externalChat, externalMessage, isTopic, maySubscribe } from '../rpc/scopes.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { base64Length, decodeBase64 } from '../rpc/uploads.ts';
import { connectExternalAgent, connectorPrefix, externalLabel, liveToken, tokenTrusted } from './external-agents.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const EXTERNAL_LIMITS = {
  perMinute: 10, body: 8000, attachments: 5, topics: 8,
  uploadBytes: 2 * 1024 * 1024, uploadsPerMinute: 10, uploadBytesPerHour: 20 * 1024 * 1024, uploadHoldMs: 30 * MINUTE,
} as const;

type ExternalScope = Extract<ClientScope, { kind: 'external' }>;

/** The caller's scope while its token and membership still hold. */
function live(ctx: HandlerContext): ExternalScope {
  const scope = ctx.scope;
  if (scope.kind !== 'external') throw new WorkforceError('forbidden', 'Only external agents use this.');
  if (!liveToken(ctx.services, scope)) {
    throw new WorkforceError('forbidden', 'This external agent is no longer in the chat.', { details: { reason: 'removed' } });
  }
  return scope;
}

function ownChat(scope: ExternalScope, conversationId: string): void {
  if (conversationId !== scope.conversationId) throw new WorkforceError('forbidden', 'External agents can only use their own chat.', { details: { conversationId } });
}

function topicsOf(params: unknown): Topic[] {
  const value = input(params).topics;
  if (!Array.isArray(value) || value.length > EXTERNAL_LIMITS.topics || !value.every(isTopic)) bad('topics', `a list of at most ${EXTERNAL_LIMITS.topics} topics like 'chat:<id>'`);
  return value as Topic[];
}

/** Stored files only (size, type and dimensions from the store, never from the agent). */
function attachmentsOf(s: RuntimeServices, value: unknown): Attachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > EXTERNAL_LIMITS.attachments) bad('attachments', `a list of at most ${EXTERNAL_LIMITS.attachments} uploaded files`);
  return value.map((entry) => {
    const ref = s.files.get(text(input(entry), 'fileId', { max: 64 })) ?? bad('attachments', 'files uploaded with files.upload');
    const attachment: Attachment = { fileId: ref.id, name: ref.name, mime: ref.mime, size: ref.size };
    if (ref.width !== undefined) attachment.width = ref.width;
    if (ref.height !== undefined) attachment.height = ref.height;
    if (ref.durationMs !== undefined) attachment.durationMs = ref.durationMs;
    return attachment;
  });
}

const rateLimited = (message: string, waitMs: number) => new WorkforceError('rate_limited', message, { retryAfterMs: Math.max(1000, Math.ceil(waitMs)) });

/** At most EXTERNAL_LIMITS.perMinute messages a minute for the token and its senders (counted from the chat's newest messages). */
function checkRate(s: RuntimeServices, scope: ExternalScope): void {
  const now = s.clock.now();
  const prefix = connectorPrefix(scope.memberId);
  const row = s.db.get<{ n: number; first: number | null }>(
    `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM (SELECT author_id, created_at FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 300)
     WHERE substr(author_id, 1, ?) = ? AND created_at > ?`,
    [scope.conversationId, prefix.length, prefix, now - MINUTE],
  );
  if (Number(row?.n ?? 0) < EXTERNAL_LIMITS.perMinute) return;
  throw rateLimited(`At most ${EXTERNAL_LIMITS.perMinute} messages a minute.`, Number(row?.first ?? now) + MINUTE - now);
}

/** Uploads per token in this process (time and bytes, oldest first), per database. */
const uploadLog = new WeakMap<object, Map<string, Array<{ at: number; bytes: number }>>>();

/** ≤ uploadsPerMinute uploads a minute and ≤ uploadBytesPerHour bytes an hour per token; counts this one. */
function checkUpload(s: RuntimeServices, scope: ExternalScope, bytes: number): void {
  const now = s.clock.now();
  let byToken = uploadLog.get(s.db);
  if (!byToken) uploadLog.set(s.db, byToken = new Map());
  const recent = (byToken.get(scope.tokenId) ?? []).filter((entry) => entry.at > now - HOUR);
  const lastMinute = recent.filter((entry) => entry.at > now - MINUTE);
  if (lastMinute.length >= EXTERNAL_LIMITS.uploadsPerMinute) {
    throw rateLimited(`At most ${EXTERNAL_LIMITS.uploadsPerMinute} uploads a minute.`, lastMinute[0].at + MINUTE - now);
  }
  let over = recent.reduce((sum, entry) => sum + entry.bytes, 0) + bytes - EXTERNAL_LIMITS.uploadBytesPerHour;
  if (over > 0) {
    let wait = HOUR;
    for (const entry of recent) {
      over -= entry.bytes;
      if (over <= 0) { wait = entry.at + HOUR - now; break; }
    }
    throw rateLimited('At most 20 MB of uploads an hour.', wait);
  }
  recent.push({ at: now, bytes });
  byToken.set(scope.tokenId, recent);
}

/** The sender's key in its member id: 16 hex digits of its sha256 (a key may hold '+', and the id stays short). */
export const senderHash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);

/** B-050 K8 (e): the member a connector's `as: {key, name}` posts as (see the header). */
function sender(s: RuntimeServices, scope: ExternalScope, as: Record<string, unknown>): string {
  onlyKeys(as, ['key', 'name'], 'as');
  const key = text(as, 'key', { max: 64 });
  if (!/^[A-Za-z0-9_.@+-]{1,64}$/.test(key)) bad('as.key', 'letters, digits and . _ @ + - only');
  const prefix = `${connectorPrefix(scope.memberId)}${senderHash(key)}:`;
  const rows = s.db.all<{ member_id: string; left_at: number | null }>(
    'SELECT member_id, left_at FROM members WHERE conversation_id = ? AND substr(member_id, 1, ?) = ?', [scope.conversationId, prefix.length, prefix],
  );
  const active = rows.find((row) => row.left_at === null);
  if (active) return active.member_id;
  if (rows.length) throw new WorkforceError('forbidden', 'The person removed this sender from the chat.', { details: { reason: 'removed', key } });
  const memberId = `${prefix}${externalLabel(text(as, 'name', { max: 200 }), 'Sender')}`;
  s.chats.setMembers(scope.conversationId, { add: [memberId] }, SYSTEM_ID);
  return memberId;
}

function send(params: unknown, ctx: HandlerContext): Message {
  const scope = live(ctx);
  const s = ctx.services;
  const o = input(params);
  onlyKeys(o, ['conversationId', 'body', 'attachments', 'mentions', 'replyTo', 'clientId', 'silent', 'priority', 'as']);
  ownChat(scope, id(o, 'conversationId'));
  if (s.chats.get(scope.conversationId)?.archivedAt !== undefined) {
    throw new WorkforceError('conflict', 'This chat is archived.', { details: { conversationId: scope.conversationId } });
  }
  const body = text(o, 'body', { max: EXTERNAL_LIMITS.body, allowEmpty: true, multiline: true });
  const attachments = attachmentsOf(s, o.attachments);
  if (!body.trim() && !attachments.length) bad('body', 'text or an attachment');
  const replyTo = optId(o, 'replyTo');
  if (replyTo && s.chats.message(replyTo)?.conversationId !== scope.conversationId) bad('replyTo', 'a message of this chat');
  const silent = optBool(o, 'silent') === true;
  const priority = optOneOf(o, 'priority', ['normal', 'important'] as const) ?? 'normal';
  if (priority === 'important' && !tokenTrusted(s, scope)) bad('priority', "'normal' (important messages need a connector the person marked trusted)");
  const as = optObj(o, 'as');
  // K4: the person trusted the connector, not every contact behind it.
  if (priority === 'important' && as) bad('priority', "'normal' for a sender behind the connector (only the connector itself posts important messages)");
  const clientId = optText(o, 'clientId', { max: 100 });
  const key = clientId ? `ext:${scope.tokenId}:${clientId}` : undefined;
  const repeatedId = key ? s.db.get<{ id: string }>('SELECT id FROM messages WHERE conversation_id = ? AND client_id = ?', [scope.conversationId, key])?.id : undefined;
  const repeated = repeatedId ? s.chats.message(repeatedId) : undefined;
  if (repeated) return externalMessage(repeated); // the same answer again: no new sender, line or count
  checkRate(s, scope);
  const message = s.chats.send({
    conversationId: scope.conversationId, body, attachments, mentions: optIds(o, 'mentions', 20), replyTo, clientId: key,
    authorId: as ? sender(s, scope, as) : scope.memberId, authorKind: 'external', kind: 'text', priority: silent ? 'normal' : priority, silent,
    meta: { via: 'bridge', bridge: { kind: 'api', ...(priority === 'important' ? { trusted: true } : {}) } }, // trusted: checked above (chat/delivery.ts may honour it)
  });
  return externalMessage(message);
}

async function upload(params: unknown, ctx: HandlerContext) {
  const scope = live(ctx);
  const s = ctx.services;
  const o = input(params);
  onlyKeys(o, ['name', 'dataBase64', 'mime']);
  const name = text(o, 'name', { max: 200 });
  const bytes = decodeBase64(text(o, 'dataBase64', { max: base64Length(EXTERNAL_LIMITS.uploadBytes) + 4, allowEmpty: true }), 'dataBase64');
  if (bytes.length > EXTERNAL_LIMITS.uploadBytes) throw new WorkforceError('bad_request', 'External agents can upload files of at most 2 MB.');
  checkUpload(s, scope, bytes.length);
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Only a file new to the store goes back if nothing uses it – never one the person already keeps.
  const known = s.files.get(createHash('sha256').update(data).digest('hex')) !== undefined;
  const ref = await s.files.put(data, name, optText(o, 'mime', { max: 120 }));
  if (!known) {
    try { reclaimerOf(s.files)?.reclaim([ref.id], { notBefore: s.clock.now() + EXTERNAL_LIMITS.uploadHoldMs }); } catch { /* the clean-up logs its own failures */ }
  }
  return ref;
}

/** The newest `limit` lines before `beforeSeq` without a run's live row (its answer comes when it is done): the page
 *  reads on past such rows, so it is full while older lines exist. */
function settledPage(s: RuntimeServices, conversationId: string, beforeSeq: number | undefined, limit: number): Message[] {
  for (let take = limit; ;) {
    const rows = s.chats.messages(conversationId, { beforeSeq, limit: take });
    const settled = rows.filter((message) => message.state !== 'streaming');
    if (settled.length >= limit || rows.length < take) return settled.slice(-limit);
    take = limit + rows.length - settled.length;
  }
}

/** chats.connectExternal and the external agents' variants (called from rpc/handlers/chats.ts). */
export function registerExternalAgents(table: HandlerTable): void {
  table.add('chats.connectExternal', (params, ctx) => connectExternalAgent(ctx.services, params), { capability: 'manage', secure: true });
  table.addExternal('chats.get', (params, ctx) => {
    const scope = live(ctx);
    ownChat(scope, id(input(params)));
    return externalChat(ctx.services.chats.summary(scope.conversationId));
  });
  table.addExternal('messages.list', (params, ctx) => {
    const scope = live(ctx);
    const o = input(params);
    ownChat(scope, id(o, 'conversationId'));
    return settledPage(ctx.services, scope.conversationId, optNum(o, 'beforeSeq', { min: 0 }), optNum(o, 'limit', { min: 1, max: 100 }) ?? 50).map(externalMessage);
  });
  table.addExternal('messages.send', (params, ctx) => send(params, ctx));
  table.addExternal('events.subscribe', (params, ctx) => {
    const scope = live(ctx);
    for (const topic of topicsOf(params)) if (maySubscribe(scope, topic)) ctx.topics.add(topic); // others can never deliver
    return { ok: true };
  });
  table.addExternal('events.unsubscribe', (params, ctx) => {
    for (const topic of topicsOf(params)) ctx.topics.delete(topic);
    return { ok: true };
  });
  table.addExternal('files.upload', (params, ctx) => upload(params, ctx));
}
