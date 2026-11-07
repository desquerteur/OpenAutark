// AF-016 the prompt queue as a member of RuntimeServices (merged by module augmentation, like the other late additions in
// this folder; imported where it is used). The service (runtime/prompt-queue/service.ts) keeps each chat's queue and
// sends its top prompt once the chat's work has ended.
// Owns: the PromptQueueService interface. Never: behaviour.

import type { Message } from '../../shared/model/chat.ts';
import type { PromptQueue, QueuePause, QueuedPrompt } from '../../shared/model/prompt-queue.ts';

/** What queue.add takes: the fields of a person's message, already checked. */
export type QueuedInput = Pick<QueuedPrompt, 'body' | 'attachments' | 'secrets' | 'priority' | 'silent' | 'mentions' | 'replyTo' | 'ultra'>;

export interface PromptQueueService {
  get(conversationId: string): PromptQueue;
  add(conversationId: string, input: QueuedInput): PromptQueue;
  update(conversationId: string, id: string, patch: Pick<QueuedPrompt, 'body'> & Partial<Pick<QueuedPrompt, 'attachments'>>): PromptQueue;
  remove(conversationId: string, id: string): PromptQueue;
  move(conversationId: string, id: string, index: number): PromptQueue;
  /** Sends one now (it reaches a running agent like any message) and takes it off the queue. */
  sendNow(conversationId: string, id: string): { queue: PromptQueue; message: Message };
  /** Holds a queue with items (no-op on an empty one). */
  pause(conversationId: string, reason: QueuePause, note?: string): PromptQueue;
  resume(conversationId: string): PromptQueue;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** AF-016 the chats' prompt queues; missing = not wired (fakes). */
    promptQueue?: PromptQueueService;
  }
}
