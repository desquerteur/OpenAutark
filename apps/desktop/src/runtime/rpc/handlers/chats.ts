// RPC handlers: chats (list/get/create/update/members/archive/unarchive/delete/read/search) and
// messages (list/send/edit/delete/stop/retry/schedule). Block answers/state/events live in
// blocks.ts and are registered from here.
// Owns: param checks, scope rules and the human side of these flows (messages are sent as
// 'human' – B-050 K4 at a level: normal, important or silent, never both; K6 a `model` is the
// addressed agent's hint, `pin: true` pins it – chat/sticky-model.ts is the one writer). Phones with
// 'chat' may rename/pin/mute, change members and (un)archive; hiding a chat stays on the PC, and they edit or delete
// only messages written by the human (never a person's message). Deleting a chat stays owner-only. A human mode
// switch (settings.mode) posts one quiet 'mode_switched' line (SES2). B-078: settings.parentId places a chat under
// another one (null: back on top; chat/children.ts checks it) and chats.thread finds or opens the thread on a message.
// Never: business logic – it delegates to the chat service, dispatcher, wake queue and scheduler.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { excerpt } from '../../../shared/text/chat-names.ts';
import type { Attachment, Conversation, ConversationSettings, SendMessageInput } from '../../../shared/model/chat.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import type { ScheduleSpec } from '../../../shared/model/tasks.ts';
import { HINT_ID } from '../../../shared/model/model-guide.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { chatTitleFor } from '../../chat/titles.ts';
import { openThread, setParent } from '../../chat/children.ts';
import { POST_PRIORITIES, scheduledPost } from '../../schedules/post.ts';
import { scopeHas } from '../table.ts';
import {
  bad, id, ids, input, notFound, num, obj, onlyKeys, optBool, optId, optIds, optMemberIds, optNum, optObj, optOneOf, optText, text, type Obj,
} from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { register as registerBlocks } from './blocks.ts';
import { rememberConversation } from './system.ts';
import { registerExternalAgents } from '../../bridges/external-rpc.ts'; // C8
import { attachedSecrets } from '../../secrets/chat-capture.ts';
import { callLogOf, talkerOf } from '../../calls/wiring.ts';
import { callDevice } from './calls.ts';

const CHAT = { capability: 'chat' } as const;
const EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_BODY = 100_000;
const MAX_ATTACHMENTS = 20;
/** Chat settings a client may send. Never 'system': only the runtime marks app-owned chats (C1). */
const SETTINGS_KEYS = ['notifications', 'sound', 'models', 'efforts', 'mode', 'image', 'hiddenFromList', 'modelHints', 'history', 'parentId'] as const; // modelHints: SG soft model suggestion; history (F-52): what people who join later see

/** Chat settings a phone/browser may change depend on its tier (the owner may change all). */
function checkDeviceSettings(ctx: HandlerContext, settings: Partial<ConversationSettings> | undefined): void {
  if (ctx.scope.kind !== 'device' || !settings) return;
  if ('hiddenFromList' in settings) {
    throw new WorkforceError('forbidden', 'Hiding a chat is only possible on the PC.', { details: { param: 'settings.hiddenFromList' } });
  }
}

/**
 * Phones/browsers act as the human: they may only change what the human wrote. Nobody here
 * changes or deletes what a person of the organisation wrote.
 */
function checkDeviceMessage(ctx: HandlerContext, messageId: string): void {
  const message = ctx.services.chats.message(messageId) ?? notFound('Message', { messageId });
  if (message.authorKind === 'human' && isPersonId(message.authorId)) {
    throw new WorkforceError('forbidden', 'Only the person who wrote this message can change it.', { details: { messageId } });
  }
  if (ctx.scope.kind !== 'device') return;
  if (message.authorKind !== 'human' || message.authorId !== HUMAN_ID) throw new WorkforceError('forbidden', 'Only your own messages can be changed from this device.', { details: { messageId } });
}

function chatOrThrow(services: RuntimeServices, conversationId: string) {
  return services.chats.get(conversationId) ?? notFound('Chat', { conversationId });
}

