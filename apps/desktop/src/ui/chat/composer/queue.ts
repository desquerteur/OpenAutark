// AF-016 – the composer's side of a chat's prompt queue (the runtime keeps it: runtime/prompt-queue). One signal per chat,
// loaded with queue.get when its composer opens and on every reconnect, then kept by queue.updated; the calls answer with
// the whole queue. How a message goes out while an agent works (`sendMode`): the person's default
// (preferences.whileWorking: 'now' – it reaches the running agent at once, the way it always did – or 'queue'), Ctrl+Enter
// (Ctrl+Shift+Enter when Enter does not send) the other one. With nothing at work and nothing queued, a message always goes now.
// Lining up the draft takes all of it – text, files, secret handles, level, reply, Ultra – and empties the composer like Send.
// Owns: these signals, calls, the send-mode rule and the list's pure helpers (pause line, drop place). Never: when a queued prompt goes out (the runtime decides).

import { signal, type Signal } from '@preact/signals';
import { emptyQueue, type PromptQueue, type QueuePause, type SendWhileWorking } from '../../../shared/model/prompt-queue.ts';
import '../../../shared/api/methods-prompt-queue.ts'; // the queue.* method shapes (module augmentation)
import { rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';
import { preferences, updatePreferences } from '../../lib/store.ts';
import { clearDraft, draftFor, updateDraft } from './draft.ts';
import { takeDraftSpeech } from './draft-speech.ts';

const queues = new Map<string, Signal<PromptQueue>>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  rpc.on('queue.updated', (queue) => { queueFor(queue.conversationId).value = queue; });
  rpc.onOpen(() => { for (const id of queues.keys()) void loadQueue(id); }); // a reconnect may have missed changes
}

/** The chat's queue (empty until loaded). */
export function queueFor(conversationId: string): Signal<PromptQueue> {
  let entry = queues.get(conversationId);
  if (!entry) queues.set(conversationId, (entry = signal(emptyQueue(conversationId))));
  return entry;
}

export async function loadQueue(conversationId: string): Promise<void> {
  listen();
  try { queueFor(conversationId).value = await rpc.call('queue.get', { conversationId }); } catch { /* an older runtime: no queue */ }
}

/** What a send does now: the default while something works or waits in the queue, the other one with `other`; else now. */
export function sendMode(input: { busy: boolean; queued: number; other: boolean; preferred?: SendWhileWorking }): SendWhileWorking {
  if (!input.busy && !input.queued) return 'now';
  const preferred = input.preferred ?? 'now';
  return input.other ? (preferred === 'now' ? 'queue' : 'now') : preferred;
}

export function preferredMode(): SendWhileWorking { return preferences.value.whileWorking ?? 'now'; }
export function setPreferredMode(whileWorking: SendWhileWorking): Promise<void> {
  return updatePreferences({ whileWorking }).catch((error) => toastError(error, 'Could not save the setting'));
}

/** Lines the whole draft up (text or `body`); false when it failed (the draft is back, a notice says why). */
export async function queueDraft(conversationId: string, body: string, mentions: (body: string) => string[]): Promise<boolean> {
  const saved = draftFor(conversationId).peek();
  const spoken = takeDraftSpeech(conversationId);
  clearDraft(conversationId);
  const text = body.trim();
  try {
    queueFor(conversationId).value = await rpc.call('queue.add', {
      conversationId, body: text,
      ...(saved.attachments.length ? { attachments: saved.attachments } : {}), ...(saved.secrets?.length ? { secrets: saved.secrets } : {}),
      mentions: mentions(text), ...(saved.level === 'important' ? { priority: 'important' as const } : {}), ...(saved.level === 'silent' ? { silent: true } : {}),
      ...(saved.replyTo ? { replyTo: saved.replyTo } : {}), ...(saved.ultra ? { ultra: true } : {}),
    });
    return true;
  } catch (error) {
    toastError(error, 'Not added to the queue');
    updateDraft(conversationId, saved);
    spoken.restore();
    return false;
  }
}

type Call = 'queue.update' | 'queue.remove' | 'queue.move' | 'queue.pause' | 'queue.resume';

/** One queue call; the answer is the whole queue. */
export async function queueCall(method: Call, params: { conversationId: string } & Record<string, unknown>, failed: string): Promise<boolean> {
  try {
    queueFor(params.conversationId).value = await rpc.call(method, params as never) as PromptQueue;
    return true;
  } catch (error) { toastError(error, failed); return false; }
}

export async function sendQueuedNow(conversationId: string, id: string): Promise<void> {
  try { queueFor(conversationId).value = (await rpc.call('queue.sendNow', { conversationId, id })).queue; } catch (error) { toastError(error, 'Message not sent'); }
}

const PAUSED: Record<QueuePause, string> = {
  manual: 'Paused',
  error: 'Paused after an error',
  ask: 'Paused – an agent asked you something',
  stop: 'Paused after Stop',
};

/** Why the queue waits, for its head line (undefined while it runs). */
export function pausedText(queue: Pick<PromptQueue, 'paused'>): string | undefined {
  return queue.paused ? PAUSED[queue.paused.reason] : undefined;
}

/** The place among the other rows a row dragged by `dy` lands on (`mids`: the rows' vertical centres at the start). */
export function dropIndex(mids: readonly number[], from: number, dy: number): number {
  const y = mids[from] + dy;
  return mids.filter((mid, index) => index !== from && mid < y).length;
}
