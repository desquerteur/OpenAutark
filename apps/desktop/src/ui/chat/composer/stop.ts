// AF-012 – the composer's Stop. While an agent works in the chat (its rows stream: ConversationSummary.live) and the draft
// is empty, the Send cell holds a Stop button (a square, data-tour="run-stop", composer/controls.ts); a click, or Esc in
// the chat, stops the chat's runs as the person (messages.stop: the runtime aborts the turns, refuses every later tool
// call, kills the trees of running commands, keeps each answer so far as 'stopped' and stops the chat's splits too).
// The button turns back into Send at once: a run the person asked to stop no longer counts as working here while its
// row ends; a new run shows Stop again. A failed call gives the Stop back with a notice.
// Owns: that call, the per-chat runs asked to stop, the Esc rule and the composer's hook for both (useChatStop).
// Never: decides what a Stop does in the runtime.

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { backLayerOpen } from '../../lib/back-layers.ts';
import { rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';

/** A chat's work without run ids (an older runtime names only `working`): stands for "every run now". */
const ALL = '*';

/** Per chat: the runs the person asked to stop (they no longer count as working while their rows end). */
export const stopping = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

/** The runs at work in a chat: its streaming rows' runs, else one stand-in while `working` names agents. */
export function runsAtWork(chat: Pick<ConversationSummary, 'live' | 'working'>): string[] {
  if (chat.live?.length) return chat.live.map((run) => run.runId);
  return chat.working?.length ? [ALL] : [];
}

/** Whether the chat has a run at work the person has not asked to stop yet (pure: `asked` = stopping's set). */
export function stoppable(atWork: readonly string[], asked: ReadonlySet<string> | undefined): boolean {
  return atWork.some((runId) => !asked?.has(runId));
}

function setAsked(conversationId: string, next: ReadonlySet<string> | undefined): void {
  const map = new Map(stopping.peek());
  if (next?.size) map.set(conversationId, next); else map.delete(conversationId);
  stopping.value = map;
}

/** Forgets the asked runs that ended (called whenever the chat's work changes). */
export function pruneStopping(conversationId: string, atWork: readonly string[]): void {
  const asked = stopping.peek().get(conversationId);
  if (!asked) return;
  const left = [...asked].filter((runId) => atWork.includes(runId));
  if (left.length !== asked.size) setAsked(conversationId, new Set(left));
}

/** The person's Stop of every run in the chat; false when the call failed (the Stop comes back, a notice says why). */
export async function stopChat(chat: Pick<ConversationSummary, 'id' | 'live' | 'working'>): Promise<boolean> {
  const runs = runsAtWork(chat);
  const before = stopping.peek().get(chat.id);
  setAsked(chat.id, new Set([...(before ?? []), ...runs]));
  try {
    await rpc.call('messages.stop', { conversationId: chat.id });
    return true;
  } catch (error) {
    setAsked(chat.id, before);
    toastError(error, 'Could not stop the agent');
    return false;
  }
}

/** Esc stops the chat's work – never when it was handled, with a modifier or while a menu, dialog or popover is open (Esc closes that first). */
export function escapeStops(event: KeyboardEvent, doc: Pick<Document, 'querySelector'> = document): boolean {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (backLayerOpen()) return false;
  return !doc.querySelector('dialog[open], [role="dialog"], [role="menu"], [aria-modal="true"], .popover');
}

/**
 * Whether an Esc outside a field belongs to the chat of `column` (its `.chat-column`): the focus is in it, or nowhere
 * (the page itself) and it is the main chat, not a thread beside it. A field handles its own Esc (the composer's below).
 */
export function escapeIsFor(target: EventTarget | null, column: Element | null, page: readonly unknown[] = [document.body, document.documentElement]): boolean {
  if (!column) return false;
  const node = target as (Node & { isContentEditable?: boolean; tagName?: string }) | null;
  if (node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? ''))) return false;
  if (node && column.contains(node)) return true;
  return (!node || page.includes(node)) && !column.classList.contains('thread-column');
}

/**
 * The composer's Stop: whether the chat has work the person can stop now (`enabled` false: never – schedule mode); while it
 * has, Esc in the chat's column outside a field stops it. `area`: the composer's element (its column is found from it).
 */
export function useChatStop(chat: Pick<ConversationSummary, 'id' | 'live' | 'working'>, area: { current: Element | null }, enabled: boolean): boolean {
  const atWork = runsAtWork(chat);
  const working = enabled && stoppable(atWork, stopping.value.get(chat.id));
  const latest = useRef(chat);
  latest.current = chat;
  useEffect(() => pruneStopping(chat.id, atWork), [chat.id, atWork.join()]);
  useEffect(() => {
    if (!working) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !escapeIsFor(event.target, area.current?.closest('.chat-column') ?? null) || !escapeStops(event)) return;
      event.preventDefault();
      void stopChat(latest.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, chat.id]);
  return working;
}
