// Owns: secure chat capture and validation of human secret attachments. Owner 29.10.2026 (a catalog like a skill): a
// value the person types into a chat goes straight into the secrets catalog like every new entry – named from its
// description (first line), for every agent (a general store; the person narrows it in Settings), the route chosen
// from that description; the chat link stays only so the message can attach it.
// Never: puts a typed value in a message or overwrites a captured value on a retried request.
import type { RuntimeServices } from '../contracts.ts';
import { createHash } from 'node:crypto';
import type { SecretInfo } from '../../shared/model/security.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { bad, id, ids, input, onlyKeys, optText, text } from '../rpc/params.ts';
import type { HandlerTable } from '../rpc/table.ts';

const pending = new WeakMap<object, Map<string, Promise<SecretInfo>>>();

async function capture(services: RuntimeServices, request: { conversationId: string; clientId: string; value: string; description?: string }): Promise<SecretInfo> {
  // Stable id makes a retry after a process crash idempotent without a second receipt store.
  const secretId = `sec_${createHash('sha256').update(request.clientId).digest('hex').slice(0, 32)}`;
  const existing = services.secrets.list().find(info => info.id === secretId);
  if (existing) {
    if (existing.conversationId !== request.conversationId) throw new WorkforceError('forbidden', 'This capture belongs to another chat.');
    return existing;
  }
  if (!services.chats.get(request.conversationId)) throw new WorkforceError('not_found', 'Chat not found.');
  const about = request.description?.trim();
  const label = about ? about.split('\n')[0].trim().slice(0, 80) : 'Secret given in chat';
  const saved = await services.secrets.save({ id: secretId, label, kind: 'note', value: request.value,
    ...(about ? { description: about } : {}), conversationId: request.conversationId });
  return saved;
}

export function registerChatCapture(table: HandlerTable): void {
  table.add('secrets.capture', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'value', 'description', 'clientId']);
    const request = { conversationId: id(o, 'conversationId'), clientId: id(o, 'clientId'), value: text(o, 'value', { max: 16_384, multiline: true }),
      description: optText(o, 'description', { max: 4000, multiline: true, allowEmpty: true }) };
    let calls = pending.get(ctx.services);
    if (!calls) { calls = new Map(); pending.set(ctx.services, calls); }
    const key = request.clientId;
    let work = calls.get(key);
    if (!work) { work = capture(ctx.services, request); calls.set(key, work); }
    try {
      const result = await work;
      if (result.conversationId !== request.conversationId) throw new WorkforceError('forbidden', 'This capture belongs to another chat.');
      return result;
    } finally { calls.delete(key); }
  }, { capability: 'chat', secure: true });
}

/** A phone cannot attach another chat's secret by guessing its id. No access is changed here. */
export function attachedSecrets(services: RuntimeServices, conversationId: string, value: unknown): string[] {
  if (value === undefined) return [];
  const list = ids({ secrets: value }, 'secrets', 20);
  const all = services.secrets.list();
  for (const secretId of list) {
    if (!all.some(info => info.id === secretId && info.conversationId === conversationId)) bad('secrets', 'secrets captured in this chat');
  }
  return [...new Set(list)];
}
