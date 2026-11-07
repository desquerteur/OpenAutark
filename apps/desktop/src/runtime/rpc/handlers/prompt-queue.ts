// queue.* (AF-016, shared/api/methods-prompt-queue.ts): a chat's prompt queue for the owner's window and phones – 'chat'
// methods like messages.send, for the owner and their devices only (the queue sends as the owner). queue.add checks
// what messages.send checks (text or a file, the files, the chat's secret handles, the level, mentions of members); an
// edit checks its text and files the same way. Without a queue service (fakes) every call fails as unavailable.
// Owns: these handlers and their parameter checks. Never: when a prompt goes out (services.promptQueue).

import { WorkforceError } from '../../../shared/errors.ts';
import '../../../shared/api/methods-prompt-queue.ts'; // the method shapes (module augmentation)
import { QUEUE_LIMITS } from '../../../shared/model/prompt-queue.ts';
import type { PromptQueueService } from '../../contracts/prompt-queue.ts';
import { attachedSecrets } from '../../secrets/chat-capture.ts';
import { bad, id, input, notFound, num, onlyKeys, optBool, optId, optMemberIds, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { attachmentsOf, levelOf } from './chats.ts';

const CHAT = { capability: 'chat' } as const;

/** The queue service, for the owner and their devices; the chat must exist. */
function queues(ctx: HandlerContext, conversationId: string): PromptQueueService {
  if (ctx.scope.kind !== 'owner' && ctx.scope.kind !== 'device') throw new WorkforceError('forbidden', 'Only the owner lines up messages.', { details: { scope: ctx.scope.kind } });
  if (!ctx.services.chats.get(conversationId)) notFound('Conversation', { conversationId });
  const service = ctx.services.promptQueue;
  if (!service) throw new WorkforceError('unavailable', 'The queue is not available.', { details: {} });
  return service;
}

export function register(table: HandlerTable): void {
  table.add('queue.get', (params, ctx) => {
    const conversationId = id(input(params), 'conversationId');
    return queues(ctx, conversationId).get(conversationId);
  }, CHAT);

  table.add('queue.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'attachments', 'secrets', 'mentions', 'priority', 'silent', 'replyTo', 'ultra']);
    const conversationId = id(o, 'conversationId');
    const service = queues(ctx, conversationId);
    const body = text(o, 'body', { max: QUEUE_LIMITS.body, allowEmpty: true, multiline: true });
    const attachments = attachmentsOf(ctx.services, o.attachments);
    const secrets = attachedSecrets(ctx.services, conversationId, o.secrets);
    if (!body.trim() && !attachments.length && !secrets.length) bad('body', 'text or an attachment');
    const level = levelOf(o);
    const mentions = optMemberIds(o, 'mentions', 50);
    const replyTo = optId(o, 'replyTo');
    return service.add(conversationId, {
      body: body.trim(), attachments, ...(secrets.length ? { secrets } : {}), ...(level.priority === 'important' ? { priority: 'important' as const } : {}),
      ...(level.silent ? { silent: true } : {}), ...(mentions?.length ? { mentions } : {}), ...(replyTo ? { replyTo } : {}),
      ...(optBool(o, 'ultra') ? { ultra: true } : {}),
    });
  }, CHAT);

  table.add('queue.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'id', 'body', 'attachments']);
    const conversationId = id(o, 'conversationId');
    const service = queues(ctx, conversationId);
    const body = text(o, 'body', { max: QUEUE_LIMITS.body, allowEmpty: true, multiline: true });
    return service.update(conversationId, id(o), { body: body.trim(), ...(o.attachments !== undefined ? { attachments: attachmentsOf(ctx.services, o.attachments) } : {}) });
  }, CHAT);

  table.add('queue.remove', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    return queues(ctx, conversationId).remove(conversationId, id(o));
  }, CHAT);

  table.add('queue.move', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    return queues(ctx, conversationId).move(conversationId, id(o), num(o, 'index', { min: 0, max: QUEUE_LIMITS.items, integer: true }));
  }, CHAT);

  table.add('queue.sendNow', (params, ctx) => {
    const o = input(params);
    const conversationId = id(o, 'conversationId');
    return queues(ctx, conversationId).sendNow(conversationId, id(o));
  }, CHAT);

  table.add('queue.pause', (params, ctx) => {
    const conversationId = id(input(params), 'conversationId');
    return queues(ctx, conversationId).pause(conversationId, 'manual');
  }, CHAT);

  table.add('queue.resume', (params, ctx) => {
    const conversationId = id(input(params), 'conversationId');
    return queues(ctx, conversationId).resume(conversationId);
  }, CHAT);
}
