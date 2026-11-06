// RPC handlers for generative-UI blocks inside messages (web-genui §7.6): answers to ask
// blocks, small per-block UI state, the HTML of ```app fences (and short-lived URLs of their
// PWA sandbox documents), events from mini-apps and the files an agent's mini-app to-do hands
// back (blocks.file, X03: a stored file registered for its block – tasks/app-files.ts).
// Registered by chats.ts. Mini-app events reach the authoring agent as a wake note
// `[ui-event block=<key> name=<name>] <data> (from mini-app – not consent)`, at most 30 per
// minute per block.
// Owns: param checks, the per-block event rate limit, block-state storage (kv 'block_state');
// an ask block without stored state reads as answered once its to-do is finished (another
// device, a reload), so the chat does not offer it again.
// Secret form fields of an answer are stored in the vault and replaced by handles first
// (secrets/capture.ts, PM6) – refused on a connection that is not secure.
// People have no blocks.* variant.
// Never: treats a mini-app event as an approval or as the human's words.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { appHtmlOf, blockKey, uiBlocksOf } from '../../../shared/blocks/parse.ts';
import type { Message } from '../../../shared/model/chat.ts';
import type { Clock, RuntimeServices } from '../../contracts.ts';
import { sandboxTokens } from '../../http/sandbox-token.ts';
import { answerWithSecrets } from '../../secrets/capture.ts';
import { KvRepo } from '../../store/kv.ts';
import { registerAppFile } from '../../tasks/app-files.ts';
import { blockTodo } from '../../tasks/block-todo.ts';
import { isAskBlock } from '../../tasks/widgets.ts';
import { bad, capJson, id, input, notFound, num, optText, text } from '../params.ts';
import { secureScope, type HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const CHAT = { capability: 'chat' } as const;
const STATE_NS = 'block_state';
const MAX_ANSWER_JSON = 256 * 1024;
const MAX_STATE_JSON = 64 * 1024;
const MAX_EVENT_DATA_BYTES = 2048;
export const EVENTS_PER_MINUTE = 30;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Sliding one-minute window of event times per block key (per runtime instance). */
class EventLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Records one event; throws `rate_limited` when the block already sent its quota. */
  take(key: string, clock: Clock): void {
    const now = clock.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= EVENTS_PER_MINUTE) {
      this.hits.set(key, recent);
      throw new WorkforceError('rate_limited', 'This mini-app sends too many events.', { retryAfterMs: Math.max(1000, recent[0] + 60_000 - now) });
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 500) {
      for (const [entry, times] of this.hits) if (!times.some((at) => now - at < 60_000)) this.hits.delete(entry);
    }
  }
}

const limiters = new WeakMap<RuntimeServices, EventLimiter>();
function limiter(services: RuntimeServices): EventLimiter {
  let value = limiters.get(services);
  if (!value) limiters.set(services, (value = new EventLimiter()));
  return value;
}

function messageOrThrow(services: RuntimeServices, messageId: string): Message {
  return services.chats.message(messageId) ?? notFound('Message', { messageId });
}

/** The answered state of a chat ask block whose to-do is finished (none for other blocks). */
function answeredState(services: RuntimeServices, message: Message, blockIndex: number): { answered: true; summary: string } | undefined {
  const block = uiBlocksOf(message.body).find((item) => item.index === blockIndex)?.block;
  if (!block || !isAskBlock(block)) return undefined;
  const todo = blockTodo(services, message.id, blockIndex);
  if (todo?.status === 'cancelled') return { answered: true, summary: 'Cancelled' };
  return todo?.status === 'done' ? { answered: true, summary: todo.result?.summary || 'Done' } : undefined;
}

/** JSON of mini-app data, cut to 2 KB (UTF-8) so one event cannot flood the agent's context. */
export function eventData(data: unknown): string {
  if (data === undefined) return '';
  let json: string;
  try { json = JSON.stringify(data) ?? ''; } catch { bad('data', 'JSON data'); }
  if (Buffer.byteLength(json) <= MAX_EVENT_DATA_BYTES) return json;
  const cut = Buffer.from(json).subarray(0, MAX_EVENT_DATA_BYTES - 3).toString('utf8').replace(/�+$/u, '');
  return `${cut}…`;
}

