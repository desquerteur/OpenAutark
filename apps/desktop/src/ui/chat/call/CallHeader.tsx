// A chat's voice mode in the chat header: one fixed 32×32 call cell (lib/header.tsx), rendered for every chat that
// may talk (else an inert placeholder of the same size). Tap while voice or realtime voice runs in this chat → it
// stops (phone-disconnect, danger tint). Otherwise it starts: with settings.voice.realtime 'auto' realtime voice first
// (the audio output is made inside the tap – prepareRealtimeOutput); when that cannot start, or ends by itself, the
// chat's voice conversation takes over (composer/voice.ts startVoice). With 'off' the voice conversation directly.
// Both are this device's one call in the chat (its bubble, runtime/calls/call-log.ts): the voice conversation joins the call
// a realtime session opened, and End ends it. Only its icon, label and tone change – nothing beside it moves.
// Owns: the cell's states and what a tap starts. Never: the voice loop (voice.ts) or realtime audio (realtime-call.ts).

import { useState } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import type { HeaderCell } from '../../lib/header.tsx';
import { voiceSessions } from '../../lib/shell-state.ts';
import { settings } from '../../lib/store.ts';
import { toastError } from '../../lib/toasts.ts';
import { conversationAvailable, startVoice, stopVoice } from '../composer/voice.ts';
import { discardRealtimeOutput, prepareRealtimeOutput, realtimeChat, startRealtime, stopRealtime } from './realtime-call.ts';

/** The call cell's id (`.frame-header [data-cell="call"]`). */
export const CALL_CELL = 'call';

/** This chat may talk on this connection (no system chats). */
export function callable(chat: ConversationSummary): boolean {
  return !chat.settings.system && conversationAvailable();
}

/** Voice or realtime voice runs in this chat on this device. */
export function talking(conversationId: string): boolean {
  return realtimeChat.value === conversationId || voiceSessions.value.some((chat) => chat.conversationId === conversationId);
}

/** Starts the chat's voice mode from the tap: realtime voice when it is on, else (or when it fails) the voice conversation. */
async function startCall(conversationId: string): Promise<void> {
  if (settings.peek()?.voice?.realtime !== 'auto') { await startVoice(conversationId); return; }
  const output = prepareRealtimeOutput(); // inside the tap: mobile browsers keep a later one suspended
  try {
    await startRealtime(conversationId, (reason) => {
      if (reason) toastError(new Error(reason), 'Realtime voice ended');
      void startVoice(conversationId); // the call goes on in the chat's voice conversation
    }, undefined, output);
  } catch {
    discardRealtimeOutput(output);
    await startVoice(conversationId); // no realtime model here (or it failed): the voice conversation
  }
}

/** Ends the chat's voice mode on this device. */
function endCall(conversationId: string): void {
  if (realtimeChat.peek() === conversationId) stopRealtime();
  void stopVoice(conversationId);
}

/** The header's call cell: Talk → End in the same box (busy while it starts). */
export function useCallCell(chat: ConversationSummary): HeaderCell {
  const [busy, setBusy] = useState(false);
  if (!callable(chat)) return { id: CALL_CELL, placeholder: true };
  if (talking(chat.id)) {
    return { id: CALL_CELL, icon: 'phone-disconnect', label: 'End voice', tone: 'danger', class: 'call-cell call-leave', onClick: () => endCall(chat.id) };
  }
  const start = () => {
    setBusy(true);
    void startCall(chat.id).catch((error: unknown) => toastError(error)).finally(() => setBusy(false));
  };
  return { id: CALL_CELL, icon: 'phone', label: 'Talk', busy, class: 'call-cell call-start', onClick: start };
}
