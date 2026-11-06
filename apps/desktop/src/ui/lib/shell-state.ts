// Transient shell state shared across areas: which side panel is open per chat (details, or B-078 a thread – which
// thread too) and whether its area (the tabs above
// its messages, chat/ChatArea.tsx) is open, overlays (palette, new chat, feedback), the live voice sessions and composer fills.
// Owns: UI-only signals and their small actions. Never: persisted data (that lives in the
// runtime: settings.preferences, drafts) – except the per-chat panel and area choices in localStorage.

import { computed, signal } from '@preact/signals';
import type { VoiceSessionEntry, VoiceSessionView } from '../../shared/voice/conversation.ts';
import { activeConversationId } from './store.ts';

export type ChatPanel = 'details' | 'thread';

/** A per-chat choice kept on this device (`valid` drops what an older version stored). */
function perChat<T>(key: string, valid: (value: unknown) => value is T) {
  let read: Record<string, T> = {};
  try { read = Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>).filter((entry): entry is [string, T] => valid(entry[1]))); } catch { /* storage may be blocked */ }
  const kept = signal(read);
  const set = (conversationId: string, value: T | null) => {
    if ((kept.peek()[conversationId] ?? null) === value) return;
    const next = { ...kept.peek() };
    if (value === null) delete next[conversationId]; else next[conversationId] = value;
    kept.value = next;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage may be blocked */ }
  };
  return { kept, set };
}

const panels = perChat('wf.chatPanels', (value): value is ChatPanel => value === 'details' || value === 'thread');
const threads = perChat('wf.chatThreads', (value): value is string => typeof value === 'string');
const areas = perChat('wf.chatAreas', (value): value is true => value === true);

/** Side panel of the open chat (remembered per chat on this device). */
export const chatPanel = computed<ChatPanel | null>(() => {
  const id = activeConversationId.value;
  return id ? panels.kept.value[id] ?? null : null;
});

export function setChatPanel(conversationId: string, panel: ChatPanel | null): void {
  panels.set(conversationId, panel);
}

export function toggleChatPanel(conversationId: string, panel: ChatPanel): void {
  setChatPanel(conversationId, panels.kept.peek()[conversationId] === panel ? null : panel);
}

/** B-078: the thread the open chat's side panel shows (remembered per chat on this device); null when none. */
export const chatThread = computed<string | null>(() => {
  const id = activeConversationId.value;
  return id ? threads.kept.value[id] ?? null : null;
});

/** Opens thread `threadId` of chat `conversationId` in its side panel – or closes it when that thread is open there already. */
export function toggleThread(conversationId: string, threadId: string, keepOpen = false): void {
  const open = !keepOpen && panels.kept.peek()[conversationId] === 'thread' && threads.kept.peek()[conversationId] === threadId;
  threads.set(conversationId, open ? null : threadId);
  setChatPanel(conversationId, open ? null : 'thread');
}

/** The open chat's area is open (remembered per chat on this device). */
export const chatAreaOpen = computed(() => {
  const id = activeConversationId.value;
  return id ? areas.kept.value[id] === true : false;
});

export function isChatAreaOpen(conversationId: string): boolean {
  return areas.kept.value[conversationId] === true;
}

export function setChatArea(conversationId: string, open: boolean): void {
  areas.set(conversationId, open ? true : null);
}

export function toggleChatArea(conversationId: string): void {
  setChatArea(conversationId, !areas.kept.peek()[conversationId]);
}

export const paletteOpen = signal(false);
export const newChatOpen = signal<{ agentIds?: string[] } | null>(null);
export const feedbackOpen = signal<{ view?: string; conversationId?: string } | null>(null);
export const usageOpen = signal(false);

/** One live voice conversation (SM11: up to three at once over one microphone, one listening). */
export interface VoiceChat {
  id: string;
  conversationId: string;
  /** What it does: starting, listening, transcribing, responding, speaking. */
  phase?: string;
  /** It hears the next utterance (the chat focused last, or the one named). */
  listening?: boolean;
  /** Its replies waiting to be read aloud. */
  queued?: number;
}

/** Every live voice conversation, the listening one first; they survive navigation. */
export const voiceSessions = signal<readonly VoiceChat[]>([]);

/** The page conversation's state (the microphone and every chat) as the shell shows it; [] when none runs. */
export function voiceChats(mic: VoiceSessionView | null, sessions?: readonly VoiceSessionEntry[]): VoiceChat[] {
  if (!mic) return [];
  const list: readonly VoiceSessionEntry[] = sessions?.length ? sessions : [{ ...mic, listening: true }];
  return list.map((entry) => {
    const chat: VoiceChat = { id: entry.id, conversationId: entry.conversationId, phase: entry.status, listening: entry.listening };
    if (entry.queued) chat.queued = entry.queued;
    return chat;
  });
}

/** The pill's words for a conversation's state (`several`: more than one runs). */
export function voicePhase(chat: VoiceChat, several: boolean): string | undefined {
  if (chat.queued) return 'reply waiting';
  return several && !chat.listening && chat.phase === 'listening' ? 'on hold' : chat.phase;
}

/** The open chat's live conversation, else the listening one; null when none runs (composer, update gate). */
export const voiceSession = computed<VoiceChat | null>(() => {
  const list = voiceSessions.value;
  const open = activeConversationId.value;
  return list.find((chat) => chat.conversationId === open) ?? list[0] ?? null;
});

/**
 * One-shot composer fills: the composer of `conversationId` consumes and clears it. Used by
 * "/task " from the palette's New task in this chat and the task panel's Task. A fill never
 * overwrites the person's draft: it goes only into an empty composer (composerFillText); otherwise
 * the composer takes the focus and says COMPOSER_BUSY.
 */
export const composerFill = signal<{ conversationId: string; text: string } | null>(null);

/** Said when a fill finds a draft (the draft stays as it is). */
export const COMPOSER_BUSY = 'Finish or clear your message first';

/** The composer's text after a fill, or null when the draft holds something else (left untouched). */
export function composerFillText(current: string, fill: string): string | null {
  return !current.trim() || current === fill ? fill : null;
}

/** Request to focus a message (search hit / task jump). */
export const focusMessage = signal<{ conversationId: string; messageId: string } | null>(null);
