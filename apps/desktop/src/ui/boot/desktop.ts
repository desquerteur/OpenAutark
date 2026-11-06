// Desktop-only glue between the window and Electron main (window.workforce, see
// shared/api/desktop.ts): update state, notification-click navigation, the pre-restart draft
// flush and the "safe to restart" signal (sent on change only; not while someone dictates or talks).
// Owns: those bridge listeners. Never: talks to main for anything that is runtime state (that
// is RPC), never adds bridge members beyond WorkforceDesktopApi.

import { effect, signal } from '@preact/signals';
import type { NavigateRequest } from '../../shared/api/desktop.ts';
import { bridge, platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { navigate, route } from '../lib/router.ts';
import { feedbackOpen, focusMessage, newChatOpen, paletteOpen, voiceSession } from '../lib/shell-state.ts';
import { activeConversationId, tasks, todos, updateState } from '../lib/store.ts';
import { draftFor, flushAllDrafts } from '../chat/composer/draft.ts';
import { dictating } from '../chat/composer/voice.ts';
import { realtimeChat } from '../chat/call/realtime-call.ts';
import { changeNotifier, isRestartReady } from './readiness.ts';

/** True while any modal <dialog> is open (kept by an attribute observer, no polling). */
const dialogOpen = signal(false);

function watchDialogs(): void {
  const check = () => { dialogOpen.value = document.querySelector('dialog[open]') !== null; };
  new MutationObserver(check).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  // A dialog that unmounts while open removes no attribute: re-check after view changes.
  effect(() => { void route.value; queueMicrotask(check); });
  check();
}

/** Opens the chat (and the task's message) a notification click points at. */
export async function openTarget(request: NavigateRequest): Promise<void> {
  let conversationId = request.conversationId;
  let messageId: string | undefined;
  if (request.taskId) {
    const known = tasks.value.find((task) => task.id === request.taskId) ?? todos.value.find((task) => task.id === request.taskId);
    const task = known ?? await rpc.call('tasks.get', { id: request.taskId }).catch(() => undefined);
    if (task) {
      conversationId ??= task.conversationId;
      messageId = task.messageId;
    }
  }
  if (!conversationId) return;
  navigate({ view: 'chat', id: conversationId });
  if (messageId) focusMessage.value = { conversationId, messageId };
}

/**
 * Saves every pending draft and waits until the open chat's draft reached the runtime.
 * Rejects when that draft could not be saved (no connection, runtime error): the preload then
 * acks `ok: false` and main keeps the window instead of restarting over unsaved input.
 */
export async function saveDraftsNow(): Promise<void> {
  flushAllDrafts();
  const id = activeConversationId.value;
  if (!id) return;
  const draft = draftFor(id).value;
  if (!draft.text && !draft.attachments.length) return;
  // A queued call would only resolve after a reconnect; fail fast instead of hitting main's timeout.
  if (rpc.status.value !== 'open') throw new Error('The runtime is not connected; the draft is not saved.');
  await rpc.call('ui.saveDraft', { conversationId: id, text: draft.text, attachments: draft.attachments });
}

function watchRestartReadiness(setReady: (ready: boolean) => void): void {
  watchDialogs();
  const notify = changeNotifier(setReady);
  effect(() => {
    const id = activeConversationId.value;
    const draft = id ? draftFor(id).value : undefined;
    notify(isRestartReady({
      view: route.value.view,
      overlayOpen: dialogOpen.value || paletteOpen.value || !!newChatOpen.value || !!feedbackOpen.value,
      composerDirty: !!draft && (draft.text.trim().length > 0 || draft.attachments.length > 0),
      listening: dictating.value !== null || voiceSession.value !== null || realtimeChat.value !== null,
    }));
  });
}

/** Wires the desktop bridge listeners. No-op in the PWA. */
export function startDesktopBridge(): void {
  if (platform !== 'desktop' || !bridge) return;
  const { updates } = bridge;
  void updates.state().then((state) => { updateState.value = state; }).catch(() => undefined);
  bridge.onUpdate((state) => { updateState.value = state; });
  bridge.onNavigate((request: NavigateRequest) => { void openTarget(request); });
  bridge.onPrepareRestart(saveDraftsNow);
  watchRestartReadiness((ready) => { try { updates.setReady(ready); } catch { /* main gone */ } });
}
