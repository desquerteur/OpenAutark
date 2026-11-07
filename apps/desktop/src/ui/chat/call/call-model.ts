// AF-015: what the call view shows, as plain data (CallOverlay.tsx draws it, call-session.ts feeds it). A call on this
// device runs on one of three engines – the chat's voice conversation (shared/voice/conversation.ts), realtime voice
// (realtime-call.ts) or, for tests and demos only, the mock engine (call-mock.ts) – and every engine's state becomes one
// of four phases the person reads at a glance: connecting, listening, speaking, working. Who speaks right now comes
// from real levels (call-levels.ts): the agent's playback and the person's microphone, the louder one above a floor.
// Owns: the phases, their words, who speaks, the call's clock text and the view's small rules. Never: audio, timers,
// the DOM or the runtime.

import { callLength } from '../../../shared/model/call.ts';
import type { VoiceSessionView } from '../../../shared/voice/conversation.ts';

/** Which engine carries this device's call. */
export type CallEngineKind = 'voice' | 'realtime' | 'mock';

/** What the call does right now (the status under the name). */
export type CallPhase = 'connecting' | 'listening' | 'speaking' | 'working';

/** The call view's size: the whole window, or a small floating window. */
export type CallViewMode = 'full' | 'mini';

/** Who is heard right now (the ring and the wave). */
export type CallSpeaker = 'agent' | 'person' | null;

/** The words of the call view (the UI has no translation system yet: one place to translate them later). */
export const CALL_TEXT = {
  phase: { connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', working: 'Working…' } satisfies Record<CallPhase, string>,
  mute: 'Mute', unmute: 'Unmute', muted: 'Microphone off',
  output: 'Audio output', outputDefault: 'System default', outputOnlyDefault: 'This device chooses its output',
  captionsOn: 'Live captions', captionsOff: 'Captions off',
  hangUp: 'Hang up', minimize: 'Minimize call', expand: 'Open call',
  you: 'You', call: 'Call', callWith: (name: string) => `Call with ${name}`,
  nothingYet: 'Captions show here when someone speaks.',
} as const;

/** The voice conversation's state of the call's chat → its phase (transcribing and waiting for the reply: working). */
export function voicePhase(status: VoiceSessionView['status'] | string | undefined): CallPhase {
  switch (status) {
    case 'listening': return 'listening';
    case 'speaking': return 'speaking';
    case 'transcribing': case 'responding': return 'working';
    default: return 'connecting';
  }
}

/** A realtime session's state → its phase: not open yet, the model's answer playing, an agent's handed-over turn, else listening. */
export function realtimePhase(state: { opened: boolean; answering: boolean; handedOver?: boolean }): CallPhase {
  if (!state.opened) return 'connecting';
  if (state.answering) return 'speaking';
  return state.handedOver ? 'working' : 'listening';
}

/** A level (0..1) counts as someone talking above this. */
export const SPEAKING_FLOOR = 0.18;

/**
 * Who is heard: the agent while its audio plays above the floor (or its phase is speaking and the output gives no
 * level – a system voice), else the person while their microphone is above the floor and not muted, else nobody.
 */
export function speakerOf(levels: { mic: number; out: number }, phase: CallPhase, muted: boolean): CallSpeaker {
  if (phase === 'connecting') return null;
  if (levels.out >= SPEAKING_FLOOR) return 'agent';
  if (!muted && levels.mic >= SPEAKING_FLOOR && phase !== 'speaking') return 'person';
  return phase === 'speaking' ? 'agent' : null;
}

/** The ring's scale around the avatar for a level: 1 at rest, up to 1.18 at full level (reduced motion: always 1). */
export function ringScale(level: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  const clamped = Math.max(0, Math.min(1, level));
  return Math.round((1 + clamped * 0.18) * 1000) / 1000;
}

/** "0:00" from the moment the call connected; "" while it still connects. */
export function callClock(connectedAt: number | undefined, now: number): string {
  return connectedAt === undefined ? '' : callLength(now - connectedAt);
}

/** The status line under the name: "Listening · 1:23" (connecting: no clock yet). */
export function statusLine(phase: CallPhase, clock: string): string {
  const words = CALL_TEXT.phase[phase];
  return clock ? `${words} · ${clock}` : words;
}

/** Esc in the full view and the minimize button: full → mini; the expand button and a tap on the mini window: mini → full. */
export function toggledView(view: CallViewMode): CallViewMode {
  return view === 'full' ? 'mini' : 'full';
}

/** The mini window's place inside the window (kept on screen with a margin), from a stored or dragged position. */
export function clampMini(at: { x: number; y: number }, box: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - box.width - margin);
  const maxY = Math.max(margin, viewport.height - box.height - margin);
  return { x: Math.round(Math.min(maxX, Math.max(margin, at.x))), y: Math.round(Math.min(maxY, Math.max(margin, at.y))) };
}

/** The call ended by itself once its engine was gone this long (a realtime session handing over to the voice loop has a gap). */
export const ENGINE_GONE_MS = 1500;

/** Whether the view closes now: the engine has been gone since `goneSince` for ENGINE_GONE_MS (never while it connects for the first time within that time). */
export function engineGone(running: boolean, goneSince: number | null, now: number): { goneSince: number | null; ended: boolean } {
  if (running) return { goneSince: null, ended: false };
  const since = goneSince ?? now;
  return { goneSince: since, ended: now - since >= ENGINE_GONE_MS };
}

/** One live caption: the newest line said in the call. */
export interface CallCaption { who: 'agent' | 'person'; name: string; text: string; at: number }

/** Longest caption shown (its end: the newest words). */
export const CAPTION_MAX = 160;

type CaptionMessage = { conversationId: string; authorKind: string; kind: string; body: string; state: string; createdAt: number; silent?: boolean; meta: { call?: { id?: string } } };

/**
 * The caption a chat row gives while the call runs: a line of the call (meta.call names it), or a final answer of an
 * agent in the call's chat after the call started; the person's own lines say "You". Rows before the call, status rows,
 * streaming or empty rows give none.
 */
export function captionOf(message: CaptionMessage, call: { conversationId: string; since: number; callId?: string }, nameOf: (message: CaptionMessage) => string): CallCaption | null {
  if (message.conversationId !== call.conversationId || message.createdAt < call.since || message.kind === 'status') return null;
  if (message.state !== 'final' || !message.body.trim()) return null;
  const inCall = call.callId !== undefined && message.meta.call?.id === call.callId;
  const who = message.authorKind === 'agent' ? 'agent' : message.authorKind === 'human' ? 'person' : null;
  if (!who || (who === 'person' && !inCall && message.meta.call === undefined) || (message.silent && !inCall)) return null;
  const text = message.body.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[`*_#>|~]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { who, name: who === 'person' ? CALL_TEXT.you : nameOf(message), text: text.length > CAPTION_MAX ? `…${text.slice(-CAPTION_MAX)}` : text, at: message.createdAt };
}

/** The small line under the call about agents still working: "Mira: writing the plan" here, "+2 in other chats". */
export function backgroundLine(here: string, elsewhere: number): string {
  const others = elsewhere > 0 ? `${elsewhere} ${elsewhere === 1 ? 'agent' : 'agents'} working in other chats` : '';
  return [here, others].filter(Boolean).join(' · ');
}