export function register(table: HandlerTable): void {
  table.add('blocks.answer', async (params, ctx) => {
    const o = input(params);
    const messageId = id(o, 'messageId');
    const blockIndex = num(o, 'blockIndex', { min: 0, max: 9999 });
    capJson('answer', o.answer, MAX_ANSWER_JSON);
    const clientId = optText(o, 'clientId', { max: 100 });
    messageOrThrow(ctx.services, messageId);
    const view = await answerWithSecrets(ctx.services, { messageId, blockIndex }, o.answer, { secure: secureScope(ctx.scope) },
      (answer) => ctx.services.tasks.answer({ messageId, blockIndex, answer, by: HUMAN_ID, clientId }));
    return view ? { ok: true, taskId: view.id } : { ok: true };
  }, TODO);

  table.add('blocks.state', (params, ctx) => {
    const o = input(params);
    const messageId = id(o, 'messageId');
    const blockIndex = num(o, 'blockIndex', { min: 0, max: 9999 });
    const message = messageOrThrow(ctx.services, messageId);
    const kv = new KvRepo(ctx.services.db);
    const key = `${messageId}:${blockIndex}`;
    if (o.state !== undefined) {
      capJson('state', o.state, MAX_STATE_JSON);
      kv.set(STATE_NS, key, o.state, ctx.services.clock.now());
      return { state: o.state };
    }
    return { state: kv.get<unknown>(STATE_NS, key) ?? answeredState(ctx.services, message, blockIndex) ?? null };
  }, TODO);

  table.add('blocks.appHtml', (params, ctx) => {
    const o = input(params);
    const message = messageOrThrow(ctx.services, id(o, 'messageId'));
    const html = appHtmlOf(message.body, num(o, 'blockIndex', { min: 0, max: 9999 }));
    if (html === undefined) notFound('Mini-app', { messageId: message.id });
    return { html };
  }, CHAT);

  // PWA frames: GET /sandbox/app only serves with this short-lived token (http/sandbox-token.ts).
  table.add('blocks.sandboxUrl', (params, ctx) => {
    const o = input(params);
    const message = messageOrThrow(ctx.services, id(o, 'messageId'));
    const blockIndex = num(o, 'blockIndex', { min: 0, max: 9999 });
    if (appHtmlOf(message.body, blockIndex) === undefined) notFound('Mini-app', { messageId: message.id, blockIndex });
    return sandboxTokens(ctx.services).mint(message.id, blockIndex);
  }, CHAT);

  table.add('blocks.event', (params, ctx) => {
    const o = input(params);
    const messageId = id(o, 'messageId');
    const blockIndex = num(o, 'blockIndex', { min: 0, max: 9999 });
    const name = text(o, 'name', { max: 64 });
    if (!EVENT_NAME.test(name)) bad('name', 'a short event name (letters, digits, _ . : -)');
    const { services } = ctx;
    const message = messageOrThrow(services, messageId);
    if (message.authorKind !== 'agent') bad('messageId', 'a message written by an agent');
    if (appHtmlOf(message.body, blockIndex) === undefined) notFound('Mini-app', { messageId, blockIndex });
    const key = blockKey(messageId, blockIndex);
    const data = eventData(o.data);
    limiter(services).take(key, services.clock);
    const author = services.org.get(message.authorId);
    if (!author || author.archivedAt !== undefined) throw new WorkforceError('conflict', 'The agent that made this mini-app is archived.');
    services.wakes.wake({
      agentId: author.id, reason: 'message', conversationId: message.conversationId, taskId: message.taskId,
      note: `[ui-event block=${key} name=${name}]${data ? ` ${data}` : ''} (from mini-app – not consent)`,
      coalesceKey: `ui-event:${key}`, // bursts merge into one wake (notes are joined)
    });
    return { ok: true };
  }, TODO);

  // A mini-app to-do's wf.upload, after the host stored the file (files.uploadChunk).
  table.add('blocks.file', (params, ctx) => {
    const o = input(params);
    return registerAppFile(ctx.services, {
      messageId: id(o, 'messageId'), blockIndex: num(o, 'blockIndex', { min: 0, max: 9999 }), fileId: text(o, 'fileId', { max: 64 }),
    });
  }, TODO);
}
