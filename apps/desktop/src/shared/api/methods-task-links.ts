// RPC contract part: "Share to chat…" – a live reference (a kind 'task' message) of a task posted by the person into a
// chat (B-054 – a task is its own row; a chat is only where it is handed over or shown; handler rpc/handlers/task-links.ts).
// Merged into Methods by module augmentation (methods.ts is at its size limit).
// Owns: this method shape. Never: behaviour.

import type { Message } from '../model/chat.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Posts a live reference of the task into a chat (never for an "Only me" task; reach-checked like an agent's chat.send {taskId}). */
    'tasks.share': { params: { id: string; conversationId: string; clientId?: string }; result: Message };
  }
}