/** Attachments must be stored files; size/mime come from the store, never from the client. */
export function attachmentsOf(services: RuntimeServices, value: unknown): Attachment[] { // also the task center's quick intake
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) bad('attachments', `a list of at most ${MAX_ATTACHMENTS} attachments`);
  return value.map((entry) => {
    const a = input(entry);
    const fileId = text(a, 'fileId', { max: 64 });
    const ref = services.files.get(fileId) ?? bad('attachments', 'files uploaded with files.upload');
    const attachment: Attachment = { fileId: ref.id, name: optText(a, 'name', { max: 200 }) ?? ref.name, mime: ref.mime, size: ref.size };
    if (ref.width !== undefined) attachment.width = ref.width;
    if (ref.height !== undefined) attachment.height = ref.height;
    const duration = ref.durationMs ?? optNum(a, 'durationMs', { min: 0, max: 7 * 24 * 3_600_000 });
    if (duration !== undefined) attachment.durationMs = duration;
    return attachment;
  });
}

function settingsOf(value: unknown): Partial<ConversationSettings> | undefined {
  if (value === undefined || value === null) return undefined;
  const o = input(value);
  onlyKeys(o, SETTINGS_KEYS, 'settings');
  const out: Record<string, unknown> = {};
  // null clears a key (JSON has no undefined).
  for (const key of SETTINGS_KEYS) if (key in o) out[key] = o[key] === null ? undefined : o[key];
  if (out.notifications !== undefined) optOneOf(out, 'notifications', ['default', 'all', 'mentions', 'off']);
  if (out.sound !== undefined) optBool(out, 'sound');
  if (out.hiddenFromList !== undefined) optBool(out, 'hiddenFromList');
  if (out.mode !== undefined) text(out, 'mode', { max: 60 });
  if (out.image !== undefined) text(out, 'image', { max: 120 });
  if (out.history !== undefined) optOneOf(out, 'history', ['join', 'full']);
  if (out.parentId !== undefined) id(out, 'parentId');
  for (const key of ['models', 'efforts', 'modelHints'] as const) {
    if (out[key] === undefined) continue;
    const record = obj(out, key);
    for (const [agentId, choice] of Object.entries(record)) {
      if (typeof choice !== 'string' || choice.length > 200 || agentId.length > 128) bad(`settings.${key}`, 'agent id → model/effort text');
      if (key === 'modelHints' && !HINT_ID.test(choice)) bad('settings.modelHints', 'agent id → model id'); // SG: it reaches prompts
    }
  }
  return out as Partial<ConversationSettings>;
}

/**
 * B-050 K4: a message's level – `priority` and `silent` (quiet: lands in the history, wakes only @mentioned
 * members, never unread or pushed); a message is never both important and silent.
 */
export function levelOf(o: Obj): { priority?: 'normal' | 'important'; silent?: boolean } { // also the person's messages.send
  const priority = optOneOf(o, 'priority', ['normal', 'important']);
  const silent = optBool(o, 'silent');
  if (silent && priority === 'important') bad('silent', 'either silent or priority important, not both');
  return { ...(priority ? { priority } : {}), ...(silent ? { silent } : {}) };
}

/** K6: the model asked for with a message or a new task – a model id (it reaches prompts and the chat line) or 'auto'. */
export function modelOf(o: Obj): string | undefined {
  const model = optText(o, 'model', { max: 200 });
  if (model !== undefined && model !== 'auto' && !HINT_ID.test(model)) bad('model', 'a model id or auto');
  return model;
}

/** SES2: a human mode switch is one quiet line; the agents' next turns renew their sessions. */
function modeSwitched(services: RuntimeServices, chat: Conversation, before: string | undefined): void {
  const to = chat.settings.mode;
  if ((to ?? '') === (before ?? '')) return;
  let name = to;
  try { if (to) name = services.modes.get(to).name || to; } catch { /* unknown mode: its key */ }
  const text = name ? `Switched to ${name} mode` : 'Mode reset to the agent default';
  try { services.chats.status(chat.id, { type: 'mode_switched', text, details: { from: before, to, by: HUMAN_ID } }); } catch { /* cosmetic */ }
}

