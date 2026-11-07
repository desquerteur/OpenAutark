// AF-016 – a chat's prompt queue (owner 07.11.2026, "wie bei Codex"): messages the person lined up while an agent works.
// The runtime keeps it per chat in its database (it survives a restart) and sends the top one as the person's next message
// once the chat's work has ended; it pauses by itself on an error, when an agent asked the person something, and on the
// person's Stop – until they resume it. Pure helpers here are the queue's order rules (runtime and UI both use them).
// Owns: these shapes, the limits, the queue.updated event and the pure order helpers. Never: behaviour (runtime/prompt-queue).

import type { Attachment } from './chat.ts';

/** Why a queue waits for the person: their Pause, a failed turn, an agent's question, their Stop. */
export type QueuePause = 'manual' | 'error' | 'ask' | 'stop';

/** One lined-up message: what messages.send would send, kept until it goes out. */
export interface QueuedPrompt {
  id: string;
  body: string;
  attachments: Attachment[];
  /** Secret handles attached in the composer's secret mode (never a value). */
  secrets?: string[];
  priority?: 'important';
  silent?: boolean;
  mentions?: string[];
  replyTo?: string;
  ultra?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PromptQueue {
  conversationId: string;
  /** Top first: the next one to go out. */
  items: QueuedPrompt[];
  /** Set while the queue waits for the person's Resume (only on a queue with items). */
  paused?: { reason: QueuePause; at: number; note?: string };
  /** When the queue last sent its top prompt (the next waits until that work has ended). */
  sentAt?: number;
  updatedAt: number;
}

export const QUEUE_LIMITS = { items: 50, body: 100_000 } as const;

/** The empty queue of a chat. */
export function emptyQueue(conversationId: string, at = 0): PromptQueue {
  return { conversationId, items: [], updatedAt: at };
}

/** The items with `id` moved to `index` (clamped); unchanged for an unknown id. */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, index: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return [...items];
  const rest = items.filter((item) => item.id !== id);
  const to = Math.max(0, Math.min(rest.length, Math.floor(index)));
  return [...rest.slice(0, to), items[from], ...rest.slice(to)];
}

/** One line of a prompt for the list (first line, whitespace folded, `max` characters). */
export function promptPreview(body: string, max = 140): string {
  const line = body.trim().split('\n').find((part) => part.trim()) ?? '';
  const folded = line.replace(/\s+/g, ' ').trim();
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

/** What sending does while an agent works in the chat (settings.json preferences.whileWorking; Ctrl+Enter does the other). */
export type SendWhileWorking = 'now' | 'queue';

declare module './system.ts' {
  interface Preferences {
    /** AF-016: 'now' (default) – a message reaches the running agent at once; 'queue' – it waits in the chat's queue. */
    whileWorking?: SendWhileWorking;
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** AF-016: a chat's prompt queue changed (topic chat:<id>) – the whole queue, it is small. */
    'queue.updated': PromptQueue;
  }
}
