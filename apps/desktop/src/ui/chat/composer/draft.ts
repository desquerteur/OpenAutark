// Per-chat composer drafts: text + attachments + the message level (B-050 K4: normal, important or
// silent – in memory only, back to normal once sent), kept across navigation and
// persisted through ui.saveDraft (debounced 600 ms; flushed on chat switch/unload). A save that
// went down with the connection is written again (the draft as it is then) once rpc reconnects –
// an attached take the runtime's blob clean-up waits for must reach the drafts table. C6: the
// message a draft replies to (`replyTo`, set with setReply) is kept in memory only, too – through
// edits and an emptied field, until the reply is sent or cancelled; a failed send gives it back.
// B-054: a key starting with 'local:' (the quick composer's tasks/quick-post.ts QUICK_DRAFT_KEY) is no chat, so
// its draft is kept in memory only and never sent to ui.saveDraft.
// Owns: the draft map and persistence. Never: sends messages, or repeats a save the runtime refused.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { Attachment, MessageLevel } from '../../../shared/model/chat.ts';
import { RpcError, rpc } from '../../lib/rpc.ts';
import { drafts, secretDrafts, loaded } from '../../lib/store.ts';

export interface Draft {
  /** Vault references only, persisted with the draft and kept across chat navigation. */
  secrets?: string[];
  text: string;
  attachments: Attachment[];
  /** How loud the next message is (/important, /silent). */
  level: MessageLevel;
  /** C6: the id of the message this draft answers (sent as `replyTo`). */
  replyTo?: string;
  /** B-057 (owner 30.10.2026): Ultra suggested for the next message (composer/UltraCell.tsx) – in memory only, off once sent. */
  ultra?: boolean;
}

const map = new Map<string, Signal<Draft>>();
const beforeLoad = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lost = new Set<string>(); // chats whose last save went down with the connection
const SAVE_DELAY = 600;
const LOCAL_PREFIX = 'local:';

export function draftFor(conversationId: string): Signal<Draft> {
  const ready = loaded.value;
  let entry = map.get(conversationId);
  if (!entry) {
    entry = signal<Draft>({ text: drafts.value[conversationId] ?? '', attachments: [], level: 'normal', secrets: secretDrafts.value[conversationId] ?? [] });
    map.set(conversationId, entry);
    if (!ready) beforeLoad.add(conversationId);
  }
  // Desktop restart-readiness reads a draft before the initial snapshot has arrived.
  // Hydrate that early placeholder once; subsequent edits keep their in-memory state.
  if (ready && beforeLoad.delete(conversationId) && !timers.has(conversationId)) {
    entry.value = { ...entry.peek(), text: drafts.value[conversationId] ?? '', secrets: secretDrafts.value[conversationId] ?? [] };
  }
  return entry;
}

function persist(conversationId: string): void {
  timers.delete(conversationId);
  const draft = draftFor(conversationId).value;
  drafts.value = { ...drafts.value, [conversationId]: draft.text };
  if (!draft.text) { const next = { ...drafts.value }; delete next[conversationId]; drafts.value = next; }
  secretDrafts.value = { ...secretDrafts.value, [conversationId]: draft.secrets ?? [] };
  if (conversationId.startsWith(LOCAL_PREFIX)) return; // no chat: the drafts table would refuse it
  void rpc.call('ui.saveDraft', { conversationId, text: draft.text, attachments: draft.attachments, ...(draft.secrets?.length ? { secrets: draft.secrets } : {}) }).then(
    () => { lost.delete(conversationId); },
    (error) => { if (error instanceof RpcError && error.code === 'unavailable' && rpc.status.peek() !== 'open') lost.add(conversationId); },
  );
}

// A call made while offline waits in rpc's queue; one already sent is rejected when the connection drops.
rpc.onOpen(() => {
  for (const conversationId of [...lost]) {
    lost.delete(conversationId);
    if (!timers.has(conversationId)) persist(conversationId); // a pending change saves it anyway
  }
});

export function updateDraft(conversationId: string, patch: Partial<Draft>): void {
  const entry = draftFor(conversationId);
  beforeLoad.delete(conversationId);
  entry.value = { ...entry.value, ...patch };
  clearTimeout(timers.get(conversationId));
  timers.set(conversationId, setTimeout(() => persist(conversationId), SAVE_DELAY));
}

/** C6: the next message of this chat answers `messageId` (null: no reply). Nothing to save – it is not persisted. */
export function setReply(conversationId: string, messageId: string | null): void {
  const entry = draftFor(conversationId);
  const next = { ...entry.value };
  if (messageId) next.replyTo = messageId;
  else delete next.replyTo;
  entry.value = next;
}

/** Writes a pending draft immediately (chat switch, window unload, before restart). */
export function flushDraft(conversationId: string): void {
  if (!timers.has(conversationId)) return;
  clearTimeout(timers.get(conversationId));
  persist(conversationId);
}

export function flushAllDrafts(): void {
  for (const id of [...timers.keys()]) flushDraft(id);
}

export function clearDraft(conversationId: string): void {
  beforeLoad.delete(conversationId);
  draftFor(conversationId).value = { text: '', attachments: [], level: 'normal' };
  clearTimeout(timers.get(conversationId));
  persist(conversationId);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushAllDrafts);
