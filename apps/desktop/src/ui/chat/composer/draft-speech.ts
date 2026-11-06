// Which chats' drafts were dictated (composer/voice.ts marks them): sent along as messages.send `speech`
// (spokenMeta(false) – the message shows the microphone mark) and given back with the draft when the send fails.
// Owns: the per-chat "dictated" mark. Never: dictation itself (composer/voice.ts) or the draft text (draft.ts).

import { signal } from '@preact/signals';
import type { SpeechMeta } from '../../../shared/model/chat.ts';
import { spokenMeta } from '../../../shared/voice/conversation.ts';

/** The chats whose draft holds dictated text (until it is sent or emptied). */
export const dictatedDrafts = signal<ReadonlySet<string>>(new Set());

function setDictated(conversationId: string, on: boolean): void {
  if (dictatedDrafts.value.has(conversationId) === on) return;
  const next = new Set(dictatedDrafts.value);
  if (on) next.add(conversationId); else next.delete(conversationId);
  dictatedDrafts.value = next;
}

/** A take's text went into this chat's draft. */
export function markDictated(conversationId: string): void {
  setDictated(conversationId, true);
}

export function clearDraftSpeech(conversationId: string): void {
  setDictated(conversationId, false);
}

/** Sending the draft: its `speech` (undefined when nothing was dictated) leaves the draft now; `restore()` brings it back when the send failed. */
export function takeDraftSpeech(conversationId: string): { speech: SpeechMeta | undefined; restore(): void } {
  const dictated = dictatedDrafts.value.has(conversationId);
  clearDraftSpeech(conversationId);
  return { speech: dictated ? spokenMeta(false) : undefined, restore: () => { if (dictated) markDictated(conversationId); } };
}
