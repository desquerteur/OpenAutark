// B-078 (live 06.11. 20:23: a dictation in Kernteam was never answered – the responder pick saw an empty body): a
// person's new text message that is only a recording, while speech to text is ready and the recording's bytes are on
// this PC (media/dictation.ts transcribes exactly those), is held back until its transcript arrives – the
// 'message.updated' that brings a body or meta.dictation (also { failed: true }: nothing was heard, dictation.ts) – or
// DICTATION_WAIT_MS passed; then it is delivered once.
// Event-driven: bus listeners and one timer per held message, no polling; one deleted while it waits wakes nobody. A quit while one is held loses nothing:
// recover() at the next start delivers the unanswered line (chat/delivery-recovery.ts).
// Owns: holding and releasing those messages. Never: transcribes, writes a message, or holds one twice.

import { existsSync } from 'node:fs';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { DeliveryDeps } from './delivery-route.ts';

/** How long a recording waits for its transcript before it is delivered as it is. */
export const DICTATION_WAIT_MS = 60_000;

export type DictationWaitDeps = DeliveryDeps & Partial<Pick<RuntimeServices, 'stt' | 'files'>>;

const isRecording = (mime: unknown) => typeof mime === 'string' && /^(audio|video)\//i.test(mime.split(';')[0].trim());

export class DictationWait {
  private readonly s: DictationWaitDeps;
  private readonly waitMs: number;
  private readonly release: (message: Message) => void;
  private readonly held = new Map<string, { message: Message; timer: ReturnType<typeof setTimeout> }>();
  private listening = false;

  constructor(deps: DictationWaitDeps, release: (message: Message) => void, waitMs = DICTATION_WAIT_MS) {
    this.s = deps;
    this.release = release;
    this.waitMs = waitMs;
  }

  /** True when the message is held now (its delivery comes later, once). */
  hold(message: Message): boolean {
    if (this.held.has(message.id)) return true;
    if (!this.awaitsTranscript(message) || !this.listen()) return false;
    const timer = setTimeout(() => this.done(message.id), this.waitMs);
    (timer as { unref?: () => void }).unref?.();
    this.held.set(message.id, { message, timer });
    return true;
  }

  /** Messages held right now (tests). */
  size(): number { return this.held.size; }

  private awaitsTranscript(message: Message): boolean {
    if (message.authorKind !== 'human' || message.kind !== 'text' || message.state !== 'final' || message.silent || message.body.trim()) return false;
    if (message.meta?.dictation) return false;
    const file = (message.attachments ?? []).find((attachment) => isRecording(attachment.mime));
    if (!file || !this.s.stt || !this.s.files) return false;
    try {
      return this.s.stt.state() === 'ready' && existsSync(this.s.files.path(file.fileId));
    } catch { return false; }
  }

  /** One listener for the whole service, added on first use. */
  private listen(): boolean {
    if (this.listening) return true;
    if (!this.s.bus) return false;
    this.s.bus.on('message.updated', (message) => {
      const entry = this.held.get(message.id);
      if (entry && (message.body.trim() || message.meta?.dictation)) this.done(message.id, message);
    });
    this.s.bus.on('message.removed', ({ id }) => this.drop(id)); // deleted while it waited: nobody is woken for it
    this.listening = true;
    return true;
  }

  /** Lets go of a held message without delivering it; returns what was held. */
  private drop(id: string): { message: Message } | undefined {
    const entry = this.held.get(id);
    if (!entry) return undefined;
    this.held.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  private done(id: string, updated?: Message): void {
    const entry = this.drop(id);
    if (!entry) return;
    try { this.release(updated ?? entry.message); } catch (error) {
      this.s.log?.warn('held dictation not delivered', { messageId: id, error: String(error) });
    }
  }
}
