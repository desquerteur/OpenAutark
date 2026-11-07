// RPC contract part (AF-016): a chat's prompt queue (shared/model/prompt-queue.ts) – line a message up, edit, remove,
// reorder, send one now, pause and resume. Handlers: runtime/rpc/handlers/prompt-queue.ts ('chat' like messages.send).
// Every write answers with the whole queue (it is small) and emits queue.updated. Merged into Methods by module
// augmentation (methods.ts is at its size limit). Owns: these method shapes. Never: behaviour.

import type { Attachment, Message } from '../model/chat.ts';
import type { PromptQueue } from '../model/prompt-queue.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** The chat's queue (empty when nothing is lined up). */
    'queue.get': { params: { conversationId: string }; result: PromptQueue };
    /** Lines a message up at the end – the fields of messages.send; it goes out by itself once the chat's work has ended. */
    'queue.add': { params: { conversationId: string; body: string; attachments?: Attachment[]; secrets?: string[]; mentions?: string[]; priority?: 'normal' | 'important'; silent?: boolean; replyTo?: string; ultra?: boolean }; result: PromptQueue };
    /** Edits a lined-up message's text (and, when given, its files). */
    'queue.update': { params: { conversationId: string; id: string; body: string; attachments?: Attachment[] }; result: PromptQueue };
    /** Removes a lined-up message. */
    'queue.remove': { params: { conversationId: string; id: string }; result: PromptQueue };
    /** Moves a lined-up message to `index` (0 = next). */
    'queue.move': { params: { conversationId: string; id: string; index: number }; result: PromptQueue };
    /** Sends one lined-up message now (as messages.send would – it reaches a running agent) and takes it off the queue. */
    'queue.sendNow': { params: { conversationId: string; id: string }; result: { queue: PromptQueue; message: Message } };
    /** The person's Pause: nothing goes out until queue.resume. */
    'queue.pause': { params: { conversationId: string }; result: PromptQueue };
    /** Resume after a pause (the person's, an error's, a question's or a Stop's): the top one goes out once the chat is free. */
    'queue.resume': { params: { conversationId: string }; result: PromptQueue };
  }
}

export {};
