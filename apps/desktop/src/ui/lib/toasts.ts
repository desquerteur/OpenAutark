// Quiet in-window toasts (attention items and action errors). Max 3 at once (the oldest goes first); they expire,
// except one pushed with ttl 0 – a to-do, a blocker or an important message – which stays until Open or Dismiss,
// or until the person reaches where Open leads or the to-do is finished another way (lib/store-events.ts).
// They show as lines of the status line (shell/StatusLine.tsx).
// Owns: the toast queue. Never: OS notifications (main process), their look or persistent state.

import { signal } from '@preact/signals';
import type { EventMap } from '../../shared/api/events.ts';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  conversationId?: string;
  /** The to-do the attention item is about (Open goes to My day). */
  taskId?: string;
  tone?: 'info' | 'error';
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

/** A toast; `ttlMs` 0 keeps it until Open or Dismiss (0, never Infinity: so long a timer fires at once). */
export function pushToast(toast: Omit<Toast, 'id'>, ttlMs = 6000): void {
  const id = nextId++;
  toasts.value = [...toasts.value.slice(-2), { ...toast, id }];
  if (ttlMs > 0) setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Drops the toasts that `test` picks, e.g. those about a chat just opened (peek: an effect calling it does not follow the toasts). */
export function dismissToastsWhere(test: (toast: Toast) => boolean): void {
  const list = toasts.peek();
  const kept = list.filter((toast) => !test(toast));
  if (kept.length !== list.length) toasts.value = kept;
}

/** Kinds that ask something of the person: their toast stays until Open or Dismiss. */
const LASTING: ReadonlySet<EventMap['notify']['kind']> = new Set(['todo', 'blocker', 'important']);

/** A runtime notification as a toast: to-dos, blockers and important messages stay, replies and results expire. */
export function toastNotification(note: EventMap['notify']): void {
  const toast = { title: note.title, body: note.body, conversationId: note.conversationId, ...(note.taskId ? { taskId: note.taskId } : {}) };
  pushToast(toast, LASTING.has(note.kind) ? 0 : undefined);
}

/** Shows a short error toast for a failed action. */
export function toastError(error: unknown, title = 'Action failed'): void {
  const body = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  pushToast({ title, body, tone: 'error' });
}
