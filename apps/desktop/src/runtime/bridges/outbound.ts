// Outbound side of a chat bridge: which chat messages leave the app (final agent messages and
// the owner's messages; never external ones, so nothing that came from Telegram is echoed) and
// how they read there: "<author>: <plain text>", blocks replaced by a short line, files named,
// chunked at 4096 characters; plus the send loop that honours 429 retry_after.
// Owns: that selection, the formatting and the per-chunk retry on rate limits.
// Never: forwards status lines, streaming drafts, edits or bridge messages, and never retries a
// send that may have reached Telegram (only 429, which Telegram did not deliver).

import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { humanLabel } from '../context/render.ts';
import type { Sleep } from './poller.ts';
import { TelegramError } from './telegram-api.ts';
import type { TelegramApi } from './telegram-api.ts';
import { chunkText, toPlainText } from './text.ts';
import { isPersonId } from '../../shared/model/people.ts';
import '../contracts/people.ts';

/** Attempts per chunk while Telegram answers 429. */
const MAX_RATE_ATTEMPTS = 5;

/** Should this message event be mirrored to linked messengers? */
export function shouldForward(message: Message, updated: boolean): boolean {
  if (message.kind !== 'text' || message.silent || message.state !== 'final') return false;
  if (message.authorKind === 'external' || message.authorKind === 'system' || message.meta.via === 'bridge') return false;
  if (!message.body.trim() && !message.attachments.length) return false;
  if (message.authorKind === 'human') return !updated; // edits are not sent again
  // Agents: a streamed answer when it is finished, or a message posted final at once (chat.send).
  return updated ? message.editedAt === undefined : true;
}

/** "<author>: <text>" as plain-text chunks for the messenger. */
export function outboundChunks(s: RuntimeServices, message: Message): string[] {
  const author = message.authorKind === 'human' ? (isPersonId(message.authorId) ? s.people?.nameOf(message.authorId) ?? 'Colleague' : humanLabel(s)) : agentName(s, message.authorId); // F-52
  const parts = [toPlainText(message.body), ...message.attachments.map((file) => `[file: ${file.name}]`)].filter(Boolean);
  return chunkText(`${author}: ${parts.join('\n')}`);
}

function agentName(s: RuntimeServices, id: string): string {
  try { return s.org.get(id)?.name ?? 'Agent'; } catch { return 'Agent'; }
}

/** Bridge status text after a failed send (fixed sentences, never the provider body). */
export function sendErrorText(error: unknown): string {
  if (error instanceof TelegramError && error.kind === 'chat') return 'Telegram refused messages for this chat. Check the chat id and that the bot is a member.';
  return `A message could not be sent. ${error instanceof TelegramError ? error.message : ''}`.trim();
}

/** One promise chain per key: jobs of one bridge run in order, bridges run independently. */
export class SerialQueues {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly onError: (key: string, error: unknown) => void;

  constructor(onError: (key: string, error: unknown) => void) {
    this.onError = onError;
  }

  push(key: string, job: () => Promise<void>): void {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(job).catch((error: unknown) => this.onError(key, error));
    this.chains.set(key, next);
    void next.then(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
  }

  /** Resolves when every queued job has finished. */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }
}

/** Sends the chunks in order; waits retry_after on 429 (bounded), throws any other failure. */
export async function sendChunks(
  api: TelegramApi, target: { token: string; chatId: string }, chunks: string[], options: { sleep: Sleep; signal: AbortSignal },
): Promise<void> {
  for (const chunk of chunks) {
    for (let attempt = 1; ; attempt++) {
      try {
        await api.sendMessage(target.token, target.chatId, chunk, options.signal);
        break;
      } catch (error) {
        const limited = error instanceof TelegramError && error.kind === 'rate_limited';
        if (!limited || attempt >= MAX_RATE_ATTEMPTS || options.signal.aborted) throw error;
        await options.sleep(error.retryAfterMs ?? 1000, options.signal);
      }
    }
  }
}