/** Agents to stop in a chat: running there now (dispatcher), or still streaming a message. */
function runningIn(services: RuntimeServices, conversationId: string, agentId?: string): string[] {
  const out = new Set<string>();
  for (const item of services.dispatcher.activity()) {
    if (!item.split && item.conversationId === conversationId && (!agentId || item.agentId === agentId)) out.add(item.agentId); // B-057: a split's lane is stopped through its group
  }
  for (const message of services.chats.messages(conversationId, { limit: 30 })) {
    if (message.state === 'streaming' && message.authorKind === 'agent' && (!agentId || message.authorId === agentId)) out.add(message.authorId);
  }
  if (agentId) out.add(agentId);
  return [...out];
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- chats
  table.add('chats.list', (params, ctx) => {
    const o = input(params);
    return ctx.services.chats.list({ includeHidden: optBool(o, 'includeHidden'), search: optText(o, 'search', { max: 200, allowEmpty: true }) });
  }, CHAT);
  table.add('chats.get', (params, ctx) => ctx.services.chats.summary(id(input(params))), CHAT);
  table.add('chats.create', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['title', 'agentIds', 'spaceId', 'firstMessage', 'people']);
    const { chats } = ctx.services;
    const conversation = chats.create({
      title: optText(o, 'title', { max: 120, allowEmpty: true }), agentIds: ids(o, 'agentIds', 50), spaceId: optId(o, 'spaceId'), createdBy: HUMAN_ID,
      people: optIds(o, 'people', 50), // F-52: people of the organisation (chat/create.ts checks each)
    });
    const first = optText(o, 'firstMessage', { max: MAX_BODY, allowEmpty: true, multiline: true });
    if (first?.trim()) chats.send({ conversationId: conversation.id, body: first, authorId: HUMAN_ID, authorKind: 'human' });
    rememberConversation(ctx.services, conversation.id);
    return chats.get(conversation.id) ?? conversation;
  }, CHAT);
  table.add('chats.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'title', 'pinned', 'settings']);
    const settings = settingsOf(o.settings);
    checkDeviceSettings(ctx, settings);
    // An unknown mode key would switch to nothing and still post "Switched to … mode".
    if (settings?.mode !== undefined) {
      try { ctx.services.modes.get(settings.mode); } catch { bad('settings.mode', 'a known mode key (modes.list)'); }
    }
    const conversationId = id(o);
    const modeBefore = settings && 'mode' in settings ? chatOrThrow(ctx.services, conversationId).settings.mode : undefined;
    if (settings && 'parentId' in settings) { // B-078: checked and written by chat/children.ts, never as a plain setting
      setParent(ctx.services, conversationId, settings.parentId ?? null, HUMAN_ID);
      delete settings.parentId;
    }
    const updated = ctx.services.chats.update(conversationId, { title: optText(o, 'title', { max: 120 }), pinned: optBool(o, 'pinned'), settings }, HUMAN_ID);
    if (settings && 'mode' in settings) modeSwitched(ctx.services, updated, modeBefore);
    return updated;
  }, CHAT);
  table.add('chats.thread', (params, ctx) => { // B-078: the thread on a message (found, or opened with its chat's members)
    const o = input(params);
    onlyKeys(o, ['messageId']);
    return openThread(ctx.services, id(o, 'messageId'), HUMAN_ID);
  }, CHAT);
  table.add('chats.members', (params, ctx) => {
    const o = input(params);
    const change = { add: optIds(o, 'add', 50), remove: optMemberIds(o, 'remove', 50), lead: optId(o, 'lead') };
    return ctx.services.chats.setMembers(id(o), change, HUMAN_ID);
  }, CHAT);
  table.add('chats.archive', (params, ctx) => {
    const conversationId = id(input(params));
    ctx.services.chats.archive(conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.unarchive', (params, ctx) => { // C2
    const conversationId = id(input(params));
    ctx.services.chats.unarchive(conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.delete', (params, ctx) => {
    const conversationId = id(input(params));
    ctx.services.chats.remove(conversationId);
    return { ok: true };
  });
  table.add('chats.markRead', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o);
    chatOrThrow(ctx.services, conversationId);
    ctx.services.chats.markRead(conversationId, HUMAN_ID, num(o, 'seq', { min: 0 }));
    rememberConversation(ctx.services, conversationId);
    return { ok: true };
  }, CHAT);
  table.add('chats.search', (params, ctx) => {
    const o = input(params);
    const query = text(o, 'text', { max: 200 });
    const conversationId = optId(o, 'conversationId');
    const titles = new Map<string, string>();
    return ctx.services.chats.search(query, { conversationId, limit: optNum(o, 'limit', { min: 1, max: 100 }) ?? 30 })
      .map(({ message, snippet }) => {
      if (!titles.has(message.conversationId)) titles.set(message.conversationId, chatTitleFor(ctx.services, message.conversationId, HUMAN_ID)); // K2: as the owner sees it
      return { message, conversationTitle: titles.get(message.conversationId)!, snippet };
    });
  }, CHAT);

  // ---------------------------------------------------------------- messages
  table.add('messages.list', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    return ctx.services.chats.messages(conversationId, {
      beforeSeq: optNum(o, 'beforeSeq', { min: 0 }), limit: optNum(o, 'limit', { min: 1, max: 200 }) ?? 60,
    });
  }, CHAT);
  table.add('messages.send', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'attachments', 'mentions', 'priority', 'silent', 'replyTo', 'model', 'effort', 'pin', 'clientId', 'speech', 'secrets', 'ultra']);
    const conversationId = id(o, 'conversationId');
    const chat = chatOrThrow(ctx.services, conversationId);
    const body = text(o, 'body', { max: MAX_BODY, allowEmpty: true, multiline: true });
    const attachments = attachmentsOf(ctx.services, o.attachments);
    const secrets = attachedSecrets(ctx.services, conversationId, o.secrets);
    if (!body.trim() && !attachments.length && !secrets.length) bad('body', 'text or an attachment');
    const level = levelOf(o);
    const model = modelOf(o);
    const pin = optBool(o, 'pin');
    if (pin && model === undefined) bad('pin', 'pin: true only together with a model');
    const ultra = optBool(o, 'ultra'); // B-057 (owner 30.10.2026): Ultra suggested for this one message – a hint, the agent decides
    const mentions = optMemberIds(o, 'mentions', 50);
    // A line said live belongs to this device's call in the chat (the one speech.call names, else the open one, else a new
    // one – calls/call-log.ts). A plain one the call talker answers (calls/talker.ts), stored quiet until it passes it on.
    const speech = o.speech as { live?: unknown; call?: unknown } | undefined;
    const device = speech?.live === true && (ctx.scope.kind === 'owner' || ctx.scope.kind === 'device') ? callDevice(ctx) : undefined;
    const log = device ? callLogOf(ctx.services) : undefined;
    const callId = device && log ? log.start(conversationId, device, ctx.signal, typeof speech?.call === 'string' ? speech.call : undefined) : undefined;
    const talker = callId && body.trim() && !attachments.length && !secrets.length && !mentions?.length && !Object.keys(level).length && model === undefined && !ultra ? talkerOf(ctx.services) : undefined;
    const talks = talker?.serves(conversationId) ? talker : undefined;
    const message = ctx.services.chats.send({
      conversationId, body, attachments, mentions, ...level, ...(talks ? { silent: true } : {}),
      replyTo: optId(o, 'replyTo'), model, effort: optOneOf(o, 'effort', [...EFFORTS, 'auto']), ...(pin ? { pin } : {}),
      clientId: optText(o, 'clientId', { max: 100 }), authorId: HUMAN_ID, authorKind: 'human',
      speech: o.speech as SendMessageInput['speech'], // SM8: validated and capped by the chat service (chat/speech-meta.ts)
      meta: { ...(secrets.length ? { secrets } : {}), ...(ultra ? { ultra: true as const } : {}), ...(callId && device ? { call: { id: callId, participant: `device:${device.key}`, name: device.name } } : {}) },
    });
    talks?.heard(message);
    // Writing joins the room (chat service); a room an agent hid moves to the main list too (C1).
    if (chat.settings.hiddenFromList && !chat.settings.system) ctx.services.chats.update(conversationId, { settings: { hiddenFromList: undefined } }, HUMAN_ID);
    rememberConversation(ctx.services, conversationId);
    return message;
  }, CHAT);
  table.add('messages.edit', (params, ctx) => {
    const o = input(params);
    const messageId = id(o);
    const body = text(o, 'body', { max: MAX_BODY, multiline: true });
    checkDeviceMessage(ctx, messageId);
    return ctx.services.chats.edit(messageId, body, HUMAN_ID);
  }, CHAT);
  table.add('messages.delete', (params, ctx) => {
    const messageId = id(input(params));
    checkDeviceMessage(ctx, messageId);
    ctx.services.chats.removeMessage(messageId, HUMAN_ID);
    return { ok: true };
  }, CHAT);
  table.add('messages.stop', async (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    const only = optId(o, 'agentId');
    const agents = runningIn(ctx.services, conversationId, only);
    await Promise.all(agents.map((agentId) => ctx.services.dispatcher.interrupt(agentId, conversationId)));
    // B-057 S13: the person's Stop also ends the splits of this chat – of an agent whose only work here is splits, too.
    // Only here: dispatcher.interrupt never stops splits (a task's end or take-back must not end unrelated groups).
    try { ctx.services.splits?.stop({ conversationId, ...(only ? { agentId: only } : {}) }, HUMAN_ID); } catch (error) {
      ctx.services.log.warn('stopping the splits of a chat failed', { conversationId, error: String(error) });
    }
    return { ok: true };
  }, CHAT);
  table.add('messages.retry', (params, ctx) => {
    const messageId = id(input(params), 'messageId');
    const { chats, org, wakes } = ctx.services;
    const message = chats.message(messageId) ?? notFound('Message', { messageId });
    if (message.authorKind !== 'agent') bad('messageId', 'an answer written by an agent');
    if (message.state !== 'failed' && message.state !== 'stopped') {
      throw new WorkforceError('conflict', 'Only failed or stopped answers can be retried.', { details: { messageId, state: message.state } });
    }
    const agent = org.get(message.authorId);
    if (!agent || agent.archivedAt !== undefined) throw new WorkforceError('conflict', 'This agent is archived.', { details: { agentId: message.authorId } });
    if (!chats.members(message.conversationId).some((member) => member.memberId === agent.id)) {
      throw new WorkforceError('conflict', 'This agent is no longer in the chat.', { details: { agentId: agent.id } });
    }
    const why = message.state === 'failed' ? `failed${message.meta.error ? ` (${excerpt(String(message.meta.error), 160)})` : ''}` : 'was stopped';
    // A turn the human asked for ('manual'): on the stopped run's task it continues that task (a pause ends).
    const taskId = message.taskId ?? (message.runId ? ctx.services.runs.get(message.runId)?.taskId : undefined);
    wakes.wake({
      agentId: agent.id, reason: 'manual', conversationId: message.conversationId, taskId,
      note: `The human asked me to try again: my answer ${why}. I continue from where it ended.`, coalesceKey: `retry:${messageId}`,
    });
    return { ok: true };
  }, CHAT);
  table.add('messages.schedule', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'spec', 'mentions', 'priority', 'asTask', 'ultra']);
    const conversationId = id(o, 'conversationId');
    chatOrThrow(ctx.services, conversationId);
    const body = text(o, 'body', { max: MAX_BODY, multiline: true });
    const mentions = optIds(o, 'mentions', 50);
    const spec = optObj(o, 'spec') ?? bad('spec', 'a schedule spec ({at} | {cron} | {everyMs} | {times})');
    const asTask = optBool(o, 'asTask') === true; // T11: team work each time – needs 'tasks' like tasks.create
    if (asTask && !scopeHas(ctx.scope, 'tasks')) throw new WorkforceError('forbidden', 'Posting tasks is not allowed on this device.', { details: { param: 'asTask' } });
    const post = scheduledPost(body, { mentions, priority: optOneOf(o, 'priority', POST_PRIORITIES), asTask, ultra: optBool(o, 'ultra') === true }); // B-050 K4: 'silent' too; B-057: Ultra suggested
    // The scheduler validates the spec (times, cron syntax, limits).
    return ctx.services.scheduler.create({ ownerId: HUMAN_ID, conversationId, spec: spec as ScheduleSpec, ...post });
  }, CHAT);

  registerExternalAgents(table); // C8: chats.connectExternal ('manage', secure) and the external agents' variants
  registerBlocks(table);
}
